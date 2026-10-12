import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import { PromptPanicMatch, promptPanicDef, normalizeAnswer, ANSWER_BONUS, VOTE_POINTS, SWEEP_BONUS } from '../src/games/multiplayer/prompt-panic.js';
import { BUILTIN_PROMPTS, CATEGORIES, selectPrompts, validatePack } from '../src/games/multiplayer/prompts.js';
import { containsSlur, maskText } from '../src/games/multiplayer/moderation.js';
import { resolveOptions } from '../src/mp/types.js';

const P3 = [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }];

function make(over: Record<string, unknown> = {}, players = P3, hostId = 'a', memory = new Map<string, unknown>()) {
  return new PromptPanicMatch({
    players,
    rng: new Rng('pp'),
    options: resolveOptions(promptPanicDef, { rounds: 3, ...over }),
    now: 0,
    hostId,
    memory,
  });
}

const keyOf = (m: PromptPanicMatch, viewer: string, author: string) =>
  m.viewFor(viewer).entries!.find((e) => e.text === `answer from ${author}`)!.key;

function answerAll(m: PromptPanicMatch, ids = ['a', 'b', 'c'], t = 1) {
  for (const id of ids) expect(m.handleAction(id, { kind: 'answer', text: `answer from ${id}` }, t)).toEqual({ ok: true });
}

describe('Prompt library', () => {
  it('has a large original library across all categories', () => {
    expect(BUILTIN_PROMPTS.length).toBeGreaterThanOrEqual(150);
    for (const c of CATEGORIES) expect(BUILTIN_PROMPTS.filter((p) => p.category === c.id).length).toBeGreaterThanOrEqual(18);
    expect(new Set(BUILTIN_PROMPTS.map((p) => p.text)).size).toBe(BUILTIN_PROMPTS.length);
    for (const p of BUILTIN_PROMPTS) expect(maskText(p.text, true).masked).toBe(false);
  });

  it('seeded selection is reproducible, distinct and honours the category', () => {
    const opts = { category: 'debugging', absurdity: 'mixed' as const, deck: 'built-in' as const, avoid: new Set<string>() };
    const a = selectPrompts(new Rng('s'), 5, opts);
    expect(a).toEqual(selectPrompts(new Rng('s'), 5, opts));
    expect(new Set(a.map((p) => p.id)).size).toBe(5);
    expect(a.every((p) => p.category === 'debugging')).toBe(true);
    // Mixed absurdity ramps up.
    expect(a[0].absurdity).toBeLessThanOrEqual(a[4].absurdity);
  });

  it('avoids prompts already used and widens the pool when needed', () => {
    const avoid = new Set(BUILTIN_PROMPTS.filter((p) => p.category === 'party').slice(0, 15).map((p) => p.id));
    const got = selectPrompts(new Rng('w'), 8, { category: 'party', absurdity: 'unhinged', deck: 'built-in', avoid });
    expect(got).toHaveLength(8);
    expect(got.some((p) => avoid.has(p.id))).toBe(false);
  });

  it('validates custom packs', () => {
    const r = validatePack({
      name: 'Office \x1b[31mParty',
      prompts: [
        'The worst thing to find in the office fridge today.',
        { text: 'Name a meeting that should be illegal.', category: 'workplace', absurdity: 3 },
        'short',
        'The worst thing to find in the office fridge today.',
        { text: 'A rule for the \x1b[2J break room microwave.' },
        42,
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.name).toBe('Office [31mParty');
    expect(r.prompts.map((p) => p.text)).toEqual([
      'The worst thing to find in the office fridge today.',
      'Name a meeting that should be illegal.',
      'A rule for the [2J break room microwave.',
    ]);
    expect(r.prompts[1]).toMatchObject({ category: 'workplace', absurdity: 3 });
    expect(r.warnings.length).toBe(3);
    expect(validatePack({ prompts: [] }).errors.length).toBe(1);
    expect(validatePack([]).errors.length).toBe(1);
  });
});

describe('Moderation', () => {
  it('masks profanity with the family filter and slurs always', () => {
    expect(maskText('what the fuck', true)).toEqual({ text: 'what the ****', masked: true });
    expect(maskText('what the fuck', false).masked).toBe(false);
    expect(maskText('sh1t happens', true).text).toBe('**** happens');
    expect(containsSlur('a spicy cocktail in Scunthorpe for the fire retardant crew')).toBe(false);
    expect(maskText('a spicy cocktail in Scunthorpe', true).masked).toBe(false);
  });
});

describe('Prompt Panic match', () => {
  it('collects answers, then opens anonymous voting', () => {
    const m = make();
    expect(m.viewFor('a').phase).toBe('answer');
    answerAll(m);
    const v = m.viewFor('a');
    expect(v.phase).toBe('vote');
    expect(v.entries).toHaveLength(3);
    expect(v.entries!.filter((e) => e.yours)).toHaveLength(1);
    // Nobody can see authors during voting.
    expect(JSON.stringify(m.viewFor('b'))).not.toMatch(/"authors"/);
    expect(m.viewFor(null).entries!.every((e) => !e.yours)).toBe(true);
  });

  it('rejects duplicate answers, empty answers and late answers', () => {
    const m = make();
    expect(m.handleAction('a', { kind: 'answer', text: '   ' }, 1)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(m.handleAction('a', { kind: 'answer', text: 'hi' }, 1)).toEqual({ ok: true });
    expect(m.handleAction('a', { kind: 'answer', text: 'again' }, 1)).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(m.handleAction('z', { kind: 'answer', text: 'intruder' }, 1)).toMatchObject({ ok: false, code: 'NOT_PLAYING' });
    m.handleAction('b', { kind: 'answer', text: 'yo' }, 1);
    m.tick(60_000);
    expect(m.viewFor('a').phase).toBe('vote');
    expect(m.handleAction('b', { kind: 'answer', text: 'late' }, 60_001)).toMatchObject({ ok: false, code: 'PHASE' });
  });

  it('strips escape sequences and caps answer length', () => {
    const m = make();
    m.handleAction('a', { kind: 'answer', text: '\x1b[2J\x1b]0;pwned\x07hello' + 'x'.repeat(500) }, 1);
    const ans = m.viewFor('a').yourAnswer!;
    expect(ans).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(ans.startsWith('[2J]0;pwnedhello')).toBe(true);
    expect([...ans].length).toBe(120);
  });

  it('prevents self-votes and double votes; scores are computed by the server', () => {
    const m = make();
    answerAll(m);
    const own = keyOf(m, 'a', 'a');
    expect(m.handleAction('a', { kind: 'vote', key: own }, 2)).toMatchObject({ ok: false, code: 'SELF_VOTE' });
    expect(m.handleAction('a', { kind: 'vote', key: 'Z' }, 2)).toMatchObject({ ok: false, code: 'INVALID' });
    const bKey = keyOf(m, 'a', 'b');
    expect(m.handleAction('a', { kind: 'vote', key: bKey }, 2)).toEqual({ ok: true });
    expect(m.handleAction('a', { kind: 'vote', key: keyOf(m, 'a', 'c') }, 2)).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(m.handleAction('c', { kind: 'vote', key: bKey }, 2)).toEqual({ ok: true });
    expect(m.handleAction('b', { kind: 'vote', key: keyOf(m, 'b', 'a') }, 2)).toEqual({ ok: true });
    const v = m.viewFor('a');
    expect(v.phase).toBe('reveal');
    const scores = Object.fromEntries(v.scores.map((s) => [s.id, s.score]));
    // b: 2 votes, both votes cast for b? No: a also got 1, so no sweep.
    expect(scores.b).toBe(2 * VOTE_POINTS + ANSWER_BONUS);
    expect(scores.a).toBe(VOTE_POINTS + ANSWER_BONUS);
    expect(scores.c).toBe(ANSWER_BONUS);
    expect(v.results![0]).toMatchObject({ authors: ['Bob'], votes: 2 });
    // Clients cannot set scores: there is no action for it.
    expect(m.handleAction('a', { kind: 'score', points: 9999 }, 3)).toMatchObject({ ok: false });
  });

  it('clean sweep bonus, final round double points, and the final standings', () => {
    const m = make({ rounds: 3 });
    for (let round = 0; round < 3; round++) {
      answerAll(m, ['a', 'b', 'c'], round * 100);
      const target = keyOf(m, 'b', 'a');
      m.handleAction('b', { kind: 'vote', key: target }, round * 100 + 1);
      m.handleAction('c', { kind: 'vote', key: target }, round * 100 + 1);
      m.handleAction('a', { kind: 'vote', key: keyOf(m, 'a', 'b') }, round * 100 + 1);
      expect(m.viewFor('a').phase).toBe('reveal');
      m.tick(round * 100 + 20_000);
    }
    expect(m.isOver()).toBe(true);
    const out = m.outcome()!;
    expect(out.standings[0]).toMatchObject({ playerId: 'a', rank: 1 });
    // a: 2 votes per round (no sweep: b got one too), x2 in the final round.
    expect(out.standings[0].score).toBe((2 * VOTE_POINTS + ANSWER_BONUS) * 2 + (2 * VOTE_POINTS * 2 + ANSWER_BONUS));
    expect(out.stats!.a).toMatchObject({ answers: 3, votesReceived: 6, won: 1 });
    expect(SWEEP_BONUS).toBeGreaterThan(0);
  });

  it('awards a clean sweep when every vote goes to one answer', () => {
    const m = make({}, [...P3, { id: 'd', name: 'Di' }]);
    answerAll(m, ['a', 'b', 'c', 'd']);
    const k = keyOf(m, 'b', 'a');
    for (const id of ['b', 'c', 'd']) m.handleAction(id, { kind: 'vote', key: k }, 2);
    m.handleAction('a', { kind: 'vote', key: keyOf(m, 'a', 'b') }, 2);
    const row = m.viewFor('a').results!.find((r) => r.authors.includes('Ada'))!;
    expect(row).toMatchObject({ votes: 3, sweep: false });
    // With b voting for a too, a gets every vote cast except a's own:
    const m2 = make();
    answerAll(m2);
    const k2 = keyOf(m2, 'b', 'a');
    m2.handleAction('b', { kind: 'vote', key: k2 }, 2);
    m2.handleAction('c', { kind: 'vote', key: k2 }, 2);
    m2.tick(30_001 + 60_000);
    const r2 = m2.viewFor('a').results!.find((r) => r.authors.includes('Ada'))!;
    expect(r2).toMatchObject({ votes: 2, sweep: true, points: 2 * VOTE_POINTS + ANSWER_BONUS + SWEEP_BONUS });
  });

  it('merges identical answers and credits every author', () => {
    const m = make();
    m.handleAction('a', { kind: 'answer', text: 'Banana!' }, 1);
    m.handleAction('b', { kind: 'answer', text: 'banana' }, 1);
    m.handleAction('c', { kind: 'answer', text: 'kiwi' }, 1);
    const v = m.viewFor('c');
    expect(v.entries).toHaveLength(2);
    const banana = v.entries!.find((e) => normalizeAnswer(e.text) === 'banana')!;
    // Both authors are blocked from voting for their shared answer.
    expect(m.handleAction('a', { kind: 'vote', key: banana.key }, 2)).toMatchObject({ code: 'SELF_VOTE' });
    m.handleAction('c', { kind: 'vote', key: banana.key }, 2);
    expect(m.viewFor('a').phase).toBe('vote');
    // The JINX authors can still vote for the other answer.
    const kiwi = v.entries!.find((e) => e.key !== banana.key)!.key;
    m.handleAction('a', { kind: 'vote', key: kiwi }, 2);
    m.handleAction('b', { kind: 'vote', key: kiwi }, 2);
    expect(m.viewFor('a').phase).toBe('reveal');
    const row = m.viewFor('a').results!.find((r) => r.jinx)!;
    expect(row.authors.sort()).toEqual(['Ada', 'Bob']);
    const scores = Object.fromEntries(m.viewFor('a').scores.map((s) => [s.id, s.score]));
    expect(scores.a).toBe(scores.b);
    expect(scores.a).toBe(VOTE_POINTS + ANSWER_BONUS);
  });

  it('handles players who do not answer, and timers drive the phases', () => {
    const m = make();
    m.handleAction('a', { kind: 'answer', text: 'one' }, 1);
    m.handleAction('b', { kind: 'answer', text: 'two' }, 1);
    m.tick(59_999);
    expect(m.viewFor('a').phase).toBe('answer');
    m.tick(60_000);
    const v = m.viewFor('c');
    expect(v.phase).toBe('vote');
    expect(v.entries).toHaveLength(2);
    // c did not answer but may still vote.
    expect(m.handleAction('c', { kind: 'vote', key: v.entries![0].key }, 60_001)).toEqual({ ok: true });
    m.tick(60_000 + 30_000);
    expect(m.viewFor('a').phase).toBe('reveal');
    m.tick(60_000 + 30_000 + 10_000);
    expect(m.viewFor('a')).toMatchObject({ phase: 'answer', round: 2 });
  });

  it('skips voting when fewer than two answers arrive', () => {
    const m = make();
    m.handleAction('a', { kind: 'answer', text: 'lonely' }, 1);
    m.tick(60_000);
    expect(m.viewFor('a')).toMatchObject({ phase: 'reveal', note: /Only one answer/ });
  });

  it('host can skip ahead and veto an answer; others cannot', () => {
    const m = make();
    expect(m.handleAction('b', { kind: 'advance' }, 1)).toMatchObject({ code: 'NOT_HOST' });
    answerAll(m);
    const bad = keyOf(m, 'a', 'c');
    m.handleAction('b', { kind: 'vote', key: bad }, 2);
    expect(m.handleAction('b', { kind: 'veto', key: bad }, 2)).toMatchObject({ code: 'NOT_HOST' });
    expect(m.handleAction('a', { kind: 'veto', key: bad }, 2)).toEqual({ ok: true });
    // b's vote was returned.
    expect(m.viewFor('b').yourVote).toBeNull();
    expect(m.viewFor('b').entries!.some((e) => e.key === bad)).toBe(false);
    expect(m.handleAction('a', { kind: 'advance' }, 3)).toEqual({ ok: true });
    const row = m.viewFor('a').results!.find((r) => r.key === bad)!;
    expect(row).toMatchObject({ text: '(removed by host)', points: 0 });
  });

  it('does not wait for disconnected players and ends if too few remain', () => {
    const m = make();
    m.handleAction('a', { kind: 'answer', text: 'x' }, 1);
    m.handleAction('b', { kind: 'answer', text: 'y' }, 1);
    m.setPresence('c', 'disconnected', 2);
    expect(m.viewFor('a').phase).toBe('vote');
    m.setPresence('c', 'gone', 3);
    m.setPresence('b', 'gone', 4);
    expect(m.isOver()).toBe(true);
    expect(m.outcome()).toMatchObject({ incomplete: true });
  });

  it('does not repeat prompts across rematches in the same lobby', () => {
    const memory = new Map<string, unknown>();
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const m = new PromptPanicMatch({ players: P3, rng: new Rng(`r${i}`), options: resolveOptions(promptPanicDef, { rounds: 8 }), now: 0, hostId: 'a', memory });
      for (let r = 0; r < 8; r++) {
        const p = m.viewFor('a').prompt;
        expect(seen.has(p)).toBe(false);
        seen.add(p);
        m.handleAction('a', { kind: 'advance' }, 0); // no answers: straight to the reveal
        m.handleAction('a', { kind: 'advance' }, 0); // next round
      }
    }
  });
});
