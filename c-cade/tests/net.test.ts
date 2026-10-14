import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LanServer, type ServerOptions } from '../src/net/server.js';
import { LanClient } from '../src/net/client.js';
import { Bot } from '../src/mp/bot.js';
import { DiscoveryResponder, scanRooms } from '../src/net/discovery.js';
import { PROTOCOL_VERSION, decodeClient, decodeServer, encodeClient, LineDecoder, MAX_MESSAGE_BYTES, TokenBucket } from '../src/net/protocol.js';
import { cleanName, cleanText, scrub, scrubDeep, wrapText } from '../src/net/sanitize.js';
import { broadcastFor, isPrivateAddress, parseHostPort, lanInterfaces } from '../src/net/address.js';
import { FLEET, type BattleshipView } from '../src/games/multiplayer/battleship.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function host(over: ServerOptions = {}) {
  const server = new LanServer({ bind: '127.0.0.1', port: 0, tickMs: 25, ...over, lobby: { introMs: 0, ...over.lobby } });
  await server.start();
  cleanup.push(() => server.close());
  return server;
}

async function join(server: LanServer, name: string, extra: Partial<ConstructorParameters<typeof LanClient>[0]> = {}) {
  const c = new LanClient({ host: '127.0.0.1', port: server.port, name, reconnectWindowMs: 5000, ...extra });
  cleanup.push(() => c.close());
  await c.connect();
  return c;
}

async function waitFor(cond: () => unknown, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A raw TCP peer for sending malformed traffic. */
function raw(port: number) {
  const s = net.createConnection({ host: '127.0.0.1', port });
  const lines: string[] = [];
  let closed = false;
  const dec = new LineDecoder(1 << 20);
  s.on('data', (b) => lines.push(...dec.push(b)));
  s.on('close', () => { closed = true; });
  s.on('error', () => {});
  cleanup.push(() => s.destroy());
  return {
    s, lines, get closed() { return closed; },
    msgs: () => lines.map((l) => decodeServer(l)).filter((d) => d.ok).map((d) => (d as { msg: { type: string } & Record<string, unknown> }).msg),
    ready: new Promise<void>((r) => s.once('connect', () => r())),
  };
}

/* ---------------------------------------------------------- pure parts */

describe('protocol', () => {
  it('round-trips and validates client messages', () => {
    const line = encodeClient({ type: 'action', seq: 3, matchId: 'm1', action: { kind: 'fire', x: 1, y: 2 } });
    const env = JSON.parse(line);
    expect(env).toMatchObject({ v: PROTOCOL_VERSION, type: 'action', seq: 3, matchId: 'm1', payload: { action: { kind: 'fire' } } });
    expect(decodeClient(line.trim())).toMatchObject({ ok: true, msg: { type: 'action', seq: 3 } });
    expect(decodeClient('nope')).toMatchObject({ ok: false, code: 'BAD_JSON' });
    expect(decodeClient('[]')).toMatchObject({ ok: false, code: 'BAD_MESSAGE' });
    expect(decodeClient(JSON.stringify({ v: 99, type: 'hello', payload: {} }))).toMatchObject({ ok: false, code: 'VERSION' });
    expect(decodeClient(JSON.stringify({ v: 1, type: 'teleport', payload: {} }))).toMatchObject({ ok: false, code: 'UNKNOWN_TYPE' });
    expect(decodeClient(JSON.stringify({ v: 1, type: 'action', seq: 1, payload: { action: { kind: 'x' } } }))).toMatchObject({ ok: false });
    expect(decodeClient(JSON.stringify({ v: 1, type: 'host', seq: 1, payload: { command: { cmd: 'self-destruct' } } }))).toMatchObject({ ok: false });
    expect(decodeClient(JSON.stringify({ v: 1, type: 'hello', payload: { name: 'x', token: '../../etc' } }))).toMatchObject({ ok: false });
    expect(decodeClient('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('frames lines and refuses unbounded buffering', () => {
    const d = new LineDecoder(10);
    expect(d.push(Buffer.from('ab\ncd'))).toEqual(['ab']);
    expect(d.push(Buffer.from('e\n'))).toEqual(['cde']);
    expect(d.push(Buffer.from('x'.repeat(11)))).toEqual([]);
    expect(d.overflowed).toBe(true);
  });

  it('token bucket limits bursts and refills', () => {
    const b = new TokenBucket(2, 1, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
    expect(b.take(1000)).toBe(true);
  });
});

describe('sanitising untrusted text', () => {
  it('removes terminal escapes, bidi tricks, zero-width and wide characters', () => {
    expect(scrub('\x1b[2J\x1b]0;title\x07ok\x9b31m')).toBe('[2J]0;titleok31m');
    expect(scrub('a‮b​c')).toBe('abc');
    expect(scrub('hi 😀 漢字 ok')).toBe('hi   ok');
    expect(cleanText('  lots   of\n\nspace\t ', 50)).toBe('lots of space');
    expect(cleanText('ｆｕｌｌｗｉｄｔｈ', 50)).toBe('fullwidth');
    expect(cleanName('\x1b[31m')).toBe('[31m');
    expect(cleanName('\x00\x01')).toBe('Player');
    expect([...cleanName('x'.repeat(40))].length).toBe(16);
    expect(scrubDeep({ a: ['\x1bb', { c: '\x07d' }], __proto__x: 1 })).toEqual({ a: ['b', { c: 'd' }], __proto__x: 1 });
    expect(wrapText('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrapText('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic']);
  });
});

describe('address policy', () => {
  it('recognises private, loopback and link-local addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.42', '169.254.1.1', '::1', '::ffff:192.168.0.5', 'fe80::1%eth0', 'fd12::1']) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '193.168.1.1', '2001:4860::8888', '', undefined]) expect(isPrivateAddress(a)).toBe(false);
  });

  it('computes broadcast addresses and prefers real LAN adapters', () => {
    expect(broadcastFor('192.168.1.42', '255.255.255.0')).toBe('192.168.1.255');
    const ifs = lanInterfaces({
      'vEthernet (WSL)': [{ address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
      'Wi-Fi': [{ address: '192.168.1.42', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null }],
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null }],
    });
    expect(ifs[0].address).toBe('192.168.1.42');
    expect(ifs.map((i) => i.address)).not.toContain('127.0.0.1');
  });

  it('parses join targets', () => {
    expect(parseHostPort('192.168.1.42', 7777)).toEqual({ host: '192.168.1.42', port: 7777 });
    expect(parseHostPort('192.168.1.42:7800', 7777)).toEqual({ host: '192.168.1.42', port: 7800 });
    expect(parseHostPort('[fe80::1]:7000', 7777)).toEqual({ host: 'fe80::1', port: 7000 });
    expect(parseHostPort('host:99999', 7777)).toHaveProperty('error');
    expect(parseHostPort('bad host', 7777)).toHaveProperty('error');
  });
});

/* ------------------------------------------------------------ real TCP */

describe('LAN host and clients over TCP', () => {
  it('host creation, join, leave and clean shutdown', async () => {
    const server = await host();
    expect(server.port).toBeGreaterThan(0);
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bob');
    await waitFor(() => a.lobby?.members.length === 2, 3000, 'two members');
    expect(a.lobby!.members.map((m) => m.name)).toEqual(['Ada', 'Bob']);
    expect(a.playerId).not.toBe(b.playerId);

    b.leave();
    await waitFor(() => b.status === 'closed' && a.lobby?.members.length === 1, 3000, 'leave');
    expect(server.lobby.memberCount).toBe(1);

    const closed = new Promise<string>((r) => a.once('closed', r));
    await server.close();
    expect(await closed).toMatch(/closed the lobby/);
    expect(server.connectionCount).toBe(0);
  });

  it('enforces the maximum player count but admits spectators', async () => {
    const server = await host({ lobby: { maxPlayers: 2 } });
    await join(server, 'A');
    await join(server, 'B');
    await expect(join(server, 'C')).rejects.toThrow(/full \(2\/2 players\)/);
    const spec = await join(server, 'Watcher', { spectate: true });
    await waitFor(() => spec.lobby?.members.some((m) => m.name === 'Watcher' && m.spectator));
  });

  it('gives duplicate names a suffix and sanitises hostile names for everyone', async () => {
    const server = await host();
    const a = await join(server, 'Ada');
    await join(server, 'ada');
    await join(server, '\x1b[2J\x1b[31mEvil\x07');
    await waitFor(() => a.lobby?.members.length === 3);
    expect(a.lobby!.members.map((m) => m.name)).toEqual(['Ada', 'ada 2', '[2J[31mEvil']);
    expect(JSON.stringify(a.lobby)).not.toMatch(/\\u001b|\\u0007/);
  });

  it('rejects invalid traffic: garbage, wrong first message, oversize lines, wrong version', async () => {
    const server = await host();
    const g = raw(server.port);
    await g.ready;
    g.s.write('this is not json\n');
    await waitFor(() => g.closed, 2000, 'garbage peer dropped');
    expect(g.msgs().map((m) => m.type)).toEqual(['error', 'bye']);

    const w = raw(server.port);
    await w.ready;
    w.s.write(encodeClient({ type: 'chat', text: 'hi' }));
    await waitFor(() => w.closed, 2000, 'no-hello peer dropped');
    expect(w.msgs().at(-1)).toMatchObject({ type: 'bye', reason: /hello/ });

    const big = raw(server.port);
    await big.ready;
    big.s.write('x'.repeat(MAX_MESSAGE_BYTES + 100));
    await waitFor(() => big.closed, 2000, 'oversize peer dropped');

    const v = raw(server.port);
    await v.ready;
    v.s.write(JSON.stringify({ v: 2, type: 'hello', payload: { name: 'Future' } }) + '\n');
    await waitFor(() => v.closed, 2000, 'version mismatch dropped');
    expect(v.msgs().at(-1)).toMatchObject({ type: 'bye', code: 'version' });
    expect(server.lobby.memberCount).toBe(0);
  });

  it('times out silent connections (hello timeout and idle timeout)', async () => {
    const server = await host({ helloTimeoutMs: 150, idleTimeoutMs: 300, pingIntervalMs: 60_000 });
    const silent = raw(server.port);
    await silent.ready;
    await waitFor(() => silent.closed, 2000, 'hello timeout');

    const idle = raw(server.port);
    await idle.ready;
    idle.s.write(encodeClient({ type: 'hello', name: 'Zzz' }));
    await waitFor(() => server.lobby.memberCount === 1);
    await waitFor(() => idle.closed, 2000, 'idle timeout');
  });

  it('reconnects to the same seat after a network drop', async () => {
    const server = await host({ lobby: { lobbyGraceMs: 5000 } });
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bob');
    const id = b.playerId;
    const statuses: string[] = [];
    b.on('status', (s) => statuses.push(s));
    (b as unknown as { socket: net.Socket }).socket.destroy(); // simulate a dropped connection
    await waitFor(() => a.lobby?.members.find((m) => m.name === 'Bob')?.connected === false, 2000, 'host sees drop');
    await waitFor(() => b.status === 'online' && statuses.includes('reconnecting'), 4000, 'reconnect');
    expect(b.playerId).toBe(id);
    await waitFor(() => a.lobby?.members.find((m) => m.name === 'Bob')?.connected === true);
    expect(a.lobby!.members).toHaveLength(2);
  });

  it('drops a disconnected player after the grace period', async () => {
    const server = await host({ lobby: { lobbyGraceMs: 200 } });
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bob', { reconnectWindowMs: 0 });
    await waitFor(() => a.lobby?.members.length === 2);
    (b as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => a.lobby?.members.length === 1, 2000, 'stale seat removed');
  });

  it('kicks a player (host only) and refuses their token afterwards', async () => {
    const server = await host();
    const h = await join(server, 'Host', { hostKey: server.hostKey });
    const p = await join(server, 'Pest');
    expect(h.isHost).toBe(true);
    expect(p.isHost).toBe(false);
    await waitFor(() => h.lobby?.members.length === 2);
    const acks: Array<{ ok: boolean; code?: string }> = [];
    p.on('ack', (x) => acks.push(x));
    p.sendHost({ cmd: 'kick', playerId: h.playerId! });
    await waitFor(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ ok: false, code: 'NOT_HOST' });

    const reason = new Promise<string>((r) => p.once('closed', r));
    h.sendHost({ cmd: 'kick', playerId: p.playerId! });
    expect(await reason).toMatch(/removed/);
    await waitFor(() => h.lobby?.members.length === 1);
    // The old token no longer works.
    const again = new LanClient({ host: '127.0.0.1', port: server.port, name: 'Pest' });
    cleanup.push(() => again.close());
    (again as unknown as { token: string }).token = p.token!;
    await expect(again.connect()).rejects.toThrow(/removed/);
  });

  it('a wrong host key does not grant host powers', async () => {
    const server = await host();
    const fake = await join(server, 'Mallory', { hostKey: 'x'.repeat(32) });
    expect(fake.isHost).toBe(false);
  });

  it('rate-limits floods without disturbing other players', async () => {
    const server = await host();
    const a = await join(server, 'Ada');
    const f = raw(server.port);
    await f.ready;
    f.s.write(encodeClient({ type: 'hello', name: 'Flood' }));
    await waitFor(() => server.lobby.memberCount === 2);
    f.s.write(encodeClient({ type: 'chat', text: 'spam' }).repeat(400));
    await waitFor(() => f.msgs().some((m) => m.type === 'error' && m.code === 'RATE_LIMITED'), 2000, 'rate limit');
    // Chat spam is capped well below what was sent.
    await new Promise((r) => setTimeout(r, 100));
    expect(a.chat.filter((l) => l.text === 'spam').length).toBeLessThanOrEqual(3);
  });

  it('reports friendly connection errors', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const c = new LanClient({ host: '127.0.0.1', port, name: 'x' });
    await expect(c.connect()).rejects.toThrow(/Nothing is accepting connections .* Is the host running/);
  });
});

/* -------------------------------------------------- a match over TCP */

describe('Battleship over the network', () => {
  it('plays a full match between two bot clients with server-side validation', async () => {
    const server = await host({ lobby: { gameId: 'battleship' } });
    const h = await join(server, 'Host', { hostKey: server.hostKey });
    const b = await join(server, 'Bob');
    const views: BattleshipView[] = [];
    b.on('view', (v) => views.push(v.view as BattleshipView));
    const botH = new Bot(h, { thinkMs: [0, 5], seed: 'h' });
    const botB = new Bot(b, { thinkMs: [0, 5], seed: 'b' });
    botH.start();
    botB.start();
    cleanup.push(() => botH.stop(), () => botB.stop());

    // Not everyone ready yet -> start needs force; bots ready up automatically.
    await waitFor(() => h.lobby?.members.length === 2 && h.lobby.members.every((m) => m.ready), 2000, 'ready');
    h.sendHost({ cmd: 'start' });
    await waitFor(() => h.lobby?.phase === 'match', 2000, 'match start');
    const matchId = h.lobby!.matchId!;

    // Mid-match: a stale match id and an out-of-turn shot are both refused.
    const acks: Array<{ seq: number; ok: boolean; code?: string; duplicate?: boolean }> = [];
    b.on('ack', (x) => acks.push(x));
    await waitFor(() => (b.view?.view as BattleshipView)?.phase === 'battle', 4000, 'battle');
    const internals = b as unknown as { write(m: unknown): void; seq: number };
    const stale = ++internals.seq;
    internals.write({ type: 'action', seq: stale, matchId: 'old-match', action: { kind: 'fire', x: 0, y: 0 } });
    await waitFor(() => acks.some((a) => a.seq === stale));
    expect(acks.find((a) => a.seq === stale)).toMatchObject({ ok: false, code: 'STALE_MATCH' });
    // Replaying an old seq is acknowledged as a duplicate and not applied again.
    internals.write({ type: 'action', seq: stale, matchId, action: { kind: 'fire', x: 0, y: 0 } });
    await waitFor(() => acks.some((a) => a.seq === stale && a.duplicate));

    await waitFor(() => h.lobby?.phase === 'results', 20_000, 'match end');
    const results = h.lobby!.results!;
    expect(results.gameId).toBe('battleship');
    expect(results.standings).toHaveLength(2);
    expect(results.standings[0].rank).toBe(1);
    expect(results.headline).toMatch(/sank the whole fleet/);

    // Privacy: before the end, Bob never received Host's ship positions.
    const hostIdx = 1 - (views.find((v) => v.you !== null)!.you as number);
    for (const v of views.filter((x) => x.phase !== 'over')) {
      expect(v.mine?.length ?? 0).toBeLessThanOrEqual(FLEET.length);
      const sunkOfHost = v.boards[hostIdx].sunk.length;
      expect(JSON.stringify(v).split('"dir"').length - 1).toBe((v.mine?.length ?? 0) + sunkOfHost + v.boards[1 - hostIdx].sunk.length);
    }

    // Rematch with the same players.
    h.sendHost({ cmd: 'rematch' });
    await waitFor(() => h.lobby?.phase === 'match' && h.lobby.matchId !== matchId, 3000, 'rematch');
    // Host shutdown mid-match closes everyone cleanly.
    const reason = new Promise<string>((r) => b.once('closed', r));
    await server.close();
    expect(await reason).toMatch(/closed/);
  }, 30_000);

  it('a player who drops mid-match keeps the seat during the grace period, then forfeits', async () => {
    const server = await host({ lobby: { gameId: 'battleship', graceMs: 400 } });
    const h = await join(server, 'Host', { hostKey: server.hostKey });
    const b = await join(server, 'Bob', { reconnectWindowMs: 0 });
    b.setReady(true);
    await waitFor(() => h.lobby?.members.length === 2 && h.lobby.members.every((m) => m.ready));
    h.sendHost({ cmd: 'start' });
    await waitFor(() => h.view !== null, 2000, 'view');
    (b as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => (h.view?.view as BattleshipView).paused === 'Bob', 2000, 'paused for Bob');
    expect(h.lobby!.phase).toBe('match');
    await waitFor(() => h.lobby?.phase === 'results', 3000, 'forfeit');
    expect(h.lobby!.results!.headline).toMatch(/forfeit/);
  });
});

describe('Prompt Panic over the network', () => {
  it('three players answer, vote and finish; self-votes are refused by the server', async () => {
    const server = await host({ lobby: { gameId: 'prompt-panic', options: { rounds: 3, revealTime: 5 } } });
    const h = await join(server, 'Host', { hostKey: server.hostKey });
    const clients = [h, await join(server, 'Bea'), await join(server, 'Cid')];
    const bots = clients.slice(1).map((c, i) => new Bot(c, { thinkMs: [0, 5], seed: `b${i}` }));
    bots.forEach((b) => b.start());
    cleanup.push(() => bots.forEach((b) => b.stop()));
    await waitFor(() => h.lobby?.members.length === 3);
    h.sendHost({ cmd: 'start', force: true });
    await waitFor(() => h.view?.gameId === 'prompt-panic', 2000, 'match');
    // The host plays by hand: answer, then try to vote for itself.
    h.sendAction({ kind: 'answer', text: 'my \x1b[31mhand-written answer' });
    await waitFor(() => (h.view?.view as { phase: string }).phase === 'vote', 4000, 'vote');
    const entries = (h.view!.view as { entries: Array<{ key: string; yours: boolean; text: string }> }).entries;
    const mine = entries.find((e) => e.yours)!;
    expect(mine.text).toBe('my [31mhand-written answer');
    const acks: Array<{ ok: boolean; code?: string }> = [];
    h.on('ack', (a) => acks.push(a));
    h.sendAction({ kind: 'vote', key: mine.key });
    await waitFor(() => acks.length === 1);
    expect(acks[0]).toMatchObject({ ok: false, code: 'SELF_VOTE' });
    h.sendAction({ kind: 'vote', key: entries.find((e) => !e.yours)!.key });
    // Let the host also play the remaining rounds by skipping ahead.
    await waitFor(() => (h.view?.view as { phase: string }).phase === 'reveal', 3000, 'reveal');
    for (let i = 0; i < 6 && h.lobby?.phase !== 'results'; i++) {
      h.sendAction({ kind: 'advance' });
      await new Promise((r) => setTimeout(r, 150));
    }
    await waitFor(() => h.lobby?.phase === 'results', 10_000, 'results');
    const scores = h.lobby!.results!.standings;
    expect(scores).toHaveLength(3);
    // Every score is a multiple of the scoring units the server uses.
    for (const s of scores) expect(s.score % 25).toBe(0);
  }, 20_000);
});

/* ----------------------------------------------------------- discovery */

describe('LAN discovery', () => {
  it('answers probes with the room summary', async () => {
    const responder = new DiscoveryResponder(() => ({
      code: 'QXKD', name: "Ada's \x1b[2Jroom", host: 'Ada', game: 'Battleship', players: 1, max: 2, phase: 'lobby', joinable: true, port: 7777, address: '127.0.0.1',
    }), { port: 0, allowPublic: false, bindAddress: '127.0.0.1' });
    expect(await responder.start()).toBe(true);
    cleanup.push(() => responder.stop());
    const rooms = await scanRooms({ port: responder.port, targets: ['127.0.0.1'], timeoutMs: 400 });
    const room = rooms.find((r) => r.code === 'QXKD');
    expect(room).toMatchObject({ host: 'Ada', game: 'Battleship', players: 1, max: 2, connectTo: '127.0.0.1', port: 7777, joinable: true });
    expect(room!.name).toBe("Ada's [2Jroom");
  });
});
