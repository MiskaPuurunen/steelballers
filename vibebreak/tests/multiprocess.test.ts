import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * End-to-end: the real CLI in separate OS processes. A dedicated host and
 * bot clients talk over TCP on 127.0.0.1 and play complete matches.
 */

const ROOT = path.resolve(__dirname, '..');
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill();
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function cli(args: string[], home: string) {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, VIBEBREAK_HOME: home, VIBEBREAK_BOT_THINK_MS: '0-30', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(p);
  let out = '';
  p.stdout!.on('data', (d) => { out += d; });
  p.stderr!.on('data', (d) => { out += d; });
  const exit = new Promise<number>((r) => p.on('exit', (code) => r(code ?? -1)));
  return { p, exit, out: () => out };
}

const results = (text: string) => text.split('\n').filter((l) => l.startsWith('RESULT ')).map((l) => JSON.parse(l.slice(7)));

async function waitForText(get: () => string, re: RegExp, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!re.test(get())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${re}:\n${get()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('multi-process LAN matches', () => {
  it('a dedicated host and two bot processes complete a Battleship match', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-mp-'));
    const port = await freePort();
    const host = cli(['host', '--dedicated', '--local', '--port', String(port), '--game', 'battleship', '--autostart', '2', '--matches', '1'], home);
    await waitForText(host.out, /Room \w{4} is open/);
    const a = cli(['join', `127.0.0.1:${port}`, '--bot', '--name', 'Ada', '--matches', '1'], home);
    const b = cli(['join', '127.0.0.1', '--port', String(port), '--bot', '--name', 'Bob', '--matches', '1'], home);
    const codes = await Promise.all([host.exit, a.exit, b.exit]);
    expect(codes).toEqual([0, 0, 0]);
    const [hostResult] = results(host.out());
    expect(hostResult).toMatchObject({ gameId: 'battleship', incomplete: false });
    const winner = hostResult.standings.find((s: { rank: number }) => s.rank === 1).name;
    // Every process agrees on the outcome the server decided.
    const [ra] = results(a.out());
    const [rb] = results(b.out());
    expect([ra, rb].find((r) => r.rank === 1).player).toBe(winner);
    expect(ra.headline).toBe(hostResult.headline);
    expect(rb.headline).toBe(hostResult.headline);
    expect(host.out()).toMatch(/Ada joined/);
    expect(host.out()).toMatch(/Bob joined/);
  }, 90_000);

  it('three bot processes play Prompt Panic; the console can inspect the room', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-mp-'));
    const port = await freePort();
    const host = cli(['host', '--dedicated', '--local', '--port', String(port), '--game', 'prompt-panic',
      '--set', 'rounds=3', '--set', 'revealTime=5', '--autostart', '3', '--matches', '1'], home);
    await waitForText(host.out, /Room \w{4} is open/);
    const bots = ['Ann', 'Ben', 'Cat'].map((n) => cli(['join', `127.0.0.1:${port}`, '--bot', '--name', n, '--matches', '1'], home));
    await waitForText(host.out, /Starting Prompt Panic with 3 players/);
    host.p.stdin!.write('status\n');
    await waitForText(host.out, /prompt-panic · (intro|match) · 3 connected/);
    const codes = await Promise.all([host.exit, ...bots.map((b) => b.exit)]);
    expect(codes).toEqual([0, 0, 0, 0]);
    const [r] = results(host.out());
    expect(r.gameId).toBe('prompt-panic');
    expect(r.standings).toHaveLength(3);
    // 3 rounds: at least the answer bonus each round, all from server-side scoring.
    for (const s of r.standings) expect(s.score).toBeGreaterThanOrEqual(75);
  }, 90_000);

  it('a client gets a clear error when nobody is hosting', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-mp-'));
    const port = await freePort();
    const c = cli(['join', `127.0.0.1:${port}`, '--bot'], home);
    expect(await c.exit).toBe(1);
    expect(c.out()).toMatch(/Nothing is accepting connections at 127\.0\.0\.1:\d+/);
  }, 30_000);

  it('host --no-timer turns off optional game timers only, and the console closes it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-mp-'));
    const port = await freePort();
    const host = cli(['host', '--dedicated', '--local', '--port', String(port), '--game', 'battleship', '--no-timer'], home);
    await waitForText(host.out, /Room \w{4} is open/);
    expect(host.out()).toMatch(/turn timer and placement timer off/);
    host.p.stdin!.write('status\nclose\n');
    expect(await host.exit).toBe(0);
    const pp = cli(['host', '--dedicated', '--local', '--port', String(port), '--game', 'prompt-panic', '--no-timer'], home);
    await waitForText(pp.out, /timers are part of the game rules and stay on/);
    pp.p.stdin!.write('close\n');
    expect(await pp.exit).toBe(0);
  }, 30_000);

  it('rejects bad CLI input with helpful messages', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-mp-'));
    const bad = cli(['host', '--game', 'chess', '--dedicated'], home);
    expect(await bad.exit).toBe(2);
    expect(bad.out()).toMatch(/unknown LAN game "chess". Available: battleship, prompt-panic, doodle-protocol, random/);
    const opt = cli(['host', '--game', 'battleship', '--set', 'turnTime=7', '--dedicated'], home);
    expect(await opt.exit).toBe(2);
    expect(opt.out()).toMatch(/invalid option turnTime=7 .* turnTime=0\|20\|30\|60/);
  }, 30_000);
});
