import {
  isObj, ok, reject,
  type ActionResult, type MatchContext, type MatchOutcome, type MpEvent, type MpGameDefinition, type MpMatch, type Presence, type Standing,
} from '../../mp/types.js';
import { RaceSim, type Press, type RaceEvent } from './sim.js';
import { aiField } from './ai.js';
import { CONDITIONS, type Conditions, type Preset } from './track.js';
import { fmtMs } from './game.js';

/**
 * LAN Grand Prix: the server runs the very same RaceSim as singleplayer.
 *
 * Authority: clients only send key presses (the same five inputs a local
 * player has). The server validates them, rate-limits them inside the sim,
 * advances the race on its own clock, and decides laps, the finish order
 * and the results. Clients rebuild the track from the seed in the view and
 * render interpolated snapshots; nothing they send can move a car directly.
 *
 * Disconnects: a racer whose connection drops is "ghosted": an autopilot
 * keeps the car rolling at a gentle pace (well below race speed) and it can
 * neither hit nor be hit, so nobody wins or loses by someone's Wi-Fi blip.
 * Reconnecting within the lobby's grace period hands the car back. When the
 * grace period runs out the racer retires (DNF). The race ends when every
 * racer still in it has finished, or when the finish window after the first
 * finisher closes; unfinished racers are classified by distance.
 */

export const NET_VERSION = 1;
/** Input batch: up to this many presses per message, one char each. */
export const MAX_BATCH = 12;
const CODES: Record<string, Press> = { l: 'left', r: 'right', g: 'gas', b: 'brake', d: 'drift' };
export const PRESS_CODE: Record<Press, string> = { left: 'l', right: 'r', gas: 'g', brake: 'b', drift: 'd' };
const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

/** Flags packed into each car snapshot. */
export const FLAG = { slide: 1, ghost: 2, finished: 4, retired: 8, offroad: 16, ai: 32, braking: 64 } as const;

/**
 * Per-car snapshot: [id, offset*100, distance*100, speed*10, steer, flags, lapsDone, finishMs (-1), damage].
 * Integers keep the view small; names and styles are in the static roster.
 */
export type CarSnap = [string, number, number, number, number, number, number, number, number];

export interface RaceNetView {
  v: typeof NET_VERSION;
  seed: string;
  preset: Preset;
  conditions: Conditions;
  laps: number;
  phase: 'countdown' | 'racing' | 'done';
  /** Race clock (ms; negative while counting down) at server time `at`. */
  t: number;
  at: number;
  roster: Array<{ id: string; name: string; style: number; ai: boolean }>;
  cars: CarSnap[];
  /** Server-authoritative order, leader first. */
  order: string[];
  you: string | null;
  /** When the finish window closes (server clock), once someone has finished. */
  windowEndsAt: number | null;
  aborted: string | null;
}

export type RaceNetEvent =
  | { k: 'lap'; id: string; lap: number; ms: number }
  | { k: 'finish'; id: string; place: number; ms: number }
  | { k: 'crash'; id: string }
  | { k: 'hazard'; id: string; what: string }
  | { k: 'go' };

/** Parse an untrusted input action. Exported for tests. */
export function parseInput(action: unknown): Press[] | null {
  if (!isObj(action) || action.kind !== 'in' || typeof action.p !== 'string') return null;
  const p = action.p;
  if (p.length === 0 || p.length > MAX_BATCH) return null;
  const out: Press[] = [];
  for (const ch of p) {
    const press = CODES[ch];
    if (!press) return null;
    out.push(press);
  }
  return out;
}

class RaceMatch implements MpMatch {
  readonly sim: RaceSim;
  private last: number;
  private aborted: string | null = null;
  private events: MpEvent[] = [];
  private readonly roster: RaceNetView['roster'];
  private readonly humans: Set<string>;
  private windowEndsAt: number | null = null;
  private readonly finishWindowMs: number;

  constructor(ctx: MatchContext) {
    const preset = String(ctx.options.difficulty) as Preset;
    const laps = Number(ctx.options.laps);
    const aiCount = Number(ctx.options.ai);
    const cond = String(ctx.options.conditions);
    this.finishWindowMs = Number(ctx.options.finishWindow) * 1000;
    const seed = ctx.rng.int(0, 0x7fffffff).toString(36);
    const field = aiField(preset, aiCount, ctx.rng.fork('field'));
    const racers = [
      ...ctx.players.map((p, i) => ({ id: p.id, name: p.name, style: i % 8, human: true })),
      ...field.map((ai, i) => ({ id: `ai${i}`, name: ai.name, style: (ctx.players.length + i) % 8, ai })),
    ];
    this.sim = new RaceSim({
      mode: 'lan', seed, preset, laps, countdownMs: 4000, finishWindowMs: this.finishWindowMs,
      ...(CONDITIONS.includes(cond as Conditions) ? { conditions: cond as Conditions } : {}),
    }, racers);
    this.roster = racers.map((r) => ({ id: r.id, name: r.name, style: r.style, ai: !('human' in r) }));
    this.humans = new Set(ctx.players.map((p) => p.id));
    this.last = ctx.now;
  }

  handleAction(playerId: string, action: unknown, now: number): ActionResult {
    this.advance(now);
    if (!this.humans.has(playerId)) return reject('NOT_RACING', 'You are not in this race');
    const presses = parseInput(action);
    if (!presses) return reject('BAD_INPUT', 'Invalid input');
    if (this.sim.phase === 'done') return ok;
    // The sim ignores presses from finished/retired cars and anything over the rate limit.
    for (const p of presses) this.sim.press(playerId, p);
    return ok;
  }

  tick(now: number): void {
    this.advance(now);
  }

  /** Run the race up to the server clock `now`. */
  private advance(now: number): void {
    const dt = Math.max(0, Math.min(250, now - this.last));
    this.last = Math.max(this.last, now);
    if (this.aborted || dt === 0) return;
    this.sim.step(dt);
    for (const e of this.sim.takeEvents()) this.relay(e, now);
  }

  private relay(e: RaceEvent, now: number): void {
    const push = (data: RaceNetEvent) => this.events.push({ to: 'all', data });
    switch (e.kind) {
      case 'go': push({ k: 'go' }); break;
      case 'lap': push({ k: 'lap', id: e.id, lap: e.lap, ms: e.ms }); break;
      case 'finish':
        push({ k: 'finish', id: e.id, place: this.sim.placeOf(e.id), ms: e.ms });
        if (this.windowEndsAt === null && this.humans.has(e.id)) this.windowEndsAt = now + this.finishWindowMs;
        break;
      case 'crash': if (this.humans.has(e.id)) this.events.push({ to: [e.id], data: { k: 'crash', id: e.id } }); break;
      case 'hazard': if (this.humans.has(e.id)) this.events.push({ to: [e.id], data: { k: 'hazard', id: e.id, what: e.hazard } }); break;
      default: break;
    }
  }

  viewFor(playerId: string | null): RaceNetView {
    const s = this.sim;
    return {
      v: NET_VERSION,
      seed: s.cfg.seed,
      preset: s.cfg.preset,
      conditions: s.track.conditions,
      laps: s.cfg.laps,
      phase: s.phase,
      t: Math.round(s.time),
      at: this.last,
      roster: this.roster,
      cars: s.racers.map((c): CarSnap => [
        c.id,
        Math.round(c.off * 100),
        Math.round(c.d * 100),
        Math.round(c.v * 10),
        c.steer,
        (c.driftMs > 0 || c.spinMs > 0 ? FLAG.slide : 0) | (c.ghost ? FLAG.ghost : 0) | (c.finishedMs !== null ? FLAG.finished : 0)
          | (c.retired ? FLAG.retired : 0) | (c.offroad ? FLAG.offroad : 0) | (c.ai ? FLAG.ai : 0) | (c.pedal === 'brake' ? FLAG.braking : 0),
        s.lapOf(c),
        c.finishedMs ?? -1,
        Math.round(c.damage),
      ]),
      order: s.standings().map((r) => r.id),
      you: playerId !== null && this.humans.has(playerId) ? playerId : null,
      windowEndsAt: this.windowEndsAt,
      aborted: this.aborted,
    };
  }

  setPresence(playerId: string, presence: Presence, now: number): void {
    this.advance(now);
    if (!this.humans.has(playerId)) return;
    if (presence === 'gone') this.sim.retire(playerId);
    else this.sim.setGhost(playerId, presence === 'disconnected');
  }

  takeEvents(): MpEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  isOver(): boolean {
    return this.aborted !== null || this.sim.phase === 'done';
  }

  outcome(): MatchOutcome | null {
    if (!this.isOver()) return null;
    const rows = this.sim.standings();
    const humanRows = rows.filter((r) => this.humans.has(r.id));
    const standings: Standing[] = humanRows.map((r, i) => ({
      playerId: r.id,
      name: r.name,
      // Points by overall place (AI included), nothing for a DNF.
      score: r.finishedMs !== null ? PLACE_POINTS[r.place - 1] ?? 1 : 0,
      rank: i + 1,
    }));
    const winner = rows[0];
    const headline = this.aborted
      ? `Race ended early: ${this.aborted}`
      : winner?.finishedMs !== null && winner
        ? `${winner.name} wins in ${fmtMs(winner.finishedMs!)}`
        : 'Nobody finished';
    const stats: Record<string, Record<string, number>> = {};
    for (const r of humanRows) {
      const car = this.sim.car(r.id)!;
      stats[r.id] = {
        races: 1,
        wins: r.place === 1 && r.finishedMs !== null ? 1 : 0,
        podiums: r.place <= 3 && r.finishedMs !== null ? 1 : 0,
        collisions: car.hits,
      };
    }
    return { standings, headline, ...(this.aborted ? { incomplete: true } : {}), stats };
  }

  abort(reason: string): void {
    if (this.isOver()) return;
    this.aborted = reason;
    this.sim.end();
  }
}

export const raceMpDef: MpGameDefinition = {
  id: 'racing',
  name: 'VibeBreak Racing',
  kind: 'versus',
  tagline: 'Same track, same rules, everyone at once. First across the line wins.',
  minPlayers: 2,
  maxPlayers: 8,
  playersLabel: '2-8 players',
  rules: [
    'A/D steer, W gas (stays on), S brake, Space drift.',
    'The host\'s machine runs the race: positions, laps and the finish order are decided there.',
    'Contact costs speed. Grass is slow. Oil spins you, barrels hurt.',
    'Drop out and your car coasts on autopilot (ghosted) until you reconnect.',
  ],
  options: [
    { key: 'laps', label: 'Laps', values: [1, 2, 3, 5], default: 3 },
    { key: 'ai', label: 'AI rivals', values: [0, 1, 2, 3], default: 0 },
    { key: 'difficulty', label: 'Track & AI', values: ['easy', 'normal', 'hard'], default: 'normal' },
    { key: 'conditions', label: 'Weather', values: ['random', ...CONDITIONS], default: 'random' },
    { key: 'finishWindow', label: 'Finish window', values: [15, 30, 60], default: 30, unit: 's' },
  ],
  tickMs: 33,
  create: (ctx) => new RaceMatch(ctx),
};
