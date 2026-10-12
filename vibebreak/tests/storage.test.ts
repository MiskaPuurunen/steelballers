import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SaveStore, configDir, defaultSave, normalizeSave } from '../src/storage/save.js';

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
    expect(configDir({ VIBEBREAK_HOME: '/x' }, 'linux')).toBe('/x');
    expect(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe(path.join('/cfg', 'vibebreak'));
    expect(configDir({ APPDATA: 'C:\\Users\\m\\AppData\\Roaming' }, 'win32')).toContain('vibebreak');
    expect(configDir({}, 'darwin')).toContain(path.join('Library', 'Application Support', 'vibebreak'));
  });
});
