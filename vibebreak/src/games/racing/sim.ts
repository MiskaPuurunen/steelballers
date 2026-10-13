import { Rng } from '../../core/rng.js';
import { LANE_W, Track, VERGE, laneOffsets, type Conditions, type Hazard, type Preset } from './track.js';
import { aiThink, type AiSkill } from './ai.js';

/**
 * The race simulation shared by every mode: singleplayer, highway and the
 * LAN server all drive exactly this code. It is pure and deterministic:
 * fixed 20ms steps, a seeded rng, and input only as discrete key presses
 * (terminals report key presses, never releases). It knows nothing about
 * terminals or sockets.
 *
 * Input model, chosen for terminals:
 *  - gas latches on (W) until you brake; brake (S) holds while the key
 *    repeats, then lets the car coast;
 *  - each steer press nudges a target line; the car glides there, so a
 *    double press is a slightly bigger move, never a spin;
 *  - Space drifts: a short burst of grip through a bend at a little speed.
 */

export const STEP_MS = 20;
/** Top speed on tarmac (rows per second). km/h shown = speed * KMH. */
export const VMAX = 20;
export const KMH = 10;
const ACCEL = 8;
const COAST = 2.5;
const BRAKE = 22;
const GRASS_VMAX = 8;
const GRASS_DECEL = 18;
/** Columns the steering target moves per press, and how far it may lead the car. */
export const STEER_STEP = 1.6;
const MAX_LEAD = 5;
/** Lateral speed toward the target (columns per second) at full grip. */
const LATERAL = 26;
/** Brake holds this long after the last S press (covers keyboard repeat delay). */
const BRAKE_HOLD_MS = 550;
const DRIFT_MS = 550;
const SPIN_MS = 700;
/** Car footprint for collisions: half-width in columns, length in rows. */
export const CAR_HALF_W = 2;
export const CAR_LEN = 3;
const PAIR_COOLDOWN_MS = 500;
/** Presses per second a car may make (token bucket); more are ignored. */
const PRESS_RATE = 40;

/** Grip: above this speed bends push the car outward. */
const GRIP: Record<Conditions, number> = { clear: 12, dusk: 12, night: 11.5, rain: 10, snow: 9 };
const PUSH = 1.4;

export type Pedal = 'gas' | 'coast' | 'brake';
export type Press = 'left' | 'right' | 'gas' | 'brake' | 'drift';
export const PRESSES: readonly Press[] = ['left', 'right', 'gas', 'brake', 'drift'];

export type Mode = 'grandprix' | 'timetrial' | 'highway' | 'lan';

export interface RacerSpec {
  id: string;
  name: string;
  /** Car sprite / colour index. */
  style: number;
  ai?: AiSkill;
  /** Controlled by a person: the race waits for humans, never for AI. */
  human?: boolean;
}

export interface RaceConfig {
  mode: Mode;
  seed: string;
  preset: Preset;
  laps: number;
  conditions?: Conditions;
  /** Modifier speed multiplier, applied to every car alike. */
  speedMult?: number;
  countdownMs?: number;
  /** After the first person finishes, the others have this long. 0 = end at once. */
  finishWindowMs?: number;
  /** Highway: damage that ends the run. */
  damageLimit?: number;
  /** Highway: surprise oil slicks (chaos modifier). */
  chaos?: boolean;
}

export interface Car {
  id: string;
  name: string;
  style: number;
  ai: AiSkill | null;
  human: boolean;
  traffic: boolean;
  /** Offset from the road centre (columns) and where steering is taking it. */
  off: number;
  target: number;
  /** Distance travelled (rows). */
  d: number;
  v: number;
  pedal: Pedal;
  brakeMs: number;
  driftMs: number;
  spinMs: number;
  /** Last steer direction and how recently, for the sprite's lean. */
  steer: -1 | 0 | 1;
  steerMs: number;
  offroad: boolean;
  damage: number;
  hits: number;
  finishedMs: number | null;
  retired: boolean;
  /** Disconnected (LAN): driven gently by autopilot and never collides. */
  ghost: boolean;
  lapTimes: number[];
  lapStart: number;
  overtakes: number;
  nearMisses: number;
  coins: number;
  /** Traffic only: cruising speed. */
  cruise: number;
  tokens: number;
  thinkMs: number;
  /** Hazards / pickups already hit, so each counts once per pass. */
  touched: Set<string>;
}

export type RaceEvent =
  | { kind: 'crash'; id: string; with: string }
  | { kind: 'hazard'; id: string; hazard: Hazard['kind'] }
  | { kind: 'lap'; id: string; lap: number; ms: number }
  | { kind: 'finish'; id: string; place: number; ms: number }
  | { kind: 'overtake'; id: string; near: boolean }
  | { kind: 'pickup'; id: string; pickup: 'coin' | 'wrench' }
  | { kind: 'wreck'; id: string }
  | { kind: 'gust'; dir: number }
  | { kind: 'go' };

export interface Standing {
  id: string;
  name: string;
  place: number;
  finishedMs: number | null;
  d: number;
  lap: number;
  retired: boolean;
  bestLapMs: number | null;
}

export class RaceSim {
  readonly track: Track;
  readonly cars: Car[] = [];
  readonly cfg: Required<Omit<RaceConfig, 'conditions'>>;
  /** Race clock: negative during the countdown, 0 at the green light. */
  time: number;
  phase: 'countdown' | 'racing' | 'done' = 'countdown';
  private acc = 0;
  private readonly rng: Rng;
  private readonly pairs = new Map<string, number>();
  private events: RaceEvent[] = [];
  private firstHumanFinish: number | null = null;
  private finishCount = 0;
  private nextTraffic = 0;
  private trafficSeq = 0;
  private readonly vmax: number;
  private readonly grip: number;

  constructor(cfg: RaceConfig, racers: RacerSpec[]) {
    this.cfg = {
      countdownMs: 3000,
      finishWindowMs: 0,
      damageLimit: 100,
      speedMult: 1,
      chaos: false,
      ...cfg,
    };
    this.track = new Track({ seed: cfg.seed, kind: cfg.mode === 'highway' ? 'highway' : 'circuit', preset: cfg.preset, ...(cfg.conditions ? { conditions: cfg.conditions } : {}) });
    this.rng = new Rng(`sim:${cfg.seed}`);
    this.time = -this.cfg.countdownMs;
    if (this.time >= 0) this.phase = 'racing';
    this.vmax = VMAX * this.cfg.speedMult;
    this.grip = GRIP[this.track.conditions] * this.cfg.speedMult;
    // Grid: two cars per row, staggered, behind the line.
    const lanes = laneOffsets(this.track);
    racers.forEach((r, i) => {
      const row = Math.floor(i / 2);
      const off = this.track.lanes >= 4 ? (i % 2 ? lanes[2] : lanes[1]) : i % 2 ? lanes[2] : lanes[0];
      const car = this.newCar(r, off, -2 - row * 5 - (i % 2) * 2);
      this.cars.push(car);
    });
    if (cfg.mode === 'highway') this.nextTraffic = 30;
  }

  private newCar(r: RacerSpec, off: number, d: number): Car {
    return {
      id: r.id, name: r.name, style: r.style, ai: r.ai ?? null, human: !!r.human, traffic: false,
      off, target: off, d, v: 0, pedal: 'gas', brakeMs: 0, driftMs: 0, spinMs: 0, steer: 0, steerMs: 0, offroad: false,
      damage: 0, hits: 0, finishedMs: null, retired: false, ghost: false, lapTimes: [], lapStart: 0,
      overtakes: 0, nearMisses: 0, coins: 0, cruise: 0, tokens: PRESS_RATE, thinkMs: 0, touched: new Set(),
    };
  }

  car(id: string): Car | undefined {
    return this.cars.find((c) => c.id === id);
  }

  get racers(): Car[] {
    return this.cars.filter((c) => !c.traffic);
  }

  /** Laps completed so far, for the HUD ("lap 2/3" = 1 completed). */
  lapOf(c: Car): number {
    if (this.track.kind !== 'circuit') return 0;
    return Math.max(0, Math.min(this.cfg.laps, Math.floor(c.d / this.track.lapLength)));
  }

  /* --------------------------------------------------------------- input */

  /**
   * Apply one key press for car `id`. Returns false when ignored (unknown
   * car, finished, retired, rate limited). Never throws on bad input.
   */
  press(id: string, p: Press): boolean {
    const c = this.car(id);
    if (!c || c.traffic || c.retired || c.finishedMs !== null || this.phase === 'done') return false;
    if (!PRESSES.includes(p)) return false;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    switch (p) {
      case 'gas':
        c.pedal = 'gas';
        c.brakeMs = 0;
        break;
      case 'brake':
        c.pedal = 'brake';
        c.brakeMs = BRAKE_HOLD_MS;
        break;
      case 'drift':
        if (c.driftMs <= 0 && c.v > 6 && this.phase === 'racing') {
          c.driftMs = DRIFT_MS;
          c.v *= 0.92;
        }
        break;
      default: {
        if (c.spinMs > 0) break;
        const dir = p === 'left' ? -1 : 1;
        const step = STEER_STEP * (c.driftMs > 0 ? 1.5 : 1);
        const lim = this.offLimit(c.d);
        // The target never runs far ahead of the car, so mashing can't queue a huge swerve.
        c.target = Math.max(-lim, Math.min(lim, Math.max(c.off - MAX_LEAD, Math.min(c.off + MAX_LEAD, c.target + dir * step))));
        c.steer = dir;
        c.steerMs = 220;
      }
    }
    return true;
  }

  /** Disconnected racers coast under autopilot (ghosted); 'gone' retires them. */
  setGhost(id: string, ghost: boolean): void {
    const c = this.car(id);
    if (c && !c.retired) c.ghost = ghost;
  }

  retire(id: string): void {
    const c = this.car(id);
    if (!c || c.finishedMs !== null) return;
    c.retired = true;
    c.ghost = true;
    this.checkDone();
  }

  /** Furthest the car may go from the centre: the barrier beyond the verge. */
  offLimit(d: number): number {
    return this.track.half(d) + VERGE - CAR_HALF_W;
  }

  /* ---------------------------------------------------------------- time */

  /** Advance by `ms` of real time in fixed steps. */
  step(ms: number): void {
    // Callers clamp frame gaps; this cap only guards against absurd values.
    this.acc += Math.max(0, Math.min(ms, 10_000));
    while (this.acc >= STEP_MS && this.phase !== 'done') {
      this.acc -= STEP_MS;
      this.tick(STEP_MS);
    }
  }

  takeEvents(): RaceEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private emit(e: RaceEvent): void {
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
  }

  private tick(dt: number): void {
    const s = dt / 1000;
    const wasCountdown = this.time < 0;
    this.time += dt;
    if (this.phase === 'countdown') {
      if (this.time < 0) return;
      this.phase = 'racing';
      if (wasCountdown) this.emit({ kind: 'go' });
    }
    if (this.cfg.mode === 'highway') this.spawnTraffic();
    if (this.cfg.chaos && this.rng.chance(dt / 7000)) this.gust();
    for (const c of this.cars) {
      c.tokens = Math.min(PRESS_RATE, c.tokens + PRESS_RATE * s);
      if (c.ai && !c.retired && c.finishedMs === null) {
        c.thinkMs -= dt;
        if (c.thinkMs <= 0) {
          c.thinkMs = c.ai.reactMs;
          for (const p of aiThink(this, c, this.rng)) this.press(c.id, p);
        }
      } else if (c.ghost && !c.retired && c.finishedMs === null) {
        this.autopilot(c);
      }
      this.move(c, s, dt);
    }
    this.collide(dt);
    for (const c of this.cars) this.progress(c, s, dt);
    if (this.cfg.mode === 'highway') this.cullTraffic();
    for (const [k, until] of this.pairs) if (until <= this.time) this.pairs.delete(k);
    this.checkDone();
  }

  /** Chaos modifier: a crosswind shoves every racer the same way. */
  private gust(): void {
    const dir = this.rng.chance(0.5) ? -1 : 1;
    for (const c of this.racers) {
      if (c.retired || c.finishedMs !== null) continue;
      const lim = this.offLimit(c.d);
      c.target = Math.max(-lim, Math.min(lim, c.target + dir * 3));
    }
    this.emit({ kind: 'gust', dir });
  }

  /** Gentle line-keeping for disconnected racers: well below race pace, no overtaking intent. */
  private autopilot(c: Car): void {
    c.pedal = c.v > this.vmax * 0.55 ? 'coast' : 'gas';
    const lanes = laneOffsets(this.track);
    const nearest = lanes.reduce((a, b) => (Math.abs(b - c.off) < Math.abs(a - c.off) ? b : a));
    c.target = nearest;
  }

  private move(c: Car, s: number, dt: number): void {
    const dec = (v: number) => Math.max(0, v - dt);
    c.brakeMs = dec(c.brakeMs);
    if (c.pedal === 'brake' && c.brakeMs <= 0) c.pedal = 'coast';
    c.driftMs = dec(c.driftMs);
    c.spinMs = dec(c.spinMs);
    c.steerMs = dec(c.steerMs);
    if (c.steerMs <= 0) c.steer = 0;

    if (c.traffic) {
      c.v = c.cruise;
      c.d += c.v * s;
      c.off += Math.sign(c.target - c.off) * Math.min(Math.abs(c.target - c.off), 6 * s);
      return;
    }
    const finished = c.finishedMs !== null || c.retired;
    const half = this.track.half(c.d);
    c.offroad = Math.abs(c.off) > half - 0.5;
    const top = c.offroad ? GRASS_VMAX : this.vmax * (1 - Math.min(0.25, c.damage / 400));
    // Finished cars roll to a stop past the line.
    const pedal: Pedal = finished && !c.ghost ? 'brake' : c.pedal;
    if (this.phase !== 'racing') {
      c.v = 0;
    } else if (c.v > top) {
      c.v = Math.max(top, c.v - (c.offroad ? GRASS_DECEL : COAST * 2) * s);
    } else if (pedal === 'gas') {
      c.v = Math.min(top, c.v + ACCEL * (1 - 0.55 * (c.v / this.vmax)) * s);
    } else if (pedal === 'brake') {
      c.v = Math.max(0, c.v - BRAKE * (this.track.conditions === 'snow' || this.track.conditions === 'rain' ? 0.75 : 1) * s);
    } else {
      c.v = Math.max(0, c.v - COAST * s);
    }
    if (finished && !c.ghost) c.v = Math.max(0, c.v - BRAKE * 0.3 * s);

    // Bends push the car outward when it's faster than the grip allows.
    const slope = this.track.slope(c.d);
    const over = Math.max(0, c.v - this.grip);
    const push = -slope * over * PUSH * (c.driftMs > 0 ? 0.25 : 1);
    if (c.spinMs > 0) {
      // Spinning: steering is gone and the car slides a little.
      c.off += Math.sin(this.time / 60) * 4 * s + push * s;
    } else {
      const grip = Math.min(1, 0.25 + c.v / 6);
      const delta = c.target - c.off;
      const stepX = Math.sign(delta) * Math.min(Math.abs(delta), LATERAL * grip * s);
      c.off += stepX + push * s;
      c.target += push * s;
    }
    const lim = this.offLimit(c.d);
    if (Math.abs(c.off) > lim) {
      // The barrier: scrape along it, losing speed (and a little paint).
      c.off = Math.sign(c.off) * lim;
      c.target = Math.max(-lim, Math.min(lim, c.target));
      if (c.v > 4 && this.phase === 'racing') {
        c.v *= 1 - 1.5 * s;
        c.damage = Math.min(999, c.damage + 6 * s);
      }
    }
  }

  private progress(c: Car, s: number, dt: number): void {
    if (this.phase !== 'racing') return;
    const before = c.d;
    if (!c.traffic) c.d += c.v * s;
    if (c.traffic || c.retired) return;
    this.hazards(c, before);
    if (this.cfg.mode === 'highway') {
      this.pickups(c, before);
      if (c.human && c.damage >= this.cfg.damageLimit && !c.retired) {
        c.retired = true;
        this.emit({ kind: 'wreck', id: c.id });
      }
      return;
    }
    if (c.finishedMs !== null) return;
    const L = this.track.lapLength;
    const lapsBefore = Math.floor(before / L);
    const lapsNow = Math.floor(c.d / L);
    if (lapsNow > lapsBefore && lapsNow >= 1) {
      // Crossing time, interpolated inside this step.
      const at = this.time - dt + (dt * (lapsNow * L - before)) / Math.max(1e-9, c.d - before);
      c.lapTimes.push(Math.round(at - c.lapStart));
      c.lapStart = at;
      if (lapsNow >= this.cfg.laps) {
        c.finishedMs = Math.round(at);
        this.finishCount++;
        if (c.human && this.firstHumanFinish === null) this.firstHumanFinish = this.time;
        this.emit({ kind: 'finish', id: c.id, place: this.finishCount, ms: c.finishedMs });
      } else {
        this.emit({ kind: 'lap', id: c.id, lap: lapsNow, ms: c.lapTimes[c.lapTimes.length - 1] });
      }
    }
  }

  private hazards(c: Car, before: number): void {
    if (c.ghost) return;
    // The car spans rows [d, d + CAR_LEN): its nose meets things first.
    for (const h of this.track.hazardsIn(before + CAR_LEN - 1, c.d + CAR_LEN)) {
      const key = `h${h.d}`;
      if (c.touched.has(key)) continue;
      if (Math.abs(c.off - h.off) >= h.half + CAR_HALF_W - 0.5) continue;
      c.touched.add(key);
      c.hits++;
      this.emit({ kind: 'hazard', id: c.id, hazard: h.kind });
      switch (h.kind) {
        case 'cone': c.v *= 0.85; c.damage += 2; break;
        case 'oil': c.spinMs = SPIN_MS; c.v *= 0.8; break;
        case 'pothole': c.v *= 0.75; c.damage += 8; break;
        case 'barrel': c.v *= 0.45; c.damage += 18; c.spinMs = SPIN_MS * 0.6; break;
      }
    }
    if (c.touched.size > 64) for (const k of [...c.touched].slice(0, 32)) c.touched.delete(k);
  }

  private pickups(c: Car, before: number): void {
    for (const p of this.track.pickupsIn(before - 1, c.d + CAR_LEN)) {
      const key = `p${p.d}`;
      if (c.touched.has(key) || Math.abs(c.off - p.off) > CAR_HALF_W + 0.5) continue;
      c.touched.add(key);
      if (p.kind === 'coin') c.coins++;
      else c.damage = Math.max(0, c.damage - 30);
      this.emit({ kind: 'pickup', id: c.id, pickup: p.kind });
    }
  }

  /** Car-to-car contact: the car behind loses speed, both are nudged apart. */
  private collide(_dt: number): void {
    const solid = this.cars.filter((c) => !c.ghost && !c.retired && (c.finishedMs === null || c.v > 1));
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i];
        const b = solid[j];
        const dd = a.d - b.d;
        if (Math.abs(dd) >= CAR_LEN) continue;
        const ax = this.track.center(a.d) + a.off;
        const bx = this.track.center(b.d) + b.off;
        const dx = ax - bx;
        if (Math.abs(dx) >= CAR_HALF_W * 2) continue;
        const [front, rear] = dd >= 0 ? [a, b] : [b, a];
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        // Separate: mostly sideways when side by side, backwards when nose to tail.
        const side = dx === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dx);
        const overlapX = CAR_HALF_W * 2 - Math.abs(dx);
        if (Math.abs(dd) > CAR_LEN * 0.6) {
          rear.d = Math.min(rear.d, front.d - CAR_LEN);
        } else {
          for (const [car, dir] of [[a, side], [b, -side]] as const) {
            if (car.traffic) continue;
            const push = (overlapX / 2 + 0.2) * (a.traffic || b.traffic ? 2 : 1);
            const lim = this.offLimit(car.d);
            car.off = Math.max(-lim, Math.min(lim, car.off + dir * push));
            car.target = Math.max(-lim, Math.min(lim, car.target + dir * push));
          }
        }
        if (this.pairs.has(key)) continue;
        this.pairs.set(key, this.time + PAIR_COOLDOWN_MS);
        if (!rear.traffic) rear.v = Math.min(rear.v, front.v) * 0.8;
        for (const car of [a, b]) {
          if (car.traffic) continue;
          car.hits++;
          car.damage += a.traffic || b.traffic ? 15 : 6;
          this.emit({ kind: 'crash', id: car.id, with: car === a ? b.id : a.id });
        }
      }
    }
  }

  /* ------------------------------------------------------------- highway */

  private player(): Car | undefined {
    return this.cars.find((c) => c.human);
  }

  /** Traffic appears out of sight ahead, gets denser with distance, and never fills every lane. */
  private spawnTraffic(): void {
    const p = this.player();
    if (!p) return;
    const ahead = p.d + 45;
    const density = Math.min(1, p.d / 6000);
    const lanes = laneOffsets(this.track);
    while (this.nextTraffic < ahead) {
      const d = this.nextTraffic;
      const busy = this.cars.filter((c) => c.traffic && Math.abs(c.d - d) < 12).map((c) => c.target);
      const free = lanes.filter((l) => !busy.some((b) => Math.abs(b - l) < 1));
      // Always leave at least two lanes open around any car.
      if (free.length > lanes.length - 2 + (busy.length ? 0 : 1)) {
        const lane = this.rng.pick(free);
        const cruise = this.vmax * this.rng.range(0.35, 0.6);
        const car = this.newCar({ id: `t${++this.trafficSeq}`, name: 'traffic', style: 10 + this.rng.int(0, 3) }, lane, d);
        car.traffic = true;
        car.cruise = cruise;
        car.v = cruise;
        this.cars.push(car);
      }
      this.nextTraffic += Math.max(8, 26 - 16 * density) + this.rng.int(0, 10);
    }
    // Occasional lane changes, only into a free lane.
    for (const t of this.cars) {
      if (!t.traffic || Math.abs(t.target - t.off) > 0.1 || !this.rng.chance(0.002)) continue;
      const next = lanes.filter((l) => Math.abs(l - t.target) < LANE_W * 1.1 && Math.abs(l - t.target) > 1)
        .filter((l) => !this.cars.some((o) => o !== t && Math.abs(o.d - t.d) < 8 && Math.abs(o.off - l) < CAR_HALF_W * 2));
      if (next.length) t.target = this.rng.pick(next);
    }
  }

  private cullTraffic(): void {
    const p = this.player();
    if (!p) return;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const t = this.cars[i];
      if (!t.traffic) continue;
      if (t.d < p.d - 2 && !t.touched.has('passed')) {
        t.touched.add('passed');
        const near = Math.abs(t.off - p.off) < CAR_HALF_W * 2 + 1.5 && !this.pairs.has(t.id < p.id ? `${t.id}|${p.id}` : `${p.id}|${t.id}`);
        p.overtakes++;
        if (near) p.nearMisses++;
        this.emit({ kind: 'overtake', id: p.id, near });
      }
      if (t.d < p.d - 30) this.cars.splice(i, 1);
    }
  }

  /* -------------------------------------------------------------- results */

  private checkDone(): void {
    if (this.phase === 'done') return;
    const humans = this.racers.filter((c) => c.human);
    if (!humans.length) return;
    if (this.cfg.mode === 'highway') {
      if (humans.every((c) => c.retired)) this.phase = 'done';
      return;
    }
    if (humans.every((c) => c.finishedMs !== null || c.retired)) {
      this.phase = 'done';
      return;
    }
    if (this.firstHumanFinish !== null && this.time - this.firstHumanFinish >= this.cfg.finishWindowMs) this.phase = 'done';
  }

  /** Force the race to end now (host ended it, player quit). */
  end(): void {
    this.phase = 'done';
  }

  /** Server-authoritative order: finishers by time, then by distance; retired last. */
  standings(): Standing[] {
    const rows = [...this.racers].sort((a, b) => {
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      if (a.finishedMs !== null || b.finishedMs !== null) {
        if (a.finishedMs === null) return 1;
        if (b.finishedMs === null) return -1;
        return a.finishedMs - b.finishedMs;
      }
      return b.d - a.d || a.id.localeCompare(b.id);
    });
    return rows.map((c, i) => ({
      id: c.id, name: c.name, place: i + 1, finishedMs: c.finishedMs, d: c.d, lap: this.lapOf(c), retired: c.retired,
      bestLapMs: c.lapTimes.length ? Math.min(...c.lapTimes) : null,
    }));
  }

  placeOf(id: string): number {
    return this.standings().find((s) => s.id === id)?.place ?? 0;
  }
}
