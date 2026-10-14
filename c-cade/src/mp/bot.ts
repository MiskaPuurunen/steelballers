import { Rng, makeSeed } from '../core/rng.js';
import type { LanClient, CurrentView } from '../net/client.js';
import { FLEET, SIZE, randomFleet, shipCells, type BattleshipView } from '../games/multiplayer/battleship.js';
import type { PromptPanicView } from '../games/multiplayer/prompt-panic.js';
import { WORDS, type DoodleView } from '../games/multiplayer/doodle.js';
import type { RaceNetView } from '../games/racing/mp.js';
import { Track } from '../games/racing/track.js';
import { netDriver } from '../games/racing/ai.js';


const ANSWERS = [
  'A blockchain, but for snacks.',
  'It compiles, therefore it is.',
  'sudo make me a sandwich',
  'Three raccoons in a trench coat.',
  'The cloud, but lower.',
  'Ctrl+Z for real life.',
  'Ship it on a Friday.',
  'A very confident semicolon.',
  'Mandatory interpretive dance stand-ups.',
  'It was DNS. It is always DNS.',
  'Tabs AND spaces. At the same time.',
  'A rubber duck with a law degree.',
];

interface BotOptions {
  /** Delay before acting, to feel human and avoid spamming (ms range). */
  thinkMs?: [number, number];
  seed?: string;
  log?: (line: string) => void;
}

export class Bot {
  private readonly rng: Rng;
  private timer: NodeJS.Timeout | null = null;
  /** Situation we are "thinking" about, when we will act, and the last one acted on. */
  private planned = '';
  private actAt = 0;
  private done = '';
  private readonly thinkMs: [number, number];
  /** Racing is real-time: the bot drives continuously instead of taking turns. */
  private raceTrack: { key: string; track: Track } | null = null;
  private lastDrive = 0;

  constructor(private readonly client: LanClient, private readonly opts: BotOptions = {}) {
    this.rng = new Rng(opts.seed ?? makeSeed());
    this.thinkMs = opts.thinkMs ?? [300, 900];
  }

  start(): void {
    this.client.on('welcome', () => this.client.setReady(true));
    // A rejected action (stale view, race) means: think again.
    this.client.on('ack', (a: { ok: boolean; message?: string }) => {
      if (!a.ok) {
        this.log(`rejected: ${a.message ?? ''}`);
        this.done = '';
      }
    });
    if (this.client.status === 'online') this.client.setReady(true);
    this.timer = setInterval(() => this.step(), 40);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private log(s: string): void {
    this.opts.log?.(s);
  }

  private step(): void {
    const v = this.client.view;
    const lobby = this.client.lobby;
    if (!v || !lobby || lobby.phase !== 'match' || v.matchId !== lobby.matchId || this.client.status !== 'online') return;
    const now = Date.now();
    if (v.gameId === 'racing') return this.drive(v.view as RaceNetView, now);
    const key = this.situation(v);
    if (!key || key === this.done) return;
    if (key !== this.planned) {
      this.planned = key;
      this.actAt = now + this.rng.int(this.thinkMs[0], this.thinkMs[1]);
      return;
    }
    if (now < this.actAt) return;
    this.done = key;
    this.act(v);
  }

  /** One driving decision every ~60ms, sent as a normal input batch. */
  private drive(v: RaceNetView, now: number): void {
    if (!v.you || v.phase !== 'racing' || now - this.lastDrive < 60) return;
    this.lastDrive = now;
    const key = `${v.seed}:${v.preset}:${v.conditions}`;
    if (this.raceTrack?.key !== key) this.raceTrack = { key, track: new Track({ seed: v.seed, kind: 'circuit', preset: v.preset, conditions: v.conditions }) };
    const mine = v.cars.find((c) => c[0] === v.you);
    if (!mine || mine[7] >= 0) return;
    const pos = (c: RaceNetView['cars'][number]) => ({ off: c[1] / 100, d: c[2] / 100, v: c[3] / 10 });
    const presses = netDriver(this.raceTrack.track, pos(mine), v.cars.filter((c) => c[0] !== v.you).map(pos));
    if (presses) this.client.sendAction({ kind: 'in', p: presses });
  }

  /** A key that changes whenever the bot has something new to do (empty = nothing to do). */
  private situation(cv: CurrentView): string {
    if (cv.gameId === 'battleship') {
      const v = cv.view as BattleshipView;
      if (v.you === null || v.paused) return '';
      if (v.phase === 'placing' && !v.mine) return 'place';
      if (v.phase === 'battle' && v.turn === v.you) return `fire:${v.turns}`;
      return '';
    }
    if (cv.gameId === 'prompt-panic') {
      const v = cv.view as PromptPanicView;
      if (v.phase === 'answer' && v.yourAnswer === null) return `answer:${v.round}`;
      if (v.phase === 'vote' && v.yourVote === null && v.entries?.some((e) => !e.yours)) return `vote:${v.round}:${v.entries.length}`;
      return '';
    }
    if (cv.gameId === 'doodle-protocol') {
      const v = cv.view as DoodleView;
      if (v.phase !== 'drawing') return '';
      if (v.role === 'artist') return `draw:${v.turn}`;
      if (v.role === 'guesser' && !v.youGuessed) return `guess:${v.turn}:${Math.floor(Date.now() / 2500)}`;
    }
    return '';
  }

  private act(cv: CurrentView): void {
    if (cv.gameId === 'battleship') {
      const v = cv.view as BattleshipView;
      if (v.phase === 'placing') {
        this.client.sendAction({ kind: 'place', fleet: randomFleet(this.rng) });
        this.log('placed fleet');
      } else {
        const [x, y] = pickTarget(v, this.rng);
        this.client.sendAction({ kind: 'fire', x, y });
        this.log(`fire ${x},${y}`);
      }
    } else if (cv.gameId === 'prompt-panic') {
      const v = cv.view as PromptPanicView;
      if (v.phase === 'answer') {
        this.client.sendAction({ kind: 'answer', text: this.rng.pick(ANSWERS) });
        this.log(`answered round ${v.round}`);
      } else {
        const options = v.entries!.filter((e) => !e.yours);
        this.client.sendAction({ kind: 'vote', key: this.rng.pick(options).key });
        this.log(`voted round ${v.round}`);
      }
    } else if (cv.gameId === 'doodle-protocol') {
      const v = cv.view as DoodleView;
      if (v.role === 'artist') {
        // A small box with a smile: enough to exercise the drawing protocol.
        const ops: Array<[number, number, string]> = [];
        for (let x = 2; x < 12; x++) ops.push([x, 1, '-'], [x, 7, '-']);
        for (let y = 2; y < 7; y++) ops.push([2, y, '|'], [11, y, '|']);
        ops.push([5, 3, 'o'], [8, 3, 'o'], [5, 5, '\\'], [6, 6, '-'], [7, 6, '-'], [8, 5, '/']);
        this.client.sendAction({ kind: 'draw', ops });
        this.log('drew');
      } else {
        this.client.sendAction({ kind: 'guess', text: this.rng.pick([...WORDS.dev, ...WORDS.everyday]) });
      }
    }
  }
}

/** Hunt/target: finish wounded ships first, otherwise fire on a checkerboard. */
function pickTarget(v: BattleshipView, rng: Rng): [number, number] {
  const opp = v.boards[1 - (v.you ?? 0)];
  const shot = new Set(opp.shots.map(([x, y]) => `${x},${y}`));
  const sunkCells = new Set(opp.sunk.flatMap(shipCells).map(([x, y]) => `${x},${y}`));
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && !shot.has(`${x},${y}`);
  const wounded = opp.shots.filter(([x, y, m]) => m === 'h' && !sunkCells.has(`${x},${y}`));
  const near: Array<[number, number]> = [];
  for (const [x, y] of wounded) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (open(x + dx, y + dy)) near.push([x + dx, y + dy]);
  }
  if (near.length) return rng.pick(near);
  const all: Array<[number, number]> = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (open(x, y)) all.push([x, y]);
  const minLen = Math.min(...FLEET.map((s) => s.len));
  const parity = all.filter(([x, y]) => (x + y) % minLen === 0);
  return rng.pick(parity.length ? parity : all);
}
