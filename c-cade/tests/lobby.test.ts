import { describe, expect, it } from 'vitest';
import { Lobby, type ConnHandle } from '../src/net/lobby.js';
import type { ByeCode, ServerMessage } from '../src/net/protocol.js';
import { consoleCommand } from '../src/mp/headless.js';
import type { LanServer } from '../src/net/server.js';
import { parseArgs } from '../src/cli/args.js';
import { resolveMpGameId } from '../src/mp/registry.js';

class FakeConn implements ConnHandle {
  msgs: ServerMessage[] = [];
  closed: { code: ByeCode; reason: string } | null = null;
  constructor(readonly remote = '192.168.1.50') {}
  send(m: ServerMessage) { this.msgs.push(m); }
  close(code: ByeCode, reason: string) { this.closed = { code, reason }; }
  last<T extends ServerMessage['type']>(type: T) {
    return [...this.msgs].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

function setup(opts: Partial<ConstructorParameters<typeof Lobby>[0]> = {}) {
  let now = 1_000_000;
  const lobby = new Lobby({ address: '127.0.0.1', port: 7777, hostKey: 'k'.repeat(32), introMs: 0, seed: 'lobby', now: () => now, ...opts });
  const join = (name: string, extra: { hostKey?: string; spectate?: boolean; remote?: string } = {}) => {
    const conn = new FakeConn(extra.remote);
    const id = lobby.hello(conn, { type: 'hello', name, ...(extra.hostKey ? { hostKey: extra.hostKey } : {}), ...(extra.spectate ? { spectate: true } : {}) });
    return { conn, id: id! };
  };
  return { lobby, join, advance: (ms: number) => { now += ms; lobby.tick(); } };
}

describe('Lobby', () => {
  it('only the host key holder can configure the room', () => {
    const { lobby, join } = setup();
    const host = join('Host', { hostKey: 'k'.repeat(32) });
    const p = join('P');
    lobby.handle(p.id, { type: 'host', seq: 1, command: { cmd: 'select-game', gameId: 'prompt-panic' } });
    expect(p.conn.last('ack')).toMatchObject({ ok: false, code: 'NOT_HOST' });
    lobby.handle(host.id, { type: 'host', seq: 1, command: { cmd: 'select-game', gameId: 'prompt-panic' } });
    expect(lobby.state().gameId).toBe('prompt-panic');
    lobby.handle(host.id, { type: 'host', seq: 2, command: { cmd: 'set-option', key: 'rounds', value: 8 } });
    expect(lobby.state().options.rounds).toBe(8);
    lobby.handle(host.id, { type: 'host', seq: 3, command: { cmd: 'set-option', key: 'rounds', value: 999 } });
    expect(host.conn.last('ack')).toMatchObject({ ok: false, code: 'INVALID' });
    lobby.handle(host.id, { type: 'host', seq: 4, command: { cmd: 'set-max', max: 1 } });
    expect(host.conn.last('ack')).toMatchObject({ ok: false });
    lobby.handle(host.id, { type: 'host', seq: 5, command: { cmd: 'set-max', max: 3 } });
    expect(lobby.state().maxPlayers).toBe(3);
  });

  it('needs enough players and asks before starting with unready players', () => {
    const { lobby, join } = setup({ gameId: 'prompt-panic' });
    join('A');
    expect(lobby.hostCommand({ cmd: 'start' })).toMatchObject({ ok: false, code: 'NOT_ENOUGH_PLAYERS' });
    join('B');
    expect(lobby.hostCommand({ cmd: 'start' })).toMatchObject({ ok: false, code: 'NOT_READY', message: /A, B are not ready/ });
    expect(lobby.hostCommand({ cmd: 'start', force: true })).toEqual({ ok: true });
    expect(lobby.currentPhase).toBe('match');
  });

  it('extra players spectate a 2-player game; spectators get public views', () => {
    const { lobby, join } = setup({ gameId: 'battleship' });
    const a = join('A');
    join('B');
    const c = join('C');
    lobby.hostCommand({ cmd: 'start', force: true });
    expect(lobby.state().notice).toMatch(/C will spectate/);
    expect(lobby.state().members.find((m) => m.name === 'C')!.playing).toBe(false);
    const view = c.conn.last('view')!.view as { you: unknown; mine: unknown };
    expect(view).toMatchObject({ you: null, mine: null });
    lobby.handle(c.id, { type: 'action', seq: 1, matchId: lobby.matchId!, action: { kind: 'fire', x: 0, y: 0 } });
    expect(c.conn.last('ack')).toMatchObject({ ok: false, code: 'NOT_PLAYING' });
    lobby.handle(a.id, { type: 'action', seq: 1, matchId: lobby.matchId!, action: { kind: 'fire', x: 0, y: 0 } });
    expect(a.conn.last('ack')).toMatchObject({ ok: false, code: 'PHASE' });
  });

  it('spectators may only send the actions a game allows (canvas re-sync)', () => {
    const { lobby, join } = setup({ gameId: 'doodle-protocol' });
    join('A');
    join('B');
    lobby.hostCommand({ cmd: 'start', force: true });
    const late = join('Late');
    lobby.handle(late.id, { type: 'action', seq: 1, matchId: lobby.matchId!, action: { kind: 'sync' } });
    expect(late.conn.last('ack')).toMatchObject({ ok: true });
    expect(late.conn.last('event')!.data).toMatchObject({ kind: 'canvas' });
    lobby.handle(late.id, { type: 'action', seq: 2, matchId: lobby.matchId!, action: { kind: 'guess', text: 'cat' } });
    expect(late.conn.last('ack')).toMatchObject({ ok: false, code: 'NOT_PLAYING' });
  });

  it('party mode picks a random game everyone can play, without repeats', () => {
    const { lobby, join } = setup({ party: true });
    for (const n of ['A', 'B', 'C']) join(n);
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      expect(lobby.hostCommand({ cmd: i === 0 ? 'start' : 'next', force: true })).toEqual({ ok: true });
      picked.push(lobby.state().activeGameId!);
      lobby.hostCommand({ cmd: 'end' });
    }
    // With 3 players Battleship (2 max) is never chosen; consecutive games differ.
    expect(picked.every((g) => g === 'prompt-panic' || g === 'doodle-protocol' || g === 'racing')).toBe(true);
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
  });

  it('party scores accumulate across completed matches', () => {
    const { lobby, join } = setup({ gameId: 'battleship' });
    const a = join('A');
    join('B');
    lobby.hostCommand({ cmd: 'start', force: true });
    lobby.handle(a.id, { type: 'leave' });
    expect(lobby.state().phase).toBe('results');
    const ps = lobby.state().partyScores;
    expect(ps[0]).toMatchObject({ name: 'B', points: 3, wins: 1 });
  });

  it('auto-starts when enough players are ready (dedicated hosts)', () => {
    const { lobby, join } = setup({ gameId: 'battleship', autoStart: 2 });
    const a = join('A');
    const b = join('B');
    lobby.handle(a.id, { type: 'ready', ready: true });
    expect(lobby.currentPhase).toBe('lobby');
    lobby.handle(b.id, { type: 'ready', ready: true });
    expect(lobby.currentPhase).toBe('match');
  });

  it('spectators cannot take a seat in a full lobby', () => {
    const { lobby, join } = setup({ maxPlayers: 2 });
    join('A');
    join('B');
    const s = join('S', { spectate: true });
    lobby.handle(s.id, { type: 'spectate', spectate: false });
    expect(s.conn.last('error')).toMatchObject({ code: 'FULL' });
  });

  it('kick bans the address for a while (but never loopback)', () => {
    const { lobby, join, advance } = setup();
    const p = join('P', { remote: '192.168.1.77' });
    lobby.hostCommand({ cmd: 'kick', playerId: p.id });
    expect(p.conn.closed).toMatchObject({ code: 'kicked' });
    expect(lobby.isBanned('192.168.1.77')).toBe(true);
    advance(5 * 60_000 + 1);
    expect(lobby.isBanned('192.168.1.77')).toBe(false);
    const local = join('L', { remote: '127.0.0.1' });
    lobby.hostCommand({ cmd: 'kick', playerId: local.id });
    expect(lobby.isBanned('127.0.0.1')).toBe(false);
  });

  it('closing the lobby says goodbye to everyone', () => {
    const { lobby, join } = setup();
    const a = join('A');
    lobby.close('bye now');
    expect(a.conn.closed).toEqual({ code: 'closed', reason: 'bye now' });
    expect(lobby.memberCount).toBe(0);
  });
});

describe('dedicated host console', () => {
  it('runs host commands by name', () => {
    const { lobby, join } = setup();
    join('Alice');
    const server = { lobby, close: async () => {} } as unknown as LanServer;
    expect(consoleCommand(server, 'help')).toMatch(/Commands/);
    expect(consoleCommand(server, 'game prompt')).toBe('ok');
    expect(consoleCommand(server, 'set rounds 3')).toBe('ok');
    expect(consoleCommand(server, 'set rounds 4')).toMatch(/error/);
    expect(consoleCommand(server, 'status')).toMatch(/prompt-panic · lobby · 1 connected: Alice/);
    expect(consoleCommand(server, 'kick nobody')).toMatch(/no player named/);
    expect(consoleCommand(server, 'kick alice')).toBe('ok');
    expect(consoleCommand(server, 'dance')).toMatch(/unknown command/);
  });
});

describe('LAN CLI parsing', () => {
  it('parses host and join commands', () => {
    expect(parseArgs(['host', '--game', 'battleship', '--port', '7800', '--max-players', '4', '--set', 'turnTime=30', '--name', 'Ada'])).toMatchObject({
      command: 'host', game: 'battleship', port: 7800, maxPlayers: 4, sets: { turnTime: '30' }, name: 'Ada',
    });
    expect(parseArgs(['host', '--party', '--local', '--dedicated'])).toMatchObject({ command: 'host', party: true, bind: 'local', dedicated: true });
    expect(parseArgs(['join', '192.168.1.42', '--port', '7777'])).toMatchObject({ command: 'join', rest: ['192.168.1.42'], port: 7777 });
    expect(parseArgs(['rooms', '--json'])).toMatchObject({ command: 'rooms', json: true });
    expect(parseArgs(['join', 'x', '--port', '70000']).error).toMatch(/Invalid port/);
    expect(parseArgs(['host', '--max-players', '20']).error).toMatch(/Invalid player limit/);
    expect(parseArgs(['host', '--set', 'oops']).error).toMatch(/key=value/);
  });

  it('resolves game aliases', () => {
    expect(resolveMpGameId('Battleship')).toBe('battleship');
    expect(resolveMpGameId('prompt')).toBe('prompt-panic');
    expect(resolveMpGameId('doodle')).toBe('doodle-protocol');
    expect(resolveMpGameId('party')).toBe('random');
    expect(resolveMpGameId('chess')).toBeUndefined();
  });
});
