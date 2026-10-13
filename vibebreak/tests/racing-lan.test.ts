import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import { resolveOptions, type MpMatch } from '../src/mp/types.js';
import { findMpGame, resolveMpGameId } from '../src/mp/registry.js';
import { FLAG, MAX_BATCH, parseInput, raceMpDef, type RaceNetView } from '../src/games/racing/mp.js';
import { Track } from '../src/games/racing/track.js';
import { netDriver } from '../src/games/racing/ai.js';
import { RacingUi } from '../src/ui/lan/racing-ui.js';
import { createGameUi } from '../src/ui/lan/game-uis.js';
import { Lobby, type ConnHandle } from '../src/net/lobby.js';
import type { ByeCode, ServerMessage } from '../src/net/protocol.js';
import { stripAnsi } from '../src/ui/style.js';
import './helpers.js';

const PLAYERS = [{ id: 'pa', name: 'Ada' }, { id: 'pb', name: 'Bob' }];

function match(options: Record<string, unknown> = {}, players = PLAYERS): { m: MpMatch; now: { t: number } } {
  const now = { t: 10_000 };
  const m = raceMpDef.create({
    players, rng: new Rng('lan-race'), options: resolveOptions(raceMpDef, { laps: 1, ...options }), now: now.t, memory: new Map(),
  });
  return { m, now };
}

const view = (m: MpMatch, id: string | null) => m.viewFor(id) as RaceNetView;

/** A client that only sees views and only sends input batches, like a real one. */
function clientDrive(m: MpMatch, id: string): void {
  const v = view(m, id);
  if (v.phase !== 'racing') return;
  const t = new Track({ seed: v.seed, kind: 'circuit', preset: v.preset, conditions: v.conditions });
  const mine = v.cars.find((c) => c[0] === id)!;
  if (mine[7] >= 0) return;
  const pos = (c: RaceNetView['cars'][number]) => ({ off: c[1] / 100, d: c[2] / 100, v: c[3] / 10 });
  const p = netDriver(t, pos(mine), v.cars.filter((c) => c[0] !== id).map(pos));
  if (p) expect(m.handleAction(id, { kind: 'in', p }, 0)).toEqual({ ok: true });
}

function runRace(m: MpMatch, now: { t: number }, drivers: string[], until = 300_000) {
  while (!m.isOver() && now.t < until) {
    now.t += 33;
    m.tick(now.t);
    for (const d of drivers) clientDrive(m, d);
  }
}

describe('LAN racing: registration', () => {
  it('is a LAN game with sane options, aliases and a client UI', () => {
    expect(findMpGame('racing')).toBe(raceMpDef);
    expect(resolveMpGameId('race')).toBe('racing');
    expect(raceMpDef).toMatchObject({ minPlayers: 2, maxPlayers: 8, tickMs: 33 });
    expect(resolveOptions(raceMpDef, {})).toEqual({ laps: 3, ai: 0, difficulty: 'normal', conditions: 'random', finishWindow: 30 });
    expect(createGameUi('racing', { you: () => null, send: () => {}, serverNow: () => 0, isHost: () => false, anim: () => 0 })).toBeInstanceOf(RacingUi);
  });
});

describe('LAN racing: input validation', () => {
  it('accepts only small batches of the five known inputs', () => {
    expect(parseInput({ kind: 'in', p: 'llg' })).toEqual(['left', 'left', 'gas']);
    expect(parseInput({ kind: 'in', p: 'rbd' })).toEqual(['right', 'brake', 'drift']);
    for (const bad of [null, 'llg', [], { kind: 'in' }, { kind: 'in', p: '' }, { kind: 'in', p: 'x' }, { kind: 'in', p: 7 },
      { kind: 'in', p: 'l'.repeat(MAX_BATCH + 1) }, { kind: 'teleport', p: 'l' }, { kind: 'in', p: 'l\u0000' }]) {
      expect(parseInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects bad input and non-racers; clients can never set speed, laps or position', () => {
    const { m, now } = match();
    expect(m.handleAction('spectator', { kind: 'in', p: 'g' }, now.t)).toMatchObject({ ok: false, code: 'NOT_RACING' });
    expect(m.handleAction('pa', { kind: 'in', p: 'zz' }, now.t)).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    // Anything that isn't an input batch is refused, whatever it claims.
    for (const claim of [{ kind: 'lap', lap: 99 }, { kind: 'finish' }, { kind: 'in', p: 'g', d: 99999, v: 999, lap: 5 }]) {
      const res = m.handleAction('pa', claim, now.t);
      if (res.ok) {
        // Extra fields on a valid batch are ignored: the car is where the server says.
        expect(view(m, 'pa').cars.find((c) => c[0] === 'pa')![2]).toBeLessThan(0);
      } else expect(res.code).toBe('BAD_INPUT');
    }
  });
});

describe('LAN racing: server authority and sync', () => {
  it('two clients race on views alone; the server decides laps, order and results', () => {
    const { m, now } = match({ laps: 2 });
    const v0 = view(m, 'pa');
    expect(v0).toMatchObject({ phase: 'countdown', laps: 2, you: 'pa' });
    expect(view(m, null).you).toBeNull();
    expect(v0.t).toBeLessThan(0);
    runRace(m, now, ['pa', 'pb']);
    expect(m.isOver()).toBe(true);
    const out = m.outcome()!;
    const final = view(m, 'pa');
    expect(final.phase).toBe('done');
    // Standings come from the server's order and finish times.
    expect(out.standings.map((s) => s.playerId)).toEqual(final.order.filter((id) => id === 'pa' || id === 'pb'));
    const leader = final.cars.find((c) => c[0] === final.order[0])!;
    expect(leader[7]).toBeGreaterThan(0);
    expect(leader[6]).toBe(2);
    expect(out.headline).toMatch(/wins in \d:\d\d\.\d\d/);
    expect(out.standings[0]).toMatchObject({ rank: 1, score: 10 });
    expect(out.stats![out.standings[0].playerId]).toMatchObject({ races: 1, wins: 1 });
  });

  it('every client rebuilds exactly the server\'s track from the view', () => {
    const { m } = match({ conditions: 'snow', difficulty: 'hard' });
    const v = view(m, 'pa');
    const server = (m as unknown as { sim: { track: Track } }).sim.track;
    const client = new Track({ seed: v.seed, kind: 'circuit', preset: v.preset, conditions: v.conditions });
    expect(v.conditions).toBe('snow');
    for (const d of [0, 13, 99, 250, 777]) {
      expect(client.center(d)).toBe(server.center(d));
      expect(client.half(d)).toBe(server.half(d));
    }
    expect(JSON.stringify(client.hazards)).toBe(JSON.stringify(server.hazards));
  });

  it('views are compact snapshots, and identical for everyone except "you"', () => {
    const { m, now } = match();
    now.t += 5000;
    m.tick(now.t);
    const a = view(m, 'pa');
    const b = view(m, 'pb');
    expect({ ...a, you: null }).toEqual({ ...b, you: null });
    expect(JSON.stringify(a).length).toBeLessThan(900);
    for (const c of a.cars) expect(c).toHaveLength(9);
  });

  it('AI rivals can fill the grid, run by the server', () => {
    const { m, now } = match({ ai: 2 });
    const v = view(m, 'pa');
    expect(v.roster.filter((r) => r.ai)).toHaveLength(2);
    runRace(m, now, ['pa', 'pb']);
    expect(m.isOver()).toBe(true);
    // Only people get LAN standings; AI places still count for points.
    expect(m.outcome()!.standings.map((s) => s.playerId).sort()).toEqual(['pa', 'pb']);
  });
});

describe('LAN racing: disconnects', () => {
  it('a dropped racer is ghosted on autopilot, gets the car back on reconnect, and nobody wins by default', () => {
    const { m, now } = match({ laps: 2 });
    for (let i = 0; i < 300; i++) {
      now.t += 33;
      m.tick(now.t);
      clientDrive(m, 'pa');
      clientDrive(m, 'pb');
    }
    m.setPresence('pb', 'disconnected', now.t);
    const flags = () => view(m, 'pa').cars.find((c) => c[0] === 'pb')![5];
    expect(flags() & FLAG.ghost).toBeTruthy();
    const dBefore = view(m, 'pa').cars.find((c) => c[0] === 'pb')![2];
    for (let i = 0; i < 150; i++) {
      now.t += 33;
      m.tick(now.t);
      clientDrive(m, 'pa');
    }
    // Still in the race, still moving (gently), and the race is not over.
    expect(m.isOver()).toBe(false);
    expect(view(m, 'pa').cars.find((c) => c[0] === 'pb')![2]).toBeGreaterThan(dBefore);
    m.setPresence('pb', 'connected', now.t);
    expect(flags() & FLAG.ghost).toBeFalsy();
  });

  it('a racer who never comes back retires (DNF, no points) and the race still completes', () => {
    const { m, now } = match();
    m.setPresence('pb', 'disconnected', now.t);
    m.setPresence('pb', 'gone', now.t);
    runRace(m, now, ['pa']);
    expect(m.isOver()).toBe(true);
    const out = m.outcome()!;
    expect(out.standings.map((s) => [s.playerId, s.score])).toEqual([['pa', 10], ['pb', 0]]);
    expect(view(m, 'pa').cars.find((c) => c[0] === 'pb')![5] & FLAG.retired).toBeTruthy();
  });

  it('the host ending the race early gives an incomplete outcome', () => {
    const { m, now } = match();
    now.t += 6000;
    m.tick(now.t);
    m.abort('host ended the match');
    expect(m.isOver()).toBe(true);
    expect(m.outcome()).toMatchObject({ incomplete: true, headline: /ended early/ });
    expect(view(m, 'pa').aborted).toBe('host ended the match');
  });
});

describe('LAN racing: client UI', () => {
  it('renders interpolated server snapshots and batches key presses', () => {
    const { m, now } = match();
    const sent: Array<Record<string, unknown>> = [];
    let serverNow = now.t;
    const ui = new RacingUi({ you: () => 'pa', send: (a) => sent.push(a), serverNow: () => serverNow, isHost: () => false, anim: () => serverNow });
    ui.setView(m.viewFor('pa'));
    let lines = ui.render(76, 22).map(stripAnsi);
    expect(lines.join('\n')).toMatch(/LAP 1\/1/);
    expect(lines.join('\n')).toContain('[  ');
    for (let i = 0; i < 160; i++) {
      now.t += 33;
      serverNow = now.t;
      m.tick(now.t);
      ui.setView(m.viewFor('pa'));
      ui.tick(33);
    }
    lines = ui.render(76, 22).map(stripAnsi);
    expect(lines.join('\n')).toContain('/^\\');
    expect(lines.join('\n')).toMatch(/POS [12]\/2/);
    // Presses are queued and sent together, at most every 40ms.
    ui.onKey({ name: 'left' });
    ui.onKey({ name: 'left' });
    ui.onKey({ name: 'char', ch: 'w' });
    expect(sent.at(-1)?.p).toMatch(/^l/);
    ui.tick(50);
    const all = sent.map((s) => s.p).join('');
    expect(all).toBe('llg');
    for (const s of sent) expect(parseInput(s)).not.toBeNull();
    // Every batch the UI sends is accepted by the server.
    for (const s of sent) expect(m.handleAction('pa', s, now.t)).toEqual({ ok: true });
    expect(ui.onKey({ name: 'char', ch: 'x' })).toBe(false);
  });
});

describe('LAN racing: in a lobby', () => {
  class FakeConn implements ConnHandle {
    msgs: ServerMessage[] = [];
    constructor(readonly remote = '192.168.1.50') {}
    send(msg: ServerMessage) { this.msgs.push(msg); }
    close(_c: ByeCode, _r: string) {}
  }

  it('the lobby runs it at a fast tick, then drops back to the default; results reach everyone', () => {
    let now = 1_000_000;
    const lobby = new Lobby({ address: '127.0.0.1', port: 7777, hostKey: 'k'.repeat(32), introMs: 0, seed: 'race-lobby', now: () => now, gameId: 'racing', options: { laps: 1 } });
    const a = new FakeConn();
    const b = new FakeConn();
    const ida = lobby.hello(a, { type: 'hello', name: 'Ada' })!;
    const idb = lobby.hello(b, { type: 'hello', name: 'Bob' })!;
    expect(lobby.desiredTickMs).toBeNull();
    expect(lobby.hostCommand({ cmd: 'start', force: true })).toEqual({ ok: true });
    expect(lobby.desiredTickMs).toBe(33);
    let seq = 0;
    const lastView = (c: FakeConn) => [...c.msgs].reverse().find((x) => x.type === 'view') as Extract<ServerMessage, { type: 'view' }> | undefined;
    for (let i = 0; i < 6000 && lobby.currentPhase === 'match'; i++) {
      now += 33;
      lobby.tick();
      for (const [conn, id] of [[a, ida], [b, idb]] as const) {
        const v = lastView(conn)?.view as RaceNetView | undefined;
        if (!v || v.phase !== 'racing') continue;
        const t = new Track({ seed: v.seed, kind: 'circuit', preset: v.preset, conditions: v.conditions });
        const mine = v.cars.find((c) => c[0] === id)!;
        const pos = (c: RaceNetView['cars'][number]) => ({ off: c[1] / 100, d: c[2] / 100, v: c[3] / 10 });
        const p = netDriver(t, pos(mine), v.cars.filter((c) => c[0] !== id).map(pos));
        if (p) lobby.handle(id, { type: 'action', seq: ++seq, matchId: lobby.matchId!, action: { kind: 'in', p } });
      }
    }
    expect(lobby.currentPhase).toBe('results');
    expect(lobby.desiredTickMs).toBeNull();
    // Rejected stale input after the race: no match running.
    lobby.handle(ida, { type: 'action', seq: ++seq, matchId: 'old', action: { kind: 'in', p: 'g' } });
    expect([...a.msgs].reverse().find((x) => x.type === 'ack')).toMatchObject({ ok: false });
    const st = lobby.state();
    expect(st.results?.standings).toHaveLength(2);
    expect(st.results?.headline).toMatch(/wins in/);
  });
});
