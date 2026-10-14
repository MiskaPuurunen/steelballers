import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SaveStore, configDir, defaultSave, envSetting, normalizeSave } from '../src/storage/save.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-save-'));

describe('save storage', () => {
  it('returns defaults when the file is missing', () => {
    const store = new SaveStore(path.join(tmp(), 'nested', 'save.json'));
    const r = store.load();
    expect(r.data.rounds).toBe(0);
    expect(r.recoveredFrom).toBeUndefined();
  });

  it('round-trips data (creating directories)', () => {
    const store = new SaveStore(path.join(tmp(), 'a', 'b', 'save.json'));
    const d = defaultSave();
    d.rounds = 7;
    d.highScores.snake = { score: 42, at: 'x', seed: 'S' };
    expect(store.save(d)).toBe(true);
    expect(store.load().data).toEqual(d);
  });

  it('backs up a corrupted file and starts fresh', () => {
    const dir = tmp();
    const file = path.join(dir, 'save.json');
    fs.writeFileSync(file, '{"rounds": 3, oops');
    const r = new SaveStore(file).load();
    expect(r.data.rounds).toBe(0);
    expect(r.recoveredFrom).toBeDefined();
    expect(fs.readFileSync(r.recoveredFrom!, 'utf8')).toContain('oops');
  });

  it('normalizes junk values instead of crashing', () => {
    const s = normalizeSave({ rounds: 'many', xp: -5, highScores: { snake: { score: 'x' }, stack: { score: 9 } }, history: [1, { gameId: 'snake', score: 3 }], settings: { color: 'rainbow' } });
    expect(s.rounds).toBe(0);
    expect(s.xp).toBe(0);
    expect(Object.keys(s.highScores)).toEqual(['stack']);
    expect(s.history.length).toBe(1);
    expect(s.settings.color).toBe('auto');
    expect(normalizeSave(null)).toMatchObject({ rounds: 0 });
  });

  it('reset writes a fresh save', () => {
    const store = new SaveStore(path.join(tmp(), 'save.json'));
    const d = defaultSave();
    d.xp = 900;
    store.save(d);
    store.reset();
    expect(store.load().data.xp).toBe(0);
  });

  it('picks a sensible config directory per platform', () => {
    expect(configDir({ C_CADE_HOME: '/x' }, 'linux')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe(path.join('/cfg', 'c-cade'));
    expect(configDir({ APPDATA: 'C:\\Users\\m\\AppData\\Roaming' }, 'win32')).toContain('c-cade');
    expect(configDir({}, 'darwin')).toContain(path.join('Library', 'Application Support', 'c-cade'));
  });

  it('copies the pre-rename "vibebreak" folder once, leaving the old one in place', () => {
    const cfg = tmp();
    fs.mkdirSync(path.join(cfg, 'vibebreak', 'games'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'vibebreak', 'save.json'), '{"xp":42}');
    fs.writeFileSync(path.join(cfg, 'vibebreak', 'games', 'mine.lua'), '-- mine');
    const dir = configDir({ XDG_CONFIG_HOME: cfg }, 'linux');
    expect(dir).toBe(path.join(cfg, 'c-cade'));
    expect(fs.readFileSync(path.join(dir, 'save.json'), 'utf8')).toBe('{"xp":42}');
    expect(fs.existsSync(path.join(dir, 'games', 'mine.lua'))).toBe(true);
    expect(fs.existsSync(path.join(cfg, 'vibebreak', 'save.json'))).toBe(true);
    // Once the new folder exists, the old one is never read again.
    fs.writeFileSync(path.join(cfg, 'vibebreak', 'save.json'), '{"xp":1}');
    configDir({ XDG_CONFIG_HOME: cfg }, 'linux');
    expect(fs.readFileSync(path.join(dir, 'save.json'), 'utf8')).toBe('{"xp":42}');
  });

  it('reads C_CADE_* settings, falling back to the old VIBEBREAK_* names', () => {
    expect(envSetting({ C_CADE_HOME: '/new', VIBEBREAK_HOME: '/old' }, 'HOME')).toBe('/new');
    expect(envSetting({ VIBEBREAK_HOME: '/old' }, 'HOME')).toBe('/old');
    expect(envSetting({}, 'HOME')).toBeUndefined();
    expect(configDir({ VIBEBREAK_HOME: '/old' }, 'linux')).toBe('/old');
  });
});
