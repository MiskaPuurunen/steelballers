/**
 * Render the LAN screens to plain text (docs/screens/lan-*.txt) by driving
 * real App instances over a loopback LAN game. Doubles as a visual check
 * at a given terminal size.
 *
 * Usage: npx tsx scripts/lan-screens.ts [cols] [rows] [outDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { setColor, stripAnsi } from '../src/ui/style.js';
import { LanClient } from '../src/net/client.js';
import type { LanStart } from '../src/ui/lan/lan-screen.js';

setColor(false);
const cols = Number(process.argv[2] ?? 80);
const rows = Number(process.argv[3] ?? 24);
const outDir = process.argv[4] ?? path.join('docs', 'screens');
fs.mkdirSync(outDir, { recursive: true });

let t = 0;
function arcade(start: LanStart) {
  const store = new SaveStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-shot-')), 'save.json'));
  const io = new FakeTerminal(cols, rows);
  let fns: Array<() => void> = [];
  const app = new App({
    io, store, save: store.load().data, start: { mode: 'lan', lan: start },
    scheduler: { now: () => t, setInterval: (fn) => { fns.push(fn); return fns.length; }, clearInterval: () => { fns = []; } },
    lanDeps: { resolveBind: () => '127.0.0.1', scan: async () => [] },
  });
  void app.run();
  return { app, io, tick: () => fns.forEach((f) => f()), text: () => app.frame.map(stripAnsi).join('\n') };
}
type Arcade = ReturnType<typeof arcade>;

async function until(as: Arcade[], cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    t += 34;
    as.forEach((a) => a.tick());
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${what}\n${as.map((a) => a.text()).join('\n=====\n')}`);
}

function save(name: string, a: Arcade): void {
  const file = path.join(outDir, `lan-${name}.txt`);
  fs.writeFileSync(file, a.text().replace(/\s+$/gm, '') + '\n');
  console.log(`--- ${file}\n${a.text()}\n`);
}

async function main(): Promise<void> {
  // Battleship: host + joiner.
  const h = arcade({ mode: 'host', gameId: 'battleship', name: 'Matei', port: 0, immediate: true });
  await until([h], () => !!h.app.lan?.lanClient?.lobby, 'lobby');
  const port = h.app.lan!.lanServer!.port;
  const j = arcade({ mode: 'join', host: '127.0.0.1', port, name: 'CaptainByte', immediate: true });
  const both = [h, j];
  await until(both, () => h.text().includes('CaptainByte'), 'join');
  j.io.send('r');
  await until(both, () => (h.app.lan!.lanClient!.lobby!.members.every((m) => m.ready)), 'ready');
  h.io.send('t');
  for (const ch of 'gl hf!') h.io.send(ch);
  h.io.send('\r');
  await until(both, () => h.text().includes('gl hf'), 'chat');
  save('lobby', h);
  h.io.send('s');
  await until(both, () => j.text().includes('DEPLOY'), 'placement');
  j.io.send('\r');
  j.io.send('\x1b[B');
  save('battleship-placing', j);
  for (const a of both) { a.io.send('x'); a.io.send('\r'); }
  await until(both, () => /YOUR TURN/.test(h.text() + j.text()), 'battle');
  const turns = () => (h.app.lan!.lanClient!.view!.view as { turns: number }).turns;
  for (let i = 0; i < 14; i++) {
    const s = /YOUR TURN/.test(h.text()) ? h : j;
    const before = turns();
    s.io.send(String.fromCharCode(97 + ((i * 3) % 10)));
    s.io.send(String(1 + ((i * 7 + Math.floor(i / 10)) % 10)));
    s.io.send('\r');
    await until(both, () => turns() > before && /YOUR TURN/.test(h.text() + j.text()), 'shot');
  }
  save('battleship-battle', /YOUR TURN/.test(h.text()) ? h : j);
  h.app.quit();
  j.app.quit();

  // Prompt Panic: host + two scripted players.
  const p = arcade({ mode: 'host', gameId: 'prompt-panic', name: 'Matei', port: 0, immediate: true, options: { rounds: 5 } });
  await until([p], () => !!p.app.lan?.lanClient?.lobby, 'pp lobby');
  const others = await Promise.all(['Ada', 'Linus'].map(async (name) => {
    const c = new LanClient({ host: '127.0.0.1', port: p.app.lan!.lanServer!.port, name });
    await c.connect();
    c.setReady(true);
    return c;
  }));
  await until([p], () => p.app.lan!.lanClient!.lobby!.members.length === 3 && p.app.lan!.lanClient!.lobby!.members.every((m) => m.ready), 'pp ready');
  p.io.send('s');
  await until([p], () => p.text().includes('Your response'), 'answer');
  for (const ch of 'A language where every bug is a feature flag') p.io.send(ch);
  save('prompt-panic-answer', p);
  p.io.send('\r');
  others[0].sendAction({ kind: 'answer', text: 'YAML, but the indentation is emotional.' });
  others[1].sendAction({ kind: 'answer', text: 'Semicolon++: every line ends in three of them, for safety.' });
  await until([p], () => p.text().includes('VOTE FOR'), 'vote');
  save('prompt-panic-vote', p);
  p.io.send('\r');
  for (const c of others) {
    const v = c.view!.view as { entries: Array<{ key: string; yours: boolean }> };
    c.sendAction({ kind: 'vote', key: v.entries.find((e) => !e.yours)!.key });
  }
  await until([p], () => /SCORE/.test(p.text()), 'reveal');
  save('prompt-panic-results', p);
  others.forEach((c) => c.close());
  p.app.quit();

  // Doodle Protocol: the host draws.
  const d = arcade({ mode: 'host', gameId: 'doodle-protocol', name: 'Matei', port: 0, immediate: true });
  await until([d], () => !!d.app.lan?.lanClient?.lobby, 'dd lobby');
  const g = arcade({ mode: 'join', host: '127.0.0.1', port: d.app.lan!.lanServer!.port, name: 'Grace', immediate: true });
  await until([d, g], () => d.text().includes('Grace'), 'dd join');
  d.io.send('s');
  await until([d, g], () => d.text().includes('Start again'), 'force prompt');
  d.io.send('s');
  await until([d, g], () => /Draw:|Word:/.test(d.text()) && /Draw:|Word:/.test(g.text()), 'doodle');
  const artist = d.text().includes('Draw:') ? d : g;
  const guesser = artist === d ? g : d;
  artist.io.send('p');
  for (let i = 0; i < 8; i++) artist.io.send('\x1b[C');
  for (let i = 0; i < 4; i++) artist.io.send('\x1b[B');
  artist.io.send('2');
  for (let i = 0; i < 8; i++) artist.io.send('\x1b[D');
  for (let i = 0; i < 4; i++) artist.io.send('\x1b[A');
  await until([d, g], () => guesser.text().includes('*'), 'strokes arrive');
  for (const ch of 'banana') guesser.io.send(ch);
  guesser.io.send('\r');
  for (const ch of 'box') guesser.io.send(ch);
  await until([d, g], () => artist.text().includes('banana'), 'guess feed');
  save('doodle-artist', artist);
  save('doodle-guesser', guesser);
  d.app.quit();
  g.app.quit();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
