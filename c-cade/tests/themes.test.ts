import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEMES, SEASONAL, activeTheme, applyTheme, isThemeId, overlayParticles, particleCells, resolveTheme, seasonalTheme, themeIds, themedRule,
} from '../src/ui/themes.js';
import { paint, setColor, setColorDepth, stripAnsi, theme, visibleWidth } from '../src/ui/style.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore, normalizeSave } from '../src/storage/save.js';
import { parseArgs } from '../src/cli/args.js';
import { FakeScheduler } from './helpers.js';

afterEach(() => {
  setColor(false);
  setColorDepth(16);
  applyTheme(THEMES[0]);
});

describe('theme definitions', () => {
  it('every theme is complete and uses valid colour codes and single-column glyphs', () => {
    const valid16 = (n: number) => (n >= 30 && n <= 37) || (n >= 90 && n <= 97);
    for (const t of THEMES) {
      const paints = [
        ...Object.values(t.palette), ...t.logo.left, ...t.logo.right, t.logo.shine, ...t.rule.colors,
        ...(t.particles ?? []).flatMap((p) => p.colors),
      ];
      for (const p of paints) {
        expect(valid16(p.c16), `${t.id} c16 ${p.c16}`).toBe(true);
        if (p.c256 !== undefined) expect(p.c256 >= 0 && p.c256 <= 255).toBe(true);
      }
      expect(Object.keys(t.palette).sort()).toEqual(['accent', 'bad', 'gold', 'good', 'muted', 'primary']);
      expect(t.rule.pattern.length).toBeGreaterThan(0);
      for (const ch of [...t.rule.pattern, ...(t.particles ?? []).flatMap((p) => p.chars)]) expect(ch).toMatch(/^[\x20-\x7e]$/);
      expect(t.tagline.length).toBeLessThanOrEqual(60);
    }
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it('includes the requested themes', () => {
    for (const id of ['classic', 'christmas', 'halloween', 'frutiger-aero']) expect(isThemeId(id)).toBe(true);
    expect(themeIds()).toContain(SEASONAL);
  });

  it('seasonal follows the calendar; unknown ids fall back to classic', () => {
    expect(seasonalTheme(new Date(2026, 11, 24))).toBe('christmas');
    expect(seasonalTheme(new Date(2026, 9, 31))).toBe('halloween');
    expect(seasonalTheme(new Date(2026, 10, 1))).toBe('halloween');
    expect(seasonalTheme(new Date(2026, 9, 10))).toBe('classic');
    expect(seasonalTheme(new Date(2026, 6, 4))).toBe('classic');
    expect(resolveTheme(SEASONAL, new Date(2026, 11, 1)).id).toBe('christmas');
    expect(resolveTheme('nope').id).toBe('classic');
    expect(resolveTheme(undefined).id).toBe('classic');
  });
});

describe('colour handling', () => {
  it('uses 256-colour shades only when supported, 16-colour otherwise, nothing without colour', () => {
    const p = { c16: 33, c256: 208 };
    setColor(true);
    expect(paint(p)('x')).toBe('\x1b[33mx\x1b[39m');
    setColorDepth(256);
    expect(paint(p)('x')).toBe('\x1b[38;5;208mx\x1b[39m');
    expect(paint({ ...p, bold: true })('x')).toBe('\x1b[1;38;5;208mx\x1b[22;39m');
    setColor(false);
    expect(paint(p)('x')).toBe('x');
  });

  it('classic reproduces the original palette exactly', () => {
    setColor(true);
    applyTheme(resolveTheme('classic'));
    expect(theme.primary('x')).toBe('\x1b[96mx\x1b[39m');
    expect(theme.muted('x')).toBe('\x1b[90mx\x1b[39m');
    expect(themedRule(3)).toBe('\x1b[90m---\x1b[39m');
  });

  it('applying a theme swaps the shared palette in place', () => {
    setColor(true);
    setColorDepth(256);
    applyTheme(resolveTheme('halloween'));
    expect(activeTheme().id).toBe('halloween');
    expect(theme.primary('x')).toBe('\x1b[38;5;208mx\x1b[39m');
  });

  it('themed rules have the requested width and animate where intended', () => {
    for (const t of THEMES) expect(stripAnsi(themedRule(37, 0, t))).toHaveLength(37);
    setColor(true);
    const xmas = resolveTheme('christmas');
    expect(themedRule(20, 0, xmas)).not.toBe(themedRule(20, 500, xmas));
  });
});

describe('particles', () => {
  it('are deterministic, in bounds and move over time', () => {
    for (const t of THEMES.filter((x) => x.particles)) {
      const a = particleCells(t.particles!, 80, 24, 1234);
      expect(particleCells(t.particles!, 80, 24, 1234)).toEqual(a);
      expect(a.size).toBeGreaterThan(0);
      for (const k of a.keys()) {
        const [x, y] = k.split(',').map(Number);
        expect(x >= 0 && x < 80 && y >= 0 && y < 24).toBe(true);
      }
      const later = particleCells(t.particles!, 80, 24, 3234);
      expect([...later.keys()]).not.toEqual([...a.keys()]);
    }
  });

  it('never cover content and keep a clear margin around it', () => {
    const lines = ['', '      HELLO WORLD', '      short', '', ''];
    const cells = new Map<string, string>();
    for (let y = 0; y < 5; y++) for (let x = 0; x < 30; x++) cells.set(`${x},${y}`, '*');
    const out = overlayParticles(lines, cells, 30, 5);
    expect(out[1].slice(6, 17)).toBe('HELLO WORLD');
    expect(out[2].slice(6, 11)).toBe('short');
    // The gap after "short" (inside the block) stays empty.
    expect(out[2].slice(11, 19).trim()).toBe('');
    // Outside the block, particles appear.
    expect(out[4]).toContain('*');
    expect(out[1].slice(0, 3)).toBe('***');
    for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
  });
});

describe('theme setting and the THEMES screen', () => {
  function setup(cols = 100, rows = 34) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-theme-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    const io = new FakeTerminal(cols, rows);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, start: { mode: 'menu' }, scheduler: sched });
    void app.run();
    const text = () => app.frame.map(stripAnsi).join('\n');
    /** Settings > Theme opens the theme browser. */
    const openThemes = () => {
      io.send('8');
      io.send('\x1b[B'); // Theme
      sched.advance(200); // menus ignore a second Enter within 150ms
      io.send('\r');
    };
    return { app, io, sched, store, text, openThemes };
  }

  it('old saves get the classic theme with animations on; junk is rejected', () => {
    const base = { version: 1, settings: { color: 'auto' } };
    expect(normalizeSave(base).settings).toEqual({ color: 'auto', theme: 'classic', animations: true, interface: 'auto' });
    expect(normalizeSave({ ...base, settings: { theme: '../../etc', animations: 'yes' } }).settings).toMatchObject({ theme: 'classic', animations: true });
    expect(normalizeSave({ ...base, settings: { theme: 'halloween', animations: false } }).settings).toMatchObject({ theme: 'halloween', animations: false });
  });

  it('previews live, Esc reverts, Enter saves', () => {
    const { app, io, sched, store, text, openThemes } = setup();
    openThemes();
    expect(app.stateKind).toBe('themes');
    expect(text()).toContain('Frutiger Aero');
    io.send('\x1b[B'); // Christmas
    expect(activeTheme().id).toBe('christmas');
    expect(text()).toContain('Candy-cane logo');
    io.send('\x1b');
    expect(app.stateKind).toBe('settings');
    expect(activeTheme().id).toBe('classic');
    expect(store.load().data.settings.theme).toBe('classic');

    io.send('\x1b'); // back to the menu
    openThemes();
    io.send('4'); // Frutiger Aero
    sched.advance(200);
    io.send('\r');
    expect(app.stateKind).toBe('settings');
    expect(text()).toContain('Theme set: Frutiger Aero');
    expect(activeTheme().id).toBe('frutiger-aero');
    expect(store.load().data.settings.theme).toBe('frutiger-aero');
    io.send('\x1b'); // the menu wears the new theme
    expect(text()).toContain('SYNCING TO THE CLOUD');
  });

  it('A toggles ambient animation and persists it', () => {
    const { io, store, openThemes } = setup();
    openThemes();
    io.send('a');
    expect(store.load().data.settings.animations).toBe(false);
    io.send('a');
    expect(store.load().data.settings.animations).toBe(true);
  });

  it('a --theme override is used for the run but not saved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-theme-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    new App({ io: new FakeTerminal(100, 34), store, save: store.load().data, start: { mode: 'menu' }, scheduler: new FakeScheduler(), themeOverride: 'matrix' });
    expect(activeTheme().id).toBe('matrix');
    expect(store.load().data.settings.theme).toBe('classic');
    expect(parseArgs(['--theme', 'matrix']).theme).toBe('matrix');
    expect(parseArgs(['theme', 'halloween'])).toMatchObject({ command: 'theme', rest: ['halloween'] });
  });

  it('every theme fits 80x24 on every menu screen, and never decorates the game board', () => {
    for (const t of THEMES) {
      const { app, io, sched } = setup(80, 24);
      applyTheme(t);
      for (const keys of [[], ['5'], ['\x1b', '2']]) {
        for (const k of keys) io.send(k);
        sched.advance(700);
        for (const l of app.frame) expect(visibleWidth(l), `${t.id}`).toBeLessThanOrEqual(80);
        expect(app.frame.map(stripAnsi).join('\n')).toMatch(/\[Esc\]|\[Q\]/);
      }
    }
    // Same seed, same moment: the playing frame is identical with animations on or off.
    const frames = [true, false].map((anim) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-theme-'));
      const store = new SaveStore(path.join(dir, 'save.json'));
      const save = store.load().data;
      save.settings.animations = anim;
      const sched = new FakeScheduler();
      const app = new App({ io: new FakeTerminal(100, 34), store, save, start: { mode: 'play', session: { gameId: 'stack', seed: 'TH-1' } }, scheduler: sched, themeOverride: 'christmas' });
      void app.run();
      sched.advance(4500);
      return app.frame.map(stripAnsi).join('\n');
    });
    expect(frames[0]).toBe(frames[1]);
  });
});
