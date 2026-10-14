import type { Rng } from '../../core/rng.js';
import { laneOffsets, type Preset, type Track } from './track.js';
import type { Car, Press, RaceSim } from './sim.js';
import { CAR_HALF_W, STEER_STEP, VMAX } from './sim.js';

/**
 * Computer drivers. They only ever press the same keys a person can, at a
 * human-like rate, so they obey exactly the same physics and rate limits.
 * Each "think" picks the clearest lane ahead (hazards, slower cars, the
 * road narrowing) and a speed for the bends coming up.
 */

export interface AiSkill {
  name: string;
  /** Fraction of top speed on straights. */
  pace: number;
  /** Fraction of top speed through sharp bends. */
  corner: number;
  /** Milliseconds between decisions. */
  reactMs: number;
  /** Rows of road it reads ahead. */
  look: number;
  /** Chance per decision of a lapse (no steering this time). */
  mistake: number;
  /** Uses the handbrake drift in bends. */
  drifts: boolean;
}

const NAMES = ['Byte Rider', 'Null Pointer', 'Race Condition', 'Hot Reload', 'Stack Trace', 'Lint Roller', 'Cache Miss', 'Segfault Sam'];

/** Field of opponents for a preset: a spread of skill, best last. */
export function aiField(preset: Preset, count: number, rng: Rng): AiSkill[] {
  const base = preset === 'easy' ? 0.78 : preset === 'normal' ? 0.86 : 0.92;
  const names = rng.shuffle([...NAMES]);
  return Array.from({ length: count }, (_, i) => {
    const t = count > 1 ? i / (count - 1) : 0.5;
    return {
      name: names[i % names.length],
      pace: Math.min(0.99, base + 0.07 * t),
      corner: Math.min(0.85, base - 0.2 + 0.1 * t),
      reactMs: Math.round(170 - 70 * t - (preset === 'hard' ? 20 : 0)),
      look: Math.round(14 + 8 * t),
      mistake: preset === 'easy' ? 0.06 : preset === 'normal' ? 0.03 : 0.012,
      drifts: preset !== 'easy' && t > 0.4,
    };
  });
}

/** One decision for car `c`: the presses to make now. */
export function aiThink(sim: RaceSim, c: Car, rng: Rng): Press[] {
  const ai = c.ai!;
  const out: Press[] = [];
  const t = sim.track;
  const vmax = sim.cfg.speedMult * VMAX;

  // Speed: ease off before sharp bends.
  let bend = 0;
  for (let k = 4; k <= ai.look; k += 4) bend = Math.max(bend, Math.abs(t.slope(c.d + k)));
  const want = vmax * (bend > 0.3 ? ai.corner + (ai.pace - ai.corner) * (1 - Math.min(1, (bend - 0.3) / 0.2)) : ai.pace);
  if (c.v > want + 1.2) out.push('brake');
  else if (c.pedal !== 'gas') out.push('gas');
  if (ai.drifts && bend > 0.38 && c.v > want && c.driftMs <= 0) out.push('drift');

  if (rng.chance(ai.mistake)) return out;

  // Lane: the cheapest one to be in over the next `look` rows.
  const lanes = laneOffsets(t);
  const hazards = t.hazardsIn(c.d, c.d + ai.look);
  const others = sim.cars.filter((o) => o !== c && !o.ghost && !o.retired && o.d > c.d - 1 && o.d < c.d + ai.look);
  let best = c.target;
  let bestCost = Infinity;
  for (const lane of lanes) {
    let cost = Math.abs(lane - c.off) * 0.6;
    for (const h of hazards) if (Math.abs(lane - h.off) < h.half + CAR_HALF_W + 1) cost += 100;
    for (const o of others) {
      if (Math.abs(lane - o.off) >= CAR_HALF_W * 2 + 0.5) continue;
      // A car right beside us, or a slower one ahead, blocks the lane.
      cost += o.d < c.d + 3 ? 60 : o.v < c.v - 0.5 ? 35 : 5;
    }
    // A lane squeezed by a narrow section (the car would hang off the road).
    if (Math.abs(lane) > t.half(c.d + ai.look) - CAR_HALF_W + 1) cost += 50;
    if (cost < bestCost) {
      bestCost = cost;
      best = lane;
    }
  }
  const diff = best - c.target;
  const n = Math.min(3, Math.round(Math.abs(diff) / STEER_STEP));
  for (let i = 0; i < n; i++) out.push(diff < 0 ? 'left' : 'right');
  return out;
}

/**
 * A driver for a networked car that sees only what a LAN client sees: the
 * snapshot (offset, distance, speed per car) and the track rebuilt from the
 * seed. Returns press codes to send (l, r, g, b, d). Used by `join --bot`.
 */
export function netDriver(
  t: Track,
  me: { off: number; d: number; v: number },
  others: Array<{ off: number; d: number; v: number }>,
): string {
  let out = '';
  const vmax = VMAX;
  let bend = 0;
  for (let k = 4; k <= 16; k += 4) bend = Math.max(bend, Math.abs(t.slope(me.d + k)));
  const want = vmax * (bend > 0.3 ? 0.72 : 0.93);
  if (me.v > want + 1.5) out += 'b';
  else if (me.v < want - 0.5) out += 'g';
  const lanes = laneOffsets(t);
  const hazards = t.hazardsIn(me.d, me.d + 18);
  let best = me.off;
  let bestCost = Infinity;
  for (const lane of lanes) {
    let cost = Math.abs(lane - me.off) * 0.6;
    for (const h of hazards) if (Math.abs(lane - h.off) < h.half + CAR_HALF_W + 1) cost += 100;
    for (const o of others) {
      if (o.d < me.d - 1 || o.d > me.d + 16 || Math.abs(lane - o.off) >= CAR_HALF_W * 2 + 0.5) continue;
      cost += o.d < me.d + 3 ? 60 : o.v < me.v - 0.5 ? 35 : 5;
    }
    if (Math.abs(lane) > t.half(me.d + 16) - CAR_HALF_W + 1) cost += 50;
    if (cost < bestCost) {
      bestCost = cost;
      best = lane;
    }
  }
  const diff = best - me.off;
  if (Math.abs(diff) > 1) out += (diff < 0 ? 'l' : 'r').repeat(Math.min(2, Math.round(Math.abs(diff) / STEER_STEP)));
  return out;
}
