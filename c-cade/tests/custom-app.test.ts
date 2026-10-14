import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
import { TEMPLATE_LUA } from '../src/custom/template.js';
import { FakeScheduler } from './helpers.js';

const PASTE = (s: string) => `\x1b[200~${s}\x1b[201~`;
const CTRL = (ch: string) => String.fromCharCode(ch.charCodeAt(0) - 96);

function setup(opts: { cols?: number; rows?: number; loadRuntime?: () => Promise<never> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-custom-'));
  const store = new SaveStore(path.join(dir, 'save.json'));
  const io = new FakeTerminal(opts.cols ?? 100, opts.rows ?? 34);
  const sched = new FakeScheduler();
  const customDir = path.join(dir, 'games');
  const app = new App({ io, store, save: store.load().data, start: { mode: 'menu' }, scheduler: sched, customDir, ...(opts.loadRuntime ? { loadRuntime: opts.loadRuntime } : {}) });
  void app.run();
  const text = () => app.frame.map(stripAnsi).join('\n');
  return { app, io, sched, store, dir, customDir, text };
}

describe('Custom games screen', () => {
  it('menu -> custom -> example -> save -> play a round -> no XP, best kept', async () => {
    const { app, io, sched, store, customDir, text } = setup();
    expect(text()).toContain('[5] CUSTOM GAMES');
    io.send('5');
    expect(app.stateKind).toBe('custom');
    await app.customReady;
    expect(text()).toContain('No custom games yet');
    io.send('n');
    expect(app.stateKind).toBe('custom-editor');
    expect(text()).toContain('game = {');
    io.send(CTRL('s'));
    expect(app.stateKind).toBe('custom');
    expect(text()).toContain('Packet Catcher');
    expect(text()).toContain('Added "Packet Catcher"');
    expect(fs.readFileSync(path.join(customDir, 'packet-catcher.lua'), 'utf8')).toBe(TEMPLATE_LUA);

    sched.advance(200);
    io.send('\r');
    expect(app.stateKind).toBe('briefing');
    expect(text()).toContain('CUSTOM GAME');
    sched.advance(200);
    io.send('\r');
    expect(app.stateKind).toBe('playing');
    sched.advance(31_000);
    expect(app.stateKind).toBe('results');
    expect(text()).toContain('Custom game: no XP');
    const save = store.load().data;
    expect(save.xp).toBe(0);
    expect(save.rounds).toBe(0);
    expect(Object.keys(save.achievements)).toEqual([]);
    sched.advance(700);
    io.send('m');
    expect(app.stateKind).toBe('custom');
  });

  it('pasting code (bracketed paste) adds a game; errors jump to the line', async () => {
    const { app, io, text } = setup();
    io.send('5');
    await app.customReady;
    io.send('p');
    io.send(PASTE('game = { id = "mini", name = "Mini", min_size = { w = 20, h = 3 } }\nfunction update()\n  local t = nil\n  t.x = 1\nend\n'));
    // The pasted "q" in "local" must not have been treated as a shortcut.
    expect(app.stateKind).toBe('custom-editor');
    io.send(CTRL('s'));
    expect(app.stateKind).toBe('custom-editor');
    expect(text()).toMatch(/Line 4: attempt to index/);
    expect(app.editor.row).toBe(3);
    // Fix the bug in place and save again.
    io.send(CTRL('x'));
    io.send(CTRL('x'));
    io.send(PASTE('game = { id = "mini", name = "Mini", min_size = { w = 20, h = 3 } }\nfunction render() return { "hi" } end\n'));
    io.send(CTRL('s'));
    expect(app.stateKind).toBe('custom');
    expect(text()).toContain('Mini');
  });

  it('loading a file by path (quoted, as from drag and drop)', async () => {
    const { app, io, sched, dir, customDir, text } = setup();
    const src = path.join(dir, 'my game.lua');
    fs.writeFileSync(src, TEMPLATE_LUA.replace('"packet-catcher"', '"from-file"').replace('"Packet Catcher"', '"From File"'));
    io.send('5');
    await app.customReady;
    io.send('f');
    expect(app.stateKind).toBe('custom-file');
    io.send(PASTE(`"${src}"\n`));
    sched.advance(200);
    io.send('\r');
    expect(app.stateKind).toBe('custom');
    expect(text()).toContain('From File');
    expect(fs.existsSync(path.join(customDir, 'from-file.lua'))).toBe(true);
  });

  it('a broken file shows the error and can be opened in the editor', async () => {
    const { app, io, sched, dir, text } = setup();
    const src = path.join(dir, 'bad.lua');
    fs.writeFileSync(src, 'game = {\n  id = "bad",\n  name = = "x"\n}');
    io.send('5');
    await app.customReady;
    io.send('f');
    io.send(PASTE(src));
    sched.advance(200);
    io.send('\r');
    expect(app.stateKind).toBe('custom-file');
    expect(text()).toMatch(/Line 3:/);
    io.send(CTRL('e'));
    expect(app.stateKind).toBe('custom-editor');
    expect(app.editor.row).toBe(2);
  });

  it('games already in the folder are listed at startup; broken ones are reported', async () => {
    const { app, io, customDir, text } = setup();
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'a.lua'), TEMPLATE_LUA);
    fs.writeFileSync(path.join(customDir, 'b.lua'), 'this is not lua');
    io.send('5');
    await app.customReady;
    expect(text()).toContain('Packet Catcher');
    expect(text()).toMatch(/b\.lua: game:1:/);
  });

  it('delete needs a double press and removes the file', async () => {
    const { app, io, customDir, text } = setup();
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'packet-catcher.lua'), TEMPLATE_LUA);
    io.send('5');
    await app.customReady;
    io.send('x');
    expect(text()).toContain('Press X again');
    io.send('x');
    expect(fs.existsSync(path.join(customDir, 'packet-catcher.lua'))).toBe(false);
    expect(text()).toContain('No custom games yet');
  });

  it('works without the Lua runtime: explains instead of crashing', async () => {
    const { app, io, text } = setup({ loadRuntime: () => Promise.reject(new Error('The Lua runtime is not installed. Run: npm install wasmoon')) });
    io.send('5');
    await app.customReady;
    expect(text()).toContain('npm install wasmoon');
    io.send('p');
    expect(app.stateKind).toBe('custom');
  });

  it('pasting outside a text field still works as typed keys', () => {
    const { app, io } = setup();
    io.send(PASTE('6'));
    expect(app.stateKind).toBe('stats');
  });

  it('fits 80x24', async () => {
    const { app, io, text } = setup({ cols: 80, rows: 24 });
    expect(text()).toContain('[Q] quit');
    io.send('5');
    await app.customReady;
    expect(text()).toContain('[Esc] back');
    io.send('n');
    expect(text()).toContain('[Ctrl+S] check & save');
    expect(app.frame.length).toBeLessThanOrEqual(24);
  });
});
