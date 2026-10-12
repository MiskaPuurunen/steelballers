import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
import { LanClient } from '../src/net/client.js';
import type { LanStart } from '../src/ui/lan/lan-screen.js';
import type { BattleshipView } from '../src/games/multiplayer/battleship.js';
import { FakeScheduler } from './helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function waitFor(cond: () => unknown, ms = 4000, what = 'condition', pump?: () => void): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    pump?.();
    await new Promise((r) => setTimeout(r, 15));
  }
  pump?.();
}

function arcade(start: LanStart | null, cols = 100, rows = 34) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-lan-'));
  const store = new SaveStore(path.join(dir, 'save.json'));
  const io = new FakeTerminal(cols, rows);
  const sched = new FakeScheduler();
  const app = new App({
    io, store, save: store.load().data, scheduler: sched,
    start: start ? { mode: 'lan', lan: start } : { mode: 'menu' },
    lanDeps: { resolveBind: () => '127.0.0.1', scan: async () => [] },
  });
  const done = app.run();
  cleanup.push(() => app.quit());
  const text = () => app.frame.map(stripAnsi).join('\n');
  const pump = () => sched.advance(34, 34);
  return { app, io, sched, store, done, text, pump };
}

describe('LAN in the arcade UI', () => {
  it('menu shows the LAN entries and H opens the host form', () => {
    const a = arcade(null, 100, 34);
    expect(a.text()).toContain('HOST LAN GAME');
    expect(a.text()).toContain('JOIN LAN GAME');
    expect(a.text()).toContain('PARTY MODE');
    a.io.send('h');
    expect(a.app.stateKind).toBe('lan');
    expect(a.text()).toContain('HOST A LAN GAME');
    a.io.send('\x1b');
    expect(a.app.stateKind).toBe('menu');
  });

  it('host and joiner play Battleship through the real UI over TCP', async () => {
    const h = arcade({ mode: 'host', gameId: 'battleship', name: 'Hostess', port: 0, immediate: true });
    await waitFor(() => h.app.lan?.lanClient?.lobby, 4000, 'host lobby', h.pump);
    const port = h.app.lan!.lanServer!.port;
    expect(h.text()).toContain("HOSTESS'S ROOM");
    expect(h.text()).toContain(`vibebreak join 127.0.0.1 --port ${port}`);

    const j = arcade({ mode: 'join', host: '127.0.0.1', port, name: 'Joiner', immediate: true });
    await waitFor(() => h.text().includes('Joiner'), 4000, 'host sees joiner', () => { h.pump(); j.pump(); });
    expect(j.text()).toContain('Hostess');

    // Joiner readies up; host starts.
    j.io.send('r');
    await waitFor(() => h.text().includes('READY') && h.app.lan!.lanClient!.lobby!.members.every((m) => m.ready), 4000, 'ready', () => { h.pump(); j.pump(); });
    h.io.send('s');
    await waitFor(() => j.text().includes('DEPLOY YOUR FLEET') && h.text().includes('DEPLOY YOUR FLEET'), 6000, 'placement', () => { h.pump(); j.pump(); });
    expect(j.text()).toContain('YOUR FLEET');
    expect(j.text()).toContain('TARGET GRID');

    // Manual placement of the carrier, then auto-place the rest, confirm.
    for (const a of [h, j]) {
      a.io.send('\r'); // place the carrier at the cursor (A1, horizontal)
      a.io.send('x');
      a.io.send('\r');
    }
    await waitFor(() => /YOUR TURN/.test(h.text()) || /YOUR TURN/.test(j.text()), 6000, 'battle', () => { h.pump(); j.pump(); });
    const hostView = h.app.lan!.lanClient!.view!.view as BattleshipView;
    expect(hostView.mine![0]).toMatchObject({ id: 'carrier', x: 0, y: 0, dir: 'h' });

    // Whoever has the turn fires at J10 by typing the coordinate.
    const shooter = /YOUR TURN/.test(h.text()) ? h : j;
    const other = shooter === h ? j : h;
    other.io.send('a');
    other.io.send('1');
    other.io.send('\r'); // out of turn: refused locally, nothing sent
    expect(other.text()).toContain('Not your turn');
    shooter.io.send('j');
    shooter.io.send('1');
    shooter.io.send('0');
    shooter.io.send('\r');
    await waitFor(() => /fired at J10/.test(other.text()), 4000, 'shot visible to the opponent', () => { h.pump(); j.pump(); });
    expect(other.text()).toMatch(/YOUR TURN/);

    // The host ends the match from the Esc menu: no winner, back to results.
    h.io.send('\x1b');
    expect(h.text()).toContain('End match (no winner)');
    h.io.send('\x1b[B'); // down
    h.io.send('\r');
    await waitFor(() => /RESULTS/.test(j.text()), 4000, 'results', () => { h.pump(); j.pump(); });
    expect(j.text()).toContain('Match ended by the host');

    // Rematch from results.
    h.io.send('r');
    await waitFor(() => /DEPLOY YOUR FLEET/.test(j.text()), 6000, 'rematch', () => { h.pump(); j.pump(); });

    // Closing the lobby disconnects the joiner with a clear message.
    h.io.send('\x1b');
    const items = stripAnsi(h.app.frame.join('\n'));
    expect(items).toContain('Close lobby');
    h.io.send('\x1b[A'); // up wraps to the last item: Close lobby
    h.io.send('\r');
    await waitFor(() => /DISCONNECTED/.test(j.text()), 4000, 'joiner disconnected', () => { h.pump(); j.pump(); });
    expect(j.text()).toMatch(/closed the lobby/);
    await waitFor(() => h.app.stateKind === 'menu', 2000, 'host back at the menu', h.pump);
    j.io.send('\r');
    expect(j.app.stateKind).toBe('menu');
  }, 30_000);

  it('hostile player text never reaches the terminal as escape sequences', async () => {
    const h = arcade({ mode: 'host', gameId: 'prompt-panic', name: 'Host', port: 0, immediate: true });
    await waitFor(() => h.app.lan?.lanClient?.lobby, 4000, 'lobby', h.pump);
    const evil = new LanClient({ host: '127.0.0.1', port: h.app.lan!.lanServer!.port, name: '\x1b]0;pwned\x07\x1b[2JEvil' });
    cleanup.push(() => evil.close());
    await evil.connect();
    evil.sendChat('\x1b]52;c;ZXZpbA==\x07clipboard \x1b[31mred');
    await waitFor(() => h.text().includes('clipboard'), 4000, 'chat shown', h.pump);
    expect(h.text()).toContain('Evil');
    // Our own UI never emits OSC sequences, so any here would be injected.
    expect(h.io.output).not.toContain('\x1b]');
    expect(h.io.output).not.toContain('\x07');
  });

  it('shows a useful error when the host is unreachable', async () => {
    const j = arcade({ mode: 'join', host: '127.0.0.1', port: 1, name: 'Lost', immediate: true });
    await waitFor(() => /DISCONNECTED/.test(j.text()), 6000, 'error screen', j.pump);
    expect(j.text()).toMatch(/Nothing is accepting connections|refused|reach/);
    j.io.send('r');
    expect(j.text()).toContain('JOIN A LAN GAME');
  });

  it('records finished matches and LAN achievements in the local save', async () => {
    const h = arcade({ mode: 'host', gameId: 'prompt-panic', name: 'Host', port: 0, immediate: true, options: { rounds: 3, revealTime: 5 } });
    await waitFor(() => h.app.lan?.lanClient?.lobby, 4000, 'lobby', h.pump);
    const port = h.app.lan!.lanServer!.port;
    const b = new LanClient({ host: '127.0.0.1', port, name: 'Bea' });
    cleanup.push(() => b.close());
    await b.connect();
    h.io.send('s');
    await waitFor(() => /not ready/.test(h.text()), 4000, 'not-ready warning', h.pump);
    h.io.send('s'); // second press starts even though Bea is not ready
    await waitFor(() => /YOUR PROMPT/.test(h.text()), 6000, 'prompt', h.pump);
    for (let round = 0; round < 3; round++) {
      await waitFor(() => /Your response/.test(h.text()), 6000, `answer field r${round}`, h.pump);
      for (const ch of 'my answer') h.io.send(ch);
      h.io.send('\r');
      b.sendAction({ kind: 'answer', text: `bea round ${round}` });
      await waitFor(() => /VOTE FOR YOUR FAVOURITE/.test(h.text()), 6000, 'vote', h.pump);
      h.io.send('\r'); // the cursor starts on an answer we may vote for
      const view = b.view!.view as { entries: Array<{ key: string; yours: boolean }> };
      b.sendAction({ kind: 'vote', key: view.entries.find((e) => !e.yours)!.key });
      await waitFor(() => /SCORE/.test(h.text()), 6000, 'reveal', h.pump);
      h.io.send('n'); // host skips the reveal timer
    }
    await waitFor(() => /RESULTS/.test(h.text()) && h.store.load().data.lan.matches === 1, 6000, 'results saved', h.pump);
    const save = h.store.load().data;
    expect(save.lan.games['prompt-panic'].plays).toBe(1);
    expect(save.achievements['lan-party']).toBeTruthy();
    expect(save.settings.lanName).toBe('Host');
  }, 30_000);
});

describe('LAN text fields', () => {
  it('accept bracketed paste and drop control characters', async () => {
    const { TextField } = await import('../src/ui/lan/widgets.js');
    const f = new TextField('', 20);
    f.onKey({ name: 'paste', text: '192.168.1.42:7777\r\n\x1b[2J' });
    expect(f.value).toBe('192.168.1.42:7777 [2');
  });
});
