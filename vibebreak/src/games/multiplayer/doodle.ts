import type { Rng } from '../../core/rng.js';
import { cleanText } from '../../net/sanitize.js';
import {
  isInt, isObj, ok, rankStandings, reject,
  type ActionResult, type MatchContext, type MatchOutcome, type MpEvent, type MpGameDefinition, type MpMatch, type MpPlayer, type Presence,
} from '../../mp/types.js';
import { maskText } from './moderation.js';

/**
 * Doodle Protocol: one artist draws a secret word on a shared ASCII canvas,
 * everyone else guesses. Artists rotate.
 *
 * Drawing protocol: the artist sends small batches of cell ops
 * ([x, y, char]); the server validates and applies them, bumps the canvas
 * revision and broadcasts the same small batch as an event. Clients that
 * notice a gap in revisions (late join, reconnect) ask for a one-off full
 * snapshot with a `sync` action. The secret word is only ever in the
 * artist's view until the turn is revealed.
 */

export const BRUSHES = ['#', '*', 'o', '+', '.', '-', '|', '/', '\\', '=', '@', '~'] as const;
export const MAX_OPS = 128;
const REVEAL_MS = 5000;
const GUESS_GAP_MS = 400;

export const WORDS: Record<'dev' | 'everyday', string[]> = {
  dev: [
    'bug', 'cloud', 'robot', 'keyboard', 'mouse', 'laptop', 'server', 'database', 'firewall', 'rocket', 'coffee', 'terminal',
    'git branch', 'pull request', 'spaghetti code', 'stack', 'queue', 'tree', 'cookie', 'cache', 'wifi', 'battery', 'floppy disk',
    'monitor', 'headphones', 'printer', 'satellite', 'antenna', 'password', 'lock', 'key', 'email', 'trash can', 'loading bar',
    'emoji', 'hashtag', 'pixel', 'joystick', 'game controller', 'usb stick', 'smartphone', 'cursor', 'magnifying glass', 'gear',
    'rubber duck', 'snake', 'whale', 'penguin', 'octopus', 'spider web', 'deadline', 'merge conflict', 'infinite loop', 'hotfix',
  ],
  everyday: [
    'cat', 'dog', 'house', 'sun', 'moon', 'star', 'tree', 'flower', 'car', 'bicycle', 'boat', 'train', 'airplane', 'pizza',
    'banana', 'apple', 'ice cream', 'cake', 'umbrella', 'clock', 'guitar', 'piano', 'drum', 'ghost', 'castle', 'crown', 'sword',
    'shield', 'dragon', 'unicorn', 'fish', 'bird', 'butterfly', 'spider', 'snail', 'mushroom', 'cactus', 'volcano', 'mountain',
    'island', 'rainbow', 'lightning', 'snowman', 'tent', 'campfire', 'bridge', 'ladder', 'chair', 'table', 'bed', 'door', 'window',
    'glasses', 'hat', 'shoe', 'sock', 'key', 'light bulb', 'heart', 'smile', 'pyramid', 'anchor', 'skateboard', 'balloon', 'kite',
  ],
};

export function normalizeGuess(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Levenshtein distance, capped (we only care about "very close"). */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** "light bulb" with hints at {1} -> "_ i _ _ _   _ _ _ _" (letters separated by spaces, words by 3). */
export function maskWord(word: string, revealed: Set<number>): string {
  return [...word].map((ch, i) => (ch === ' ' ? ' ' : revealed.has(i) ? ch : '_')).join(' ');
}

export type DoodlePhase = 'drawing' | 'reveal' | 'over';

export interface FeedLine {
  name: string;
  text: string;
  kind: 'guess' | 'correct' | 'system';
}

export interface DoodleView {
  phase: DoodlePhase;
  turn: number;
  turns: number;
  artistId: string;
  artistName: string;
  role: 'artist' | 'guesser' | 'spectator';
  /** The secret word: artist only while drawing; everyone during reveal/over. */
  word: string | null;
  mask: string;
  deadline: number | null;
  width: number;
  height: number;
  rev: number;
  brushes: readonly string[];
  guessed: string[];
  youGuessed: boolean;
  feed: FeedLine[];
  /** Private feedback for the viewer ("So close!"). */
  note: string | null;
  scores: Array<{ id: string; name: string; score: number; connected: boolean }>;
  lastTurn: { word: string; artist: string; guessers: Array<{ name: string; points: number }> } | null;
  isHost: boolean;
}

export type DoodleEvent =
  | { kind: 'ops'; rev: number; ops: Array<[number, number, string]> }
  | { kind: 'canvas'; rev: number; rows: string[] };

export class DoodleMatch implements MpMatch {
  private readonly players: MpPlayer[];
  private readonly connected = new Map<string, boolean>();
  private readonly gone = new Set<string>();
  private readonly scores = new Map<string, number>();
  private readonly order: string[];
  private readonly words: string[];
  private readonly drawMs: number;
  private readonly hints: boolean;
  private readonly hostId: string | undefined;
  readonly width: number;
  readonly height: number;
  private readonly rng: Rng;
  private readonly stats = new Map<string, { correct: number; drawn: number; guessedOnYourTurn: number }>();

  private turn = 0;
  private phase: DoodlePhase = 'drawing';
  private artistId = '';
  private word = '';
  private revealed = new Set<number>();
  private deadline: number | null = null;
  private turnStart = 0;
  private canvas: string[][] = [];
  private rev = 0;
  private guessed = new Map<string, number>();
  private feed: FeedLine[] = [];
  private notes = new Map<string, string>();
  private lastGuessAt = new Map<string, number>();
  private lastTurn: DoodleView['lastTurn'] = null;
  private events: MpEvent[] = [];
  private aborted: string | null = null;

  constructor(ctx: MatchContext) {
    this.players = ctx.players;
    this.rng = ctx.rng;
    this.hostId = ctx.hostId;
    const [w, h] = String(ctx.options.canvas).split('x').map(Number);
    this.width = w || 30;
    this.height = h || 12;
    this.drawMs = Number(ctx.options.drawTime) * 1000;
    this.hints = ctx.options.hints !== 'off';
    for (const p of ctx.players) {
      this.connected.set(p.id, true);
      this.scores.set(p.id, 0);
      this.stats.set(p.id, { correct: 0, drawn: 0, guessedOnYourTurn: 0 });
    }
    const cycles = Number(ctx.options.cycles) || 1;
    const base = ctx.rng.shuffle(ctx.players.map((p) => p.id));
    this.order = Array.from({ length: cycles }, () => base).flat();
    const pack = String(ctx.options.words);
    const pool = pack === 'dev' ? WORDS.dev : pack === 'everyday' ? WORDS.everyday : [...new Set([...WORDS.dev, ...WORDS.everyday])];
    let used = ctx.memory.get('doodle:used') as Set<string> | undefined;
    if (!used) ctx.memory.set('doodle:used', (used = new Set()));
    let fresh = pool.filter((x) => !used!.has(x));
    if (fresh.length < this.order.length) { used.clear(); fresh = pool; }
    this.words = ctx.rng.fork('words').shuffle(fresh).slice(0, this.order.length);
    for (const x of this.words) used.add(x);
    this.startTurn(ctx.now);
  }

  get turns(): number {
    return this.order.length;
  }

  private name(id: string): string {
    return this.players.find((p) => p.id === id)?.name ?? '?';
  }

  private guessers(): MpPlayer[] {
    return this.players.filter((p) => p.id !== this.artistId && !this.gone.has(p.id) && this.connected.get(p.id));
  }

  private say(line: FeedLine): void {
    this.feed.push(line);
    if (this.feed.length > 8) this.feed.shift();
  }

  private clearCanvas(): void {
    this.canvas = Array.from({ length: this.height }, () => Array(this.width).fill(' '));
    this.rev++;
    this.events.push({ to: 'all', data: { kind: 'canvas', rev: this.rev, rows: this.rows() } satisfies DoodleEvent });
  }

  private rows(): string[] {
    return this.canvas.map((r) => r.join(''));
  }

  private startTurn(now: number): void {
    // Skip artists who have left for good.
    while (this.turn < this.order.length && this.gone.has(this.order[this.turn])) this.turn++;
    if (this.turn >= this.order.length) {
      this.phase = 'over';
      this.deadline = null;
      return;
    }
    this.phase = 'drawing';
    this.artistId = this.order[this.turn];
    this.word = this.words[this.turn % this.words.length];
    this.revealed = new Set();
    this.guessed = new Map();
    this.notes = new Map();
    this.turnStart = now;
    this.deadline = now + this.drawMs;
    this.stats.get(this.artistId)!.drawn++;
    this.clearCanvas();
    this.say({ name: '', text: `${this.name(this.artistId)} is drawing.`, kind: 'system' });
    if (!this.connected.get(this.artistId)) this.endTurn(now, `${this.name(this.artistId)} is disconnected; skipping.`);
  }

  private endTurn(now: number, why: string | null): void {
    if (this.phase !== 'drawing') return;
    this.lastTurn = {
      word: this.word,
      artist: this.name(this.artistId),
      guessers: [...this.guessed].map(([id, pts]) => ({ name: this.name(id), points: pts })),
    };
    if (why) this.say({ name: '', text: why, kind: 'system' });
    this.say({ name: '', text: `The word was "${this.word}".`, kind: 'system' });
    this.phase = 'reveal';
    this.deadline = now + REVEAL_MS;
  }

  handleAction(playerId: string, action: unknown, now: number): ActionResult {
    if (!isObj(action)) return reject('INVALID', 'Invalid action');
    const playing = this.players.some((p) => p.id === playerId) && !this.gone.has(playerId);
    switch (action.kind) {
      case 'sync':
        this.events.push({ to: [playerId], data: { kind: 'canvas', rev: this.rev, rows: this.rows() } satisfies DoodleEvent });
        return ok;
      case 'draw': {
        if (playerId !== this.artistId) return reject('NOT_ARTIST', 'Only the artist can draw');
        if (this.phase !== 'drawing') return reject('PHASE', 'Not drawing right now');
        if (!Array.isArray(action.ops) || action.ops.length === 0 || action.ops.length > MAX_OPS) return reject('INVALID', `Send 1-${MAX_OPS} drawing ops`);
        const ops: Array<[number, number, string]> = [];
        for (const op of action.ops) {
          if (!Array.isArray(op) || op.length !== 3) return reject('INVALID', 'Malformed drawing op');
          const [x, y, c] = op as unknown[];
          if (!isInt(x, 0, this.width - 1) || !isInt(y, 0, this.height - 1)) return reject('INVALID', 'Drawing outside the canvas');
          if (typeof c !== 'string' || (c !== ' ' && !(BRUSHES as readonly string[]).includes(c))) return reject('INVALID', 'Unknown brush');
          ops.push([x, y, c]);
        }
        for (const [x, y, c] of ops) this.canvas[y][x] = c;
        this.rev++;
        this.events.push({ to: 'all', data: { kind: 'ops', rev: this.rev, ops } satisfies DoodleEvent });
        return ok;
      }
      case 'clear': {
        if (playerId !== this.artistId) return reject('NOT_ARTIST', 'Only the artist can clear');
        if (this.phase !== 'drawing') return reject('PHASE', 'Not drawing right now');
        this.clearCanvas();
        return ok;
      }
      case 'guess': {
        if (!playing) return reject('NOT_PLAYING', 'You are not playing in this match');
        if (this.phase !== 'drawing') return reject('PHASE', 'Wait for the next drawing');
        if (playerId === this.artistId) return reject('NOT_ALLOWED', "The artist can't guess");
        if (this.guessed.has(playerId)) return reject('DUPLICATE', 'You already got it');
        if (now - (this.lastGuessAt.get(playerId) ?? -Infinity) < GUESS_GAP_MS) return reject('RATE_LIMITED', 'Slow down');
        this.lastGuessAt.set(playerId, now);
        const text = cleanText(action.text, 40);
        if (!text) return reject('INVALID', 'Empty guess');
        const g = normalizeGuess(text);
        const target = normalizeGuess(this.word);
        if (g === target) {
          const first = this.guessed.size === 0;
          const frac = Math.max(0, (this.deadline! - now) / this.drawMs);
          const pts = 50 + Math.round(50 * frac) + (first ? 25 : 0);
          this.guessed.set(playerId, pts);
          this.scores.set(playerId, (this.scores.get(playerId) ?? 0) + pts);
          this.scores.set(this.artistId, (this.scores.get(this.artistId) ?? 0) + 25);
          this.stats.get(playerId)!.correct++;
          this.stats.get(this.artistId)!.guessedOnYourTurn++;
          this.say({ name: this.name(playerId), text: first ? 'guessed it first!' : 'guessed it!', kind: 'correct' });
          this.notes.set(playerId, `Correct! +${pts}`);
          if (this.guessers().every((p) => this.guessed.has(p.id))) this.endTurn(now, 'Everyone got it!');
          return ok;
        }
        // Never echo a guess that contains the answer (e.g. "a cat!" when the word is "cat").
        if (target.length >= 3 && g.includes(target)) {
          this.notes.set(playerId, 'Almost: drop the extra words.');
          return ok;
        }
        if (target.length >= 4 && editDistance(g, target) <= 1) this.notes.set(playerId, `"${text}" is so close!`);
        else this.notes.delete(playerId);
        this.say({ name: this.name(playerId), text: maskText(text, true).text, kind: 'guess' });
        return ok;
      }
      case 'skip': {
        if (playerId !== this.hostId && playerId !== this.artistId) return reject('NOT_ALLOWED', 'Only the host or the artist can skip');
        if (this.phase === 'drawing') this.endTurn(now, 'Turn skipped.');
        else if (this.phase === 'reveal') this.nextTurn(now);
        return ok;
      }
      default:
        return reject('INVALID', 'Unknown action');
    }
  }

  private nextTurn(now: number): void {
    this.turn++;
    this.startTurn(now);
  }

  tick(now: number): void {
    if (this.phase === 'over' || this.deadline === null) return;
    if (this.phase === 'drawing') {
      if (this.hints) {
        const frac = (now - this.turnStart) / this.drawMs;
        const letters = [...this.word].map((c, i) => (c === ' ' ? -1 : i)).filter((i) => i >= 0);
        // One letter at 50% of the time, another at 75% (never the whole word).
        const want = Math.min(Math.max(0, letters.length - 2), frac >= 0.75 ? 2 : frac >= 0.5 ? 1 : 0);
        while (this.revealed.size < want) {
          const hidden = letters.filter((i) => !this.revealed.has(i));
          this.revealed.add(this.rng.pick(hidden));
        }
      }
      if (now >= this.deadline) this.endTurn(now, "Time's up!");
    } else if (this.phase === 'reveal' && now >= this.deadline) {
      this.nextTurn(now);
    }
  }

  setPresence(playerId: string, presence: Presence, now: number): void {
    if (!this.connected.has(playerId)) return;
    this.connected.set(playerId, presence === 'connected');
    if (presence === 'gone') this.gone.add(playerId);
    if (this.phase === 'over') return;
    if (this.players.filter((p) => !this.gone.has(p.id)).length < 2) {
      this.abort('Not enough players left.');
      return;
    }
    if (this.phase === 'drawing') {
      if (playerId === this.artistId && presence !== 'connected') this.endTurn(now, `${this.name(playerId)} (the artist) disconnected.`);
      else if (this.guessers().length > 0 && this.guessers().every((p) => this.guessed.has(p.id))) this.endTurn(now, 'Everyone got it!');
    }
  }

  abort(reason: string): void {
    if (this.phase === 'over') return;
    this.aborted = reason;
    if (this.phase === 'drawing') this.endTurn(0, reason);
    this.phase = 'over';
    this.deadline = null;
  }

  viewFor(playerId: string | null): DoodleView {
    const isPlayer = playerId !== null && this.players.some((p) => p.id === playerId);
    const role: DoodleView['role'] = !isPlayer ? 'spectator' : playerId === this.artistId ? 'artist' : 'guesser';
    const showWord = this.phase !== 'drawing' || role === 'artist';
    return {
      phase: this.phase,
      turn: Math.min(this.turn + 1, this.turns),
      turns: this.turns,
      artistId: this.artistId,
      artistName: this.name(this.artistId),
      role,
      word: showWord ? this.word : null,
      mask: maskWord(this.word, this.phase === 'drawing' ? this.revealed : new Set([...this.word].map((_, i) => i))),
      deadline: this.deadline,
      width: this.width,
      height: this.height,
      rev: this.rev,
      brushes: BRUSHES,
      guessed: [...this.guessed.keys()],
      youGuessed: playerId !== null && this.guessed.has(playerId),
      feed: [...this.feed],
      note: playerId !== null ? this.notes.get(playerId) ?? null : null,
      scores: this.players.filter((p) => !this.gone.has(p.id)).map((p) => ({ id: p.id, name: p.name, score: this.scores.get(p.id) ?? 0, connected: !!this.connected.get(p.id) }))
        .sort((a, b) => b.score - a.score),
      lastTurn: this.phase === 'drawing' ? null : this.lastTurn,
      isHost: playerId !== null && playerId === this.hostId,
    };
  }

  /** Current canvas (tests and snapshots). */
  canvasRows(): string[] {
    return this.rows();
  }

  takeEvents(): MpEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  isOver(): boolean {
    return this.phase === 'over';
  }

  outcome(): MatchOutcome | null {
    if (this.phase !== 'over') return null;
    const standings = rankStandings(this.players.map((p) => ({ playerId: p.id, name: p.name, score: this.scores.get(p.id) ?? 0 })));
    const top = standings.filter((s) => s.rank === 1);
    const headline = this.aborted
      ? `Game ended early: ${this.aborted}`
      : top.length > 1 ? `It's a tie: ${top.map((t) => t.name).join(' & ')}!` : `${top[0].name} wins Doodle Protocol!`;
    const stats: Record<string, Record<string, number>> = {};
    for (const p of this.players) stats[p.id] = { ...this.stats.get(p.id)!, won: !this.aborted && standings.find((s) => s.playerId === p.id)?.rank === 1 ? 1 : 0 };
    return { standings, headline, stats, ...(this.aborted ? { incomplete: true } : {}) };
  }
}

export const doodleDef: MpGameDefinition = {
  id: 'doodle-protocol',
  name: 'Doodle Protocol',
  kind: 'party',
  tagline: 'One player draws a secret word in ASCII, everyone else guesses.',
  minPlayers: 2,
  maxPlayers: 8,
  playersLabel: '3-8 players (2 ok)',
  rules: [
    'Artists take turns drawing a secret word on a shared ASCII canvas.',
    'Everyone else types guesses. Faster correct guesses score more; first gets +25.',
    'The artist scores +25 for every player who gets it.',
  ],
  options: [
    { key: 'cycles', label: 'Turns each', values: [1, 2, 3], default: 1 },
    { key: 'drawTime', label: 'Draw timer', values: [45, 60, 80, 100, 120], default: 80, unit: 's' },
    { key: 'canvas', label: 'Canvas', values: ['30x12', '24x10', '40x14'], default: '30x12' },
    { key: 'words', label: 'Word pack', values: ['mixed', 'dev', 'everyday'], default: 'mixed' },
    { key: 'hints', label: 'Letter hints', values: ['on', 'off'], default: 'on' },
  ],
  spectatorActions: ['sync'],
  create: (ctx) => new DoodleMatch(ctx),
};
