import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import { DoodleMatch, doodleDef, editDistance, maskWord, normalizeGuess, type DoodleEvent } from '../src/games/multiplayer/doodle.js';
import { resolveOptions } from '../src/mp/types.js';

const P3 = [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }];

function make(over: Record<string, unknown> = {}, players = P3) {
  return new DoodleMatch({ players, rng: new Rng('dd'), options: resolveOptions(doodleDef, over), now: 0, hostId: 'a', memory: new Map() });
}

const artistOf = (m: DoodleMatch) => m.viewFor(null).artistId;
const wordOf = (m: DoodleMatch) => m.viewFor(artistOf(m)).word!;
const guessersOf = (m: DoodleMatch) => P3.map((p) => p.id).filter((id) => id !== artistOf(m));

describe('Doodle Protocol helpers', () => {
  it('normalises guesses and measures closeness', () => {
    expect(normalizeGuess('  Light-Bulb! ')).toBe('lightbulb');
    expect(editDistance('banana', 'bananna')).toBe(1);
    expect(editDistance('cat', 'elephant')).toBeGreaterThan(3);
    expect(maskWord('ice cream', new Set([1]))).toBe('_ c _   _ _ _ _ _');
  });
});

describe('Doodle Protocol match', () => {
  it('keeps the word private to the artist until the reveal', () => {
    const m = make();
    const artist = artistOf(m);
    const word = wordOf(m);
    expect(m.viewFor(artist).role).toBe('artist');
    for (const g of guessersOf(m)) {
      const v = m.viewFor(g);
      expect(v.word).toBeNull();
      expect(v.role).toBe('guesser');
      // Not hidden anywhere else in the view either (e.g. the mask).
      expect(JSON.stringify(v).toLowerCase()).not.toContain(`"${word}"`);
      expect(v.mask.replace(/[_ ]/g, '')).toBe('');
    }
    expect(m.viewFor(null).word).toBeNull();
    m.tick(80_000);
    expect(m.viewFor(guessersOf(m)[0]).phase).toBe('reveal');
    expect(m.viewFor(guessersOf(m)[0]).word).toBe(word);
  });

  it('validates drawing ops and broadcasts small deltas', () => {
    const m = make();
    m.takeEvents();
    const artist = artistOf(m);
    const g = guessersOf(m)[0];
    expect(m.handleAction(g, { kind: 'draw', ops: [[0, 0, '#']] }, 1)).toMatchObject({ code: 'NOT_ARTIST' });
    expect(m.handleAction(artist, { kind: 'draw', ops: [[30, 0, '#']] }, 1)).toMatchObject({ code: 'INVALID' });
    expect(m.handleAction(artist, { kind: 'draw', ops: [[0, 12, '#']] }, 1)).toMatchObject({ code: 'INVALID' });
    expect(m.handleAction(artist, { kind: 'draw', ops: [[0, 0, '\x1b']] }, 1)).toMatchObject({ code: 'INVALID' });
    expect(m.handleAction(artist, { kind: 'draw', ops: [[0, 0, '##']] }, 1)).toMatchObject({ code: 'INVALID' });
    expect(m.handleAction(artist, { kind: 'draw', ops: [] }, 1)).toMatchObject({ code: 'INVALID' });
    expect(m.handleAction(artist, { kind: 'draw', ops: Array(129).fill([0, 0, '#']) }, 1)).toMatchObject({ code: 'INVALID' });
    // A rejected batch changes nothing (all-or-nothing).
    expect(m.handleAction(artist, { kind: 'draw', ops: [[1, 1, '#'], [99, 1, '#']] }, 1)).toMatchObject({ ok: false });
    expect(m.canvasRows()[1][1]).toBe(' ');
    expect(m.takeEvents()).toEqual([]);

    const rev0 = m.viewFor(g).rev;
    expect(m.handleAction(artist, { kind: 'draw', ops: [[1, 1, '#'], [2, 1, '*']] }, 2)).toEqual({ ok: true });
    expect(m.canvasRows()[1].slice(0, 4)).toBe(' #* ');
    const evs = m.takeEvents();
    expect(evs).toEqual([{ to: 'all', data: { kind: 'ops', rev: rev0 + 1, ops: [[1, 1, '#'], [2, 1, '*']] } }]);
    expect(m.handleAction(artist, { kind: 'draw', ops: [[1, 1, ' ']] }, 3)).toEqual({ ok: true }); // erase
    expect(m.canvasRows()[1][1]).toBe(' ');

    // Sync gives one viewer the full canvas.
    m.takeEvents();
    m.handleAction(g, { kind: 'sync' }, 4);
    const sync = m.takeEvents();
    expect(sync).toHaveLength(1);
    expect(sync[0].to).toEqual([g]);
    const snap = sync[0].data as Extract<DoodleEvent, { kind: 'canvas' }>;
    expect(snap.rows).toHaveLength(12);
    expect(snap.rows[0]).toHaveLength(30);

    expect(m.handleAction(artist, { kind: 'clear' }, 5)).toEqual({ ok: true });
    expect(m.canvasRows().every((r) => r.trim() === '')).toBe(true);
  });

  it('scores correct guesses (first is worth more) and rewards the artist', () => {
    const m = make();
    const artist = artistOf(m);
    const [g1, g2] = guessersOf(m);
    const word = wordOf(m);
    expect(m.handleAction(artist, { kind: 'guess', text: word }, 1)).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(m.handleAction(g1, { kind: 'guess', text: 'definitely wrong' }, 1000)).toEqual({ ok: true });
    expect(m.viewFor(g2).feed.at(-1)).toMatchObject({ kind: 'guess', text: 'definitely wrong' });
    expect(m.handleAction(g1, { kind: 'guess', text: word.toUpperCase() }, 1100)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(m.handleAction(g1, { kind: 'guess', text: ` ${word.toUpperCase()}!` }, 2000)).toEqual({ ok: true });
    expect(m.viewFor(g1).youGuessed).toBe(true);
    // The correct guess is never echoed publicly.
    expect(JSON.stringify(m.viewFor(g2).feed).toLowerCase()).not.toContain(word);
    expect(m.handleAction(g1, { kind: 'guess', text: word }, 3000)).toMatchObject({ code: 'DUPLICATE' });
    expect(m.handleAction(g2, { kind: 'guess', text: word }, 40_000)).toEqual({ ok: true });
    // Everyone got it: the turn ends early.
    expect(m.viewFor(g1).phase).toBe('reveal');
    const s = Object.fromEntries(m.viewFor(null).scores.map((x) => [x.id, x.score]));
    expect(s[g1]).toBeGreaterThan(s[g2]);
    expect(s[artist]).toBe(50);
  });

  it('never echoes a guess that contains the word', () => {
    const m = make();
    const [g1, g2] = guessersOf(m);
    const word = wordOf(m);
    m.handleAction(g1, { kind: 'guess', text: `is it ${word} maybe` }, 1000);
    expect(JSON.stringify(m.viewFor(g2).feed).toLowerCase()).not.toContain(normalizeGuess(word));
    expect(m.viewFor(g1).note).toMatch(/Almost/);
  });

  it('rotates artists and ends after everyone has drawn', () => {
    const m = make({ drawTime: 45 });
    const artists = new Set<string>();
    let t = 0;
    for (let turn = 0; turn < 3; turn++) {
      artists.add(artistOf(m));
      t += 45_000;
      m.tick(t);
      expect(m.viewFor(null).phase).toBe(turn < 3 ? 'reveal' : 'over');
      t += 5000;
      m.tick(t);
    }
    expect(artists.size).toBe(3);
    expect(m.isOver()).toBe(true);
    expect(m.outcome()!.standings).toHaveLength(3);
  });

  it('skips the turn when the artist disconnects', () => {
    const m = make();
    const artist = artistOf(m);
    m.setPresence(artist, 'disconnected', 10);
    expect(m.viewFor(null).phase).toBe('reveal');
    m.tick(10 + 5000);
    expect(artistOf(m)).not.toBe(artist);
  });

  it('reveals hint letters over time but never the whole word', () => {
    const m = make();
    const g = guessersOf(m)[0];
    const hidden = (s: string) => (s.match(/_/g) ?? []).length;
    const before = hidden(m.viewFor(g).mask);
    m.tick(0.8 * 80_000);
    const after = hidden(m.viewFor(g).mask);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });
});
