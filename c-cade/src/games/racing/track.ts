import { Rng } from '../../core/rng.js';

/**
 * Procedural race tracks. Pure data, reproducible from a seed, and used by
 * the simulation (physics, AI) and the renderer alike, so singleplayer and
 * LAN clients rebuild the exact same track from the server's seed.
 *
 * Geometry: the track is a vertically scrolling road. `d` is the distance
 * along it in rows (one row = one screen line), `center(d)` its horizontal
 * position in columns and `half(d)` half its width. Both are sums of a few
 * sine harmonics, so they are smooth, bounded and (for circuits) exactly
 * periodic over a lap, which closes the loop with no kinks. The slope is
 * capped analytically, so no curve is ever too sharp to follow.
 */

export type Conditions = 'clear' | 'dusk' | 'rain' | 'snow' | 'night';
export const CONDITIONS: Conditions[] = ['clear', 'dusk', 'rain', 'snow', 'night'];

export type Preset = 'easy' | 'normal' | 'hard';

export type HazardKind = 'cone' | 'oil' | 'pothole' | 'barrel';

export interface Hazard {
  kind: HazardKind;
  /** Offset from the road centre (columns) of the hazard's middle. */
  off: number;
  /** Row along the lap (circuits) or absolute row (highway). */
  d: number;
  /** Half-width of what you can hit (columns). */
  half: number;
}

export type PickupKind = 'coin' | 'wrench';

interface Pickup {
  kind: PickupKind;
  off: number;
  d: number;
}

export interface Scenery {
  sprite: 'pine' | 'spruce' | 'evergreen' | 'sapling' | 'stone' | 'boulder' | 'sign' | 'stand';
  /** Which side of the road, and how far beyond the verge (columns). */
  side: -1 | 1;
  gap: number;
  d: number;
}

interface TrackSpec {
  seed: string;
  kind: 'circuit' | 'highway';
  preset: Preset;
  conditions?: Conditions;
}

/** Lane width in columns; car sprites are 5 wide. */
export const LANE_W = 7;
/** Grass between the road edge and the barrier (columns). */
export const VERGE = 5;
/** Max |dCenter/dRow|: at most one column every two rows. */
export const MAX_SLOPE = 0.5;
/** Rows of clear road around the start/finish line. */
export const START_CLEAR = 40;
/** Hazards are at least this many rows apart. */
const HAZARD_GAP: Record<Preset, number> = { easy: 70, normal: 50, hard: 36 };
const CURVINESS: Record<Preset, number> = { easy: 0.6, normal: 0.85, hard: 1 };

interface Harmonic {
  amp: number;
  /** Cycles per lap (circuit) or radians per row (highway). */
  freq: number;
  phase: number;
}

export class Track {
  readonly kind: 'circuit' | 'highway';
  readonly preset: Preset;
  readonly seed: string;
  readonly conditions: Conditions;
  /** Rows per lap; Infinity for the highway. */
  readonly lapLength: number;
  readonly lanes: number;
  /** Hazards sorted by d (one lap for circuits; highway hazards are streamed). */
  readonly hazards: Hazard[] = [];
  readonly pickups: Pickup[] = [];
  readonly scenery: Scenery[] = [];
  private readonly curve: Harmonic[] = [];
  private readonly width: Harmonic[] = [];
  private readonly baseHalf: number;
  /** Highway content is generated in chunks on demand. */
  private readonly chunks = new Map<number, { hazards: Hazard[]; pickups: Pickup[]; scenery: Scenery[] }>();

  constructor(spec: TrackSpec) {
    const rng = new Rng(`track:${spec.kind}:${spec.preset}:${spec.seed}`);
    this.kind = spec.kind;
    this.preset = spec.preset;
    this.seed = spec.seed;
    // Always roll conditions so a fixed condition doesn't shift the rest of the track.
    const rolled = rng.pick(CONDITIONS);
    this.conditions = spec.conditions ?? rolled;

    if (spec.kind === 'circuit') {
      this.lanes = rng.int(3, 4);
      this.lapLength = rng.int(9, 13) * 40;
      this.baseHalf = (this.lanes * LANE_W) / 2;
      const L = this.lapLength;
      // Integer cycles per lap keep every harmonic periodic over the lap.
      const freqs = [rng.int(1, 2), rng.int(3, 4), rng.int(5, 7)];
      for (const f of freqs) this.curve.push({ amp: rng.range(0.5, 1), freq: f, phase: rng.range(0, Math.PI * 2) });
      // Scale so the steepest possible slope is MAX_SLOPE * curviness.
      const slopeBound = this.curve.reduce((s, h) => s + (h.amp * 2 * Math.PI * h.freq) / L, 0);
      const k = (MAX_SLOPE * CURVINESS[spec.preset]) / slopeBound;
      for (const h of this.curve) h.amp *= k;
      // Pin the start line straight-ish: shift phases so the centre is 0 at d = 0.
      const c0 = this.rawCenter(0);
      this.curve.push({ amp: -c0, freq: 0, phase: Math.PI / 2 });
      // A gentle pinch here and there: narrower sections never lose a full lane.
      const fw = rng.int(2, 3);
      this.width.push({ amp: rng.range(0, LANE_W * 0.35), freq: fw, phase: rng.range(0, Math.PI * 2) });
      this.buildCircuitContent(rng);
    } else {
      this.lanes = 4;
      this.lapLength = Infinity;
      this.baseHalf = (this.lanes * LANE_W) / 2;
      // Long sweeping bends; radians per row chosen so the slope bound holds.
      const raw = [rng.range(0.004, 0.007), rng.range(0.011, 0.016)];
      for (const w of raw) this.curve.push({ amp: 1, freq: w, phase: rng.range(0, Math.PI * 2) });
      const slopeBound = this.curve.reduce((s, h) => s + h.amp * h.freq, 0);
      const k = (MAX_SLOPE * 0.7) / slopeBound;
      for (const h of this.curve) h.amp *= k;
      const c0 = this.rawCenter(0);
      this.curve.push({ amp: -c0, freq: 0, phase: Math.PI / 2 });
    }
  }

  private wave(hs: Harmonic[], d: number): number {
    let s = 0;
    for (const h of hs) {
      const angle = this.kind === 'circuit' ? (2 * Math.PI * h.freq * d) / this.lapLength + h.phase : h.freq * d + h.phase;
      s += h.amp * Math.sin(angle);
    }
    return s;
  }

  private rawCenter(d: number): number {
    return this.wave(this.curve, d);
  }

  /** Road centre at distance d (columns from the world origin). */
  center(d: number): number {
    return this.wave(this.curve, this.local(d));
  }

  /** Half the road width at distance d (columns, >= one and a half lanes). */
  half(d: number): number {
    return this.baseHalf - Math.abs(this.wave(this.width, this.local(d)));
  }

  /** How fast the road is bending at d: columns of drift per row travelled. */
  slope(d: number): number {
    return this.center(d + 0.5) - this.center(d - 0.5);
  }

  /** Distance within the current lap. */
  local(d: number): number {
    return this.kind === 'circuit' ? ((d % this.lapLength) + this.lapLength) % this.lapLength : d;
  }

  /** Hazards between absolute rows [from, to). Circuit hazards repeat every lap. */
  hazardsIn(from: number, to: number): Hazard[] {
    return this.collect(from, to, (c) => c.hazards, this.hazards);
  }

  pickupsIn(from: number, to: number): Pickup[] {
    return this.collect(from, to, (c) => c.pickups, this.pickups);
  }

  sceneryIn(from: number, to: number): Scenery[] {
    return this.collect(from, to, (c) => c.scenery, this.scenery);
  }

  private collect<T extends { d: number }>(from: number, to: number, pick: (c: { hazards: Hazard[]; pickups: Pickup[]; scenery: Scenery[] }) => T[], lap: T[]): T[] {
    const out: T[] = [];
    if (this.kind === 'circuit') {
      const L = this.lapLength;
      for (let base = Math.floor(from / L) * L; base < to; base += L) {
        for (const h of lap) {
          const d = base + h.d;
          if (d >= from && d < to) out.push({ ...h, d });
        }
      }
      return out;
    }
    for (let ci = Math.floor(Math.max(0, from) / CHUNK); ci * CHUNK < to; ci++) {
      for (const h of pick(this.chunk(ci))) if (h.d >= from && h.d < to) out.push(h);
    }
    return out;
  }

  /* -------------------------------------------------------- generation */

  /**
   * Hazards keep at least two clear lanes in every row (one cluster at a time,
   * never two within HAZARD_GAP rows), and none near the start/finish line.
   */
  private buildCircuitContent(rng: Rng): void {
    const L = this.lapLength;
    let d = START_CLEAR + rng.int(10, 30);
    while (d < L - START_CLEAR) {
      const h = this.hazardNear(rng, d, L - START_CLEAR);
      if (h) this.hazards.push(h);
      d = (h?.d ?? d) + HAZARD_GAP[this.preset] + rng.int(0, 40);
    }
    this.scenery.push(...this.sceneryFor(rng, 0, L));
  }

  private laneOffset(lane: number): number {
    return -this.baseHalf + LANE_W * (lane + 0.5);
  }

  /** A hazard at d, or a little further on where the road is wide enough; null if none fits before `limit`. */
  private hazardNear(rng: Rng, d: number, limit: number): Hazard | null {
    for (let at = d; at < Math.min(limit, d + 30); at += 3) {
      const h = this.hazardAt(rng, at);
      if (h) return h;
    }
    return null;
  }

  private hazardAt(rng: Rng, d: number): Hazard | null {
    const roll = rng.next();
    const kind: HazardKind = roll < 0.35 ? 'cone' : roll < 0.6 ? 'oil' : roll < 0.82 ? 'pothole' : 'barrel';
    const half = kind === 'oil' ? 2 : kind === 'cone' ? 1 : 1.5;
    const road = this.half(d);
    const lim = road - half - 1;
    const jitter = rng.range(-1.5, 1.5);
    // In one lane, on the road, and always leaving two lanes' width clear on one side.
    for (const lane of rng.shuffle(Array.from({ length: this.lanes }, (_, i) => i))) {
      const off = Math.max(-lim, Math.min(lim, this.laneOffset(lane) + jitter));
      const free = Math.max(road - (off + half), off - half + road);
      if (free >= LANE_W * 2) return { kind, off, d, half };
    }
    return null;
  }

  private sceneryFor(rng: Rng, from: number, to: number): Scenery[] {
    const out: Scenery[] = [];
    const sprites: Scenery['sprite'][] = ['pine', 'pine', 'spruce', 'evergreen', 'sapling', 'stone', 'boulder'];
    for (let d = from + rng.int(0, 6); d < to; d += rng.int(5, 11)) {
      const side = rng.chance(0.5) ? -1 : 1;
      out.push({ sprite: rng.pick(sprites), side, gap: rng.int(2, 9), d });
    }
    if (this.kind === 'circuit' && from === 0) {
      out.push({ sprite: 'stand', side: -1, gap: 2, d: 6 }, { sprite: 'sign', side: 1, gap: 2, d: 14 });
    }
    return out;
  }

  /** Highway content for rows [ci*CHUNK, (ci+1)*CHUNK): deterministic per chunk. */
  private chunk(ci: number) {
    let c = this.chunks.get(ci);
    if (c) return c;
    const rng = new Rng(`hw:${this.seed}:${this.preset}:${ci}`);
    const hazards: Hazard[] = [];
    const pickups: Pickup[] = [];
    const from = ci * CHUNK;
    const gap = HAZARD_GAP[this.preset] * 1.6;
    for (let d = Math.max(from, START_CLEAR * 3) + rng.int(0, 40); d < from + CHUNK; d += gap + rng.int(0, 60)) {
      const h = this.hazardAt(rng, d);
      if (h) hazards.push(h);
    }
    for (let d = Math.max(from, START_CLEAR) + rng.int(0, 30); d < from + CHUNK; d += rng.int(30, 70)) {
      if (hazards.some((h) => Math.abs(h.d - d) < 6)) continue;
      pickups.push({ kind: rng.chance(0.12) ? 'wrench' : 'coin', off: this.laneOffset(rng.int(0, this.lanes - 1)), d });
    }
    c = { hazards, pickups, scenery: this.sceneryFor(rng, from, from + CHUNK) };
    this.chunks.set(ci, c);
    // The highway only ever looks a little ahead and behind: keep memory flat.
    for (const k of this.chunks.keys()) if (k < ci - 2) this.chunks.delete(k);
    return c;
  }
}

const CHUNK = 400;

/** Lane offsets of a track's lanes (for AI and spawning). */
export function laneOffsets(t: Track): number[] {
  const out: number[] = [];
  const half = (t.lanes * LANE_W) / 2;
  for (let i = 0; i < t.lanes; i++) out.push(-half + LANE_W * (i + 0.5));
  return out;
}
