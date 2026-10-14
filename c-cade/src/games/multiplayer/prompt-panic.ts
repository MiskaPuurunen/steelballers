import type { Rng } from '../../core/rng.js';
import { cleanText } from '../../net/sanitize.js';
import {
  isObj, ok, rankStandings, reject,
  type ActionResult, type MatchContext, type MatchOutcome, type MpEvent, type MpGameDefinition, type MpMatch, type MpPlayer, type Presence,
} from '../../mp/types.js';
import { maskText } from './moderation.js';
import { ABSURDITY_LABEL, CATEGORIES, TWISTS, selectPrompts, type Prompt, type SelectOptions } from './prompts.js';

/**
 * Prompt Panic: everyone answers the same strange prompt, answers are
 * shuffled and shown anonymously, everyone votes for their favourite
 * (never their own), and votes become points.
 *
 * Scoring (shown in the game):
 *   +100 per vote your answer receives (x2 in the final round)
 *   +25  for submitting an answer
 *   +100 clean sweep: every vote cast went to your answer (min. 2 votes)
 * Identical answers are merged ("JINX!") and every author gets the votes.
 */

export const ANSWER_MAX = 120;
export const VOTE_POINTS = 100;
export const ANSWER_BONUS = 25;
export const SWEEP_BONUS = 100;

type PpPhase = 'answer' | 'vote' | 'reveal' | 'final';

interface Entry {
  key: string;
  text: string;
  authors: string[];
  vetoed: boolean;
}

interface PpResultRow {
  key: string;
  text: string;
  authors: string[];
  votes: number;
  points: number;
  sweep: boolean;
  jinx: boolean;
}

export interface PromptPanicView {
  phase: PpPhase;
  round: number;
  rounds: number;
  prompt: string;
  category: string;
  absurdity: string;
  twist: string | null;
  multiplier: number;
  deadline: number | null;
  players: Array<{ id: string; name: string; connected: boolean; answered: boolean; voted: boolean }>;
  /** Viewer's own answer this round. */
  yourAnswer: string | null;
  /** Vote phase: anonymous entries. `yours` is only ever true in your own view. */
  entries: Array<{ key: string; text: string; yours: boolean }> | null;
  yourVote: string | null;
  /** Reveal/final: authors and points. */
  results: PpResultRow[] | null;
  scores: Array<{ id: string; name: string; score: number }>;
  note: string | null;
  isHost: boolean;
}

/** Normalised form used to detect duplicate answers. */
export function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class PromptPanicMatch implements MpMatch {
  private readonly players: MpPlayer[];
  private readonly connected = new Map<string, boolean>();
  private readonly gone = new Set<string>();
  private readonly scores = new Map<string, number>();
  private readonly prompts: Prompt[];
  private readonly twists: Array<string | null>;
  private readonly rng: Rng;
  private readonly answerMs: number;
  private readonly voteMs: number;
  private readonly revealMs: number;
  private readonly family: boolean;
  private readonly hostId: string | undefined;
  private readonly stats = new Map<string, { answers: number; votesReceived: number; sweeps: number }>();

  private phase: PpPhase = 'answer';
  private round = 0;
  private deadline: number | null = null;
  private answers = new Map<string, string>();
  private entries: Entry[] = [];
  private votes = new Map<string, string>();
  private results: PpResultRow[] | null = null;
  private note: string | null = null;
  private aborted: string | null = null;

  constructor(ctx: MatchContext) {
    this.players = ctx.players;
    this.rng = ctx.rng;
    this.hostId = ctx.hostId;
    for (const p of ctx.players) {
      this.connected.set(p.id, true);
      this.scores.set(p.id, 0);
      this.stats.set(p.id, { answers: 0, votesReceived: 0, sweeps: 0 });
    }
    const rounds = Number(ctx.options.rounds);
    this.answerMs = Number(ctx.options.answerTime) * 1000;
    this.voteMs = Number(ctx.options.voteTime) * 1000;
    this.revealMs = Number(ctx.options.revealTime) * 1000;
    this.family = ctx.options.familyFilter !== 'off';

    // Remember used prompts across rematches in this lobby so they do not repeat.
    let used = ctx.memory.get('prompt-panic:used') as Set<string> | undefined;
    if (!used) ctx.memory.set('prompt-panic:used', (used = new Set()));
    const sel: SelectOptions = {
      category: String(ctx.options.category),
      absurdity: String(ctx.options.absurdity) as SelectOptions['absurdity'],
      deck: String(ctx.options.deck) as SelectOptions['deck'],
      avoid: used,
      custom: ctx.content?.prompts ?? [],
    };
    this.prompts = selectPrompts(ctx.rng.fork('prompts'), rounds, sel);
    for (const p of this.prompts) used.add(p.id);
    if (used.size > 120) used.clear();
    const twistRng = ctx.rng.fork('twists');
    this.twists = this.prompts.map((p) => {
      const chance = p.absurdity === 1 ? 0.15 : p.absurdity === 2 ? 0.35 : 0.6;
      if (!twistRng.chance(chance)) return null;
      const pool = TWISTS.filter((t) => t.absurdity <= p.absurdity);
      return twistRng.pick(pool).text;
    });
    this.startRound(ctx.now);
  }

  private get rounds(): number {
    return this.prompts.length;
  }

  private active(): MpPlayer[] {
    return this.players.filter((p) => !this.gone.has(p.id));
  }

  /** Players we still wait for: connected and not gone. */
  private waitingOn(): MpPlayer[] {
    return this.active().filter((p) => this.connected.get(p.id));
  }

  private name(id: string): string {
    return this.players.find((p) => p.id === id)?.name ?? '?';
  }

  private startRound(now: number): void {
    this.phase = 'answer';
    this.answers = new Map();
    this.entries = [];
    this.votes = new Map();
    this.results = null;
    this.note = null;
    this.deadline = now + this.answerMs;
  }

  private multiplier(): number {
    return this.round === this.rounds - 1 && this.rounds > 1 ? 2 : 1;
  }

  handleAction(playerId: string, action: unknown, now: number): ActionResult {
    if (!isObj(action)) return reject('INVALID', 'Invalid action');
    if (this.phase === 'final') return reject('PHASE', 'The game is over');
    const isHost = playerId === this.hostId;
    const playing = this.players.some((p) => p.id === playerId) && !this.gone.has(playerId);

    switch (action.kind) {
      case 'answer': {
        if (!playing) return reject('NOT_PLAYING', 'You are not playing in this match');
        if (this.phase !== 'answer') return reject('PHASE', 'Answers are closed');
        if (this.answers.has(playerId)) return reject('DUPLICATE', 'You already answered');
        const text = cleanText(action.text, ANSWER_MAX);
        if (!text) return reject('INVALID', 'Your answer is empty');
        this.answers.set(playerId, maskText(text, this.family).text);
        this.stats.get(playerId)!.answers++;
        if (this.waitingOn().every((p) => this.answers.has(p.id))) this.toVote(now);
        return ok;
      }
      case 'vote': {
        if (!playing) return reject('NOT_PLAYING', 'You are not playing in this match');
        if (this.phase !== 'vote') return reject('PHASE', 'Voting is not open');
        if (this.votes.has(playerId)) return reject('DUPLICATE', 'You already voted');
        const entry = this.entries.find((e) => e.key === action.key && !e.vetoed);
        if (!entry) return reject('INVALID', 'No such answer');
        if (entry.authors.includes(playerId)) return reject('SELF_VOTE', "You can't vote for your own answer");
        this.votes.set(playerId, entry.key);
        if (this.eligibleVoters().every((p) => this.votes.has(p.id))) this.toReveal(now);
        return ok;
      }
      case 'advance': {
        if (!isHost) return reject('NOT_HOST', 'Only the host can skip ahead');
        if (this.phase === 'answer') this.toVote(now);
        else if (this.phase === 'vote') this.toReveal(now);
        else if (this.phase === 'reveal') this.nextRound(now);
        return ok;
      }
      case 'veto': {
        if (!isHost) return reject('NOT_HOST', 'Only the host can remove answers');
        if (this.phase !== 'vote') return reject('PHASE', 'Answers can only be removed during voting');
        const entry = this.entries.find((e) => e.key === action.key && !e.vetoed);
        if (!entry) return reject('INVALID', 'No such answer');
        entry.vetoed = true;
        // Votes for a removed answer are returned so those players can vote again.
        for (const [voter, key] of [...this.votes]) if (key === entry.key) this.votes.delete(voter);
        this.note = `Answer ${entry.key} was removed by the host.`;
        if (this.liveEntries().length < 2) this.toReveal(now);
        return ok;
      }
      default:
        return reject('INVALID', 'Unknown action');
    }
  }

  private liveEntries(): Entry[] {
    return this.entries.filter((e) => !e.vetoed);
  }

  /** Connected players who have at least one entry they may vote for. */
  private eligibleVoters(): MpPlayer[] {
    return this.waitingOn().filter((p) => this.liveEntries().some((e) => !e.authors.includes(p.id)));
  }

  private toVote(now: number): void {
    // Merge identical answers; shuffle so order reveals nothing about who answered first.
    const byNorm = new Map<string, Entry>();
    for (const [pid, text] of this.answers) {
      const n = normalizeAnswer(text);
      const existing = byNorm.get(n);
      if (existing) existing.authors.push(pid);
      else byNorm.set(n, { key: '', text, authors: [pid], vetoed: false });
    }
    this.entries = this.rng.shuffle([...byNorm.values()]).map((e, i) => ({ ...e, key: String.fromCharCode(65 + i) }));
    if (this.entries.length < 2 || this.eligibleVoters().length === 0) {
      this.note = this.entries.length === 0 ? 'Nobody answered this one.' : this.entries.length === 1 ? 'Only one answer: no vote needed.' : null;
      this.toReveal(now);
      return;
    }
    this.phase = 'vote';
    this.deadline = now + this.voteMs;
  }

  private toReveal(now: number): void {
    const mult = this.multiplier();
    const live = this.liveEntries();
    const tally = new Map<string, number>();
    for (const key of this.votes.values()) tally.set(key, (tally.get(key) ?? 0) + 1);
    const totalVotes = [...tally.values()].reduce((a, b) => a + b, 0);
    const rows: PpResultRow[] = this.entries.map((e) => {
      const votes = e.vetoed ? 0 : tally.get(e.key) ?? 0;
      const sweep = !e.vetoed && votes >= 2 && votes === totalVotes;
      const each = e.vetoed ? 0 : votes * VOTE_POINTS * mult + ANSWER_BONUS + (sweep ? SWEEP_BONUS * mult : 0);
      for (const a of e.authors) {
        this.scores.set(a, (this.scores.get(a) ?? 0) + each);
        const st = this.stats.get(a)!;
        st.votesReceived += votes;
        if (sweep) st.sweeps++;
      }
      return { key: e.key, text: e.vetoed ? '(removed by host)' : e.text, authors: e.authors.map((a) => this.name(a)), votes, points: each, sweep, jinx: e.authors.length > 1 };
    });
    rows.sort((a, b) => b.votes - a.votes || a.key.localeCompare(b.key));
    this.results = rows;
    if (!this.note && live.length >= 2 && totalVotes === 0) this.note = 'No votes this round.';
    this.phase = 'reveal';
    this.deadline = now + this.revealMs;
  }

  private nextRound(now: number): void {
    this.round++;
    if (this.round >= this.rounds) {
      this.phase = 'final';
      this.deadline = null;
      return;
    }
    this.startRound(now);
  }

  tick(now: number): void {
    if (this.phase === 'final' || this.deadline === null || now < this.deadline) return;
    if (this.phase === 'answer') this.toVote(now);
    else if (this.phase === 'vote') this.toReveal(now);
    else if (this.phase === 'reveal') this.nextRound(now);
  }

  setPresence(playerId: string, presence: Presence, now: number): void {
    if (!this.connected.has(playerId)) return;
    this.connected.set(playerId, presence === 'connected');
    if (presence === 'gone') this.gone.add(playerId);
    if (this.phase === 'final') return;
    if (this.active().length < 2) {
      this.abort('Not enough players left.');
      return;
    }
    // Someone leaving may mean everyone remaining is done.
    if (this.phase === 'answer' && this.waitingOn().length > 0 && this.waitingOn().every((p) => this.answers.has(p.id))) this.toVote(now);
    else if (this.phase === 'vote' && this.eligibleVoters().every((p) => this.votes.has(p.id))) this.toReveal(now);
  }

  abort(reason: string): void {
    if (this.phase === 'final') return;
    this.aborted = reason;
    this.phase = 'final';
    this.deadline = null;
    this.note = reason;
  }

  viewFor(playerId: string | null): PromptPanicView {
    const prompt = this.prompts[Math.min(this.round, this.rounds - 1)];
    const isPlayer = playerId !== null && this.players.some((p) => p.id === playerId);
    const cat = CATEGORIES.find((c) => c.id === prompt.category)?.name ?? (prompt.pack ? `Custom: ${prompt.pack}` : 'Custom');
    return {
      phase: this.phase,
      round: Math.min(this.round + 1, this.rounds),
      rounds: this.rounds,
      prompt: prompt.text,
      category: cat,
      absurdity: ABSURDITY_LABEL[prompt.absurdity],
      twist: this.twists[Math.min(this.round, this.rounds - 1)],
      multiplier: this.multiplier(),
      deadline: this.deadline,
      players: this.players.filter((p) => !this.gone.has(p.id)).map((p) => ({
        id: p.id, name: p.name, connected: !!this.connected.get(p.id), answered: this.answers.has(p.id), voted: this.votes.has(p.id),
      })),
      yourAnswer: isPlayer ? this.answers.get(playerId!) ?? null : null,
      entries: this.phase === 'vote'
        ? this.liveEntries().map((e) => ({ key: e.key, text: e.text, yours: isPlayer && e.authors.includes(playerId!) }))
        : null,
      yourVote: isPlayer ? this.votes.get(playerId!) ?? null : null,
      results: this.phase === 'reveal' || this.phase === 'final' ? this.results : null,
      scores: this.players.map((p) => ({ id: p.id, name: p.name, score: this.scores.get(p.id) ?? 0 })).sort((a, b) => b.score - a.score),
      note: this.note,
      isHost: playerId === this.hostId,
    };
  }

  takeEvents(): MpEvent[] {
    return [];
  }

  isOver(): boolean {
    return this.phase === 'final';
  }

  outcome(): MatchOutcome | null {
    if (this.phase !== 'final') return null;
    const standings = rankStandings(this.players.map((p) => ({ playerId: p.id, name: p.name, score: this.scores.get(p.id) ?? 0 })));
    const top = standings.filter((s) => s.rank === 1);
    const headline = this.aborted
      ? `Game ended early: ${this.aborted}`
      : top.length > 1 ? `It's a tie: ${top.map((t) => t.name).join(' & ')}!` : `${top[0]?.name ?? 'Nobody'} is the Prompt Panic champion!`;
    const stats: Record<string, Record<string, number>> = {};
    for (const p of this.players) stats[p.id] = { ...this.stats.get(p.id)!, won: standings.find((s) => s.playerId === p.id)?.rank === 1 && !this.aborted ? 1 : 0 };
    return { standings, headline, stats, ...(this.aborted ? { incomplete: true } : {}) };
  }
}

export const promptPanicDef: MpGameDefinition = {
  id: 'prompt-panic',
  name: 'Prompt Panic',
  kind: 'party',
  tagline: 'Answer absurd prompts, vote anonymously for the funniest.',
  minPlayers: 2,
  maxPlayers: 8,
  playersLabel: '3-8 players (2 ok)',
  rules: [
    'Everyone gets the same prompt. Type the funniest answer you can.',
    'Answers are shuffled and anonymous. Vote for your favourite (not your own).',
    `+${VOTE_POINTS} per vote, +${ANSWER_BONUS} for answering, +${SWEEP_BONUS} for a clean sweep. Final round x2.`,
  ],
  options: [
    { key: 'rounds', label: 'Rounds', values: [3, 5, 8], default: 5 },
    { key: 'answerTime', label: 'Answer timer', values: [30, 45, 60, 90, 120], default: 60, unit: 's' },
    { key: 'voteTime', label: 'Vote timer', values: [20, 30, 45], default: 30, unit: 's' },
    { key: 'revealTime', label: 'Results shown', values: [5, 10, 15], default: 10, unit: 's' },
    { key: 'absurdity', label: 'Absurdity', values: ['mixed', 'mild', 'spicy', 'unhinged'], default: 'mixed' },
    { key: 'category', label: 'Category', values: ['any', ...CATEGORIES.map((c) => c.id)], default: 'any' },
    { key: 'deck', label: 'Prompt deck', values: ['mixed', 'built-in', 'custom'], default: 'mixed' },
    { key: 'familyFilter', label: 'Family filter', values: ['on', 'off'], default: 'on' },
  ],
  create: (ctx) => new PromptPanicMatch(ctx),
};
