import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import { generateSession } from '../src/core/session.js';
import { GAMES } from '../src/games/index.js';
import { defaultSave } from '../src/storage/save.js';
import { saveTimeRecords } from '../src/core/progression.js';
import { stripAnsi, visibleWidth } from '../src/ui/style.js';
import { LANE_W, MAX_SLOPE, START_CLEAR, Track, laneOffsets } from '../src/games/racing/track.js';
import { CAR_HALF_W, RaceSim, STEER_STEP, VMAX, type RacerSpec } from '../src/games/racing/sim.js';
import { aiField, netDriver } from '../src/games/racing/ai.js';
import { CARS, TRAFFIC, HAZARDS as HAZARD_SPRITES, ALL_RACING_SPRITES } from '../src/games/racing/sprites.js';
import { GrandPrix, Highway, TimeTrial, YOU, grandPrixDef, highwayDef, timeTrialDef } from '../src/games/racing/game.js';
import { RaceView, RACE_MIN_W } from '../src/games/racing/render.js';
import { glyphSpan } from '../src/ui/sprite.js';
import { ctx } from './helpers.js';

const solo = (over: Partial<RacerSpec> = {}): RacerSpec[] => [{ id: 'p', name: 'P', style: 0, human: true, ...over }];

function sim(opts: Partial<ConstructorParameters<typeof RaceSim>[0]> = {}, racers = solo()) {
  return new RaceSim({ mode: 'timetrial', seed: 'unit', preset: 'normal', laps: 1, countdownMs: 0, ...opts }, racers);
}

/** Run with the car driven by a strong AI brain. */
function autodrive(s: RaceSim, id = 'p') {
  s.car(id)!.ai = aiField('hard', 1, new Rng('auto'))[0];
}

describe('racing: physics', () => {
  it('accelerates to a capped top speed, brakes hard, coasts gently', () => {
    const s = sim();
    const c = s.car('p')!;
    s.step(1000);
    const v1 = c.v;
    expect(v1).toBeGreaterThan(5);
    s.step(9000);
    expect(c.v).toBeLessThanOrEqual(VMAX + 1e-9);
    expect(c.v).toBeGreaterThan(VMAX * 0.9);
    s.press('p', 'brake');
    const before = c.v;
    s.step(400);
    expect(c.v).toBeLessThan(before - 6);
    // The brake lets go once S stops repeating, and the car coasts.
    s.step(400);
    expect(c.pedal).toBe('coast');
    const coasting = c.v;
    s.step(500);
    expect(c.v).toBeLessThan(coasting);
    expect(c.v).toBeGreaterThan(coasting - 3);
    s.press('p', 'gas');
    s.step(500);
    expect(c.pedal).toBe('gas');
  });

  it('a steer press nudges a target line the car glides to; mashing cannot queue a huge swerve', () => {
    const s = sim();
    const c = s.car('p')!;
    s.step(3000);
    const x0 = c.off;
    s.press('p', 'right');
    expect(c.target - x0).toBeCloseTo(STEER_STEP, 5);
    s.press('p', 'right');
    expect(c.target - x0).toBeCloseTo(STEER_STEP * 2, 5);
    for (let i = 0; i < 30; i++) s.press('p', 'right');
    expect(c.target - c.off).toBeLessThanOrEqual(5.0001);
    s.step(500);
    expect(c.off).toBeGreaterThan(x0 + 3);
  });

  it('steering is slower at very low speed', () => {
    const fast = sim();
    fast.step(4000);
    const slow = sim();
    slow.step(60);
    for (const s of [fast, slow]) s.press('p', 'left');
    const f0 = fast.car('p')!.off;
    const s0 = slow.car('p')!.off;
    fast.step(40);
    slow.step(40);
    expect(Math.abs(fast.car('p')!.off - f0)).toBeGreaterThan(Math.abs(slow.car('p')!.off - s0));
  });

  it('the barrier stops the car leaving the track; grass is slow', () => {
    const s = sim();
    const c = s.car('p')!;
    s.step(4000);
    for (let i = 0; i < 400; i++) {
      s.press('p', 'right');
      s.step(25);
    }
    expect(Math.abs(c.off)).toBeLessThanOrEqual(s.offLimit(c.d) + 1e-9);
    expect(c.offroad).toBe(true);
    expect(c.v).toBeLessThanOrEqual(8 + 0.5);
    // Steer back toward the middle and the speed comes back.
    for (let i = 0; i < 120; i++) {
      if (c.target > 0) s.press('p', 'left');
      else if (c.target < -1) s.press('p', 'right');
      s.step(50);
    }
    expect(c.offroad).toBe(false);
    expect(c.v).toBeGreaterThan(12);
  });

  it('bends push a fast car outward; braking or drifting reduces the push', () => {
    // Find a sharp bend on a curvy track.
    const t = new Track({ seed: 'bendy', kind: 'circuit', preset: 'hard' });
    let d = 0;
    for (let x = START_CLEAR; x < t.lapLength; x++) if (Math.abs(t.slope(x)) > Math.abs(t.slope(d))) d = x;
    const run = (v: number, drift: boolean) => {
      const s = new RaceSim({ mode: 'timetrial', seed: 'bendy', preset: 'hard', laps: 1, countdownMs: 0 }, solo());
      const c = s.car('p')!;
      c.d = d - 2;
      c.v = v;
      c.pedal = 'coast';
      if (drift) s.press('p', 'drift');
      const before = c.off;
      s.step(200);
      return Math.abs(c.off - before);
    };
    expect(run(19, false)).toBeGreaterThan(run(10, false));
    expect(run(19, true)).toBeLessThan(run(19, false));
  });

  it('a double key press never makes the car uncontrollable', () => {
    const pressed = sim();
    const baseline = sim();
    pressed.step(3000);
    baseline.step(3000);
    pressed.press('p', 'left');
    pressed.press('p', 'left');
    pressed.step(400);
    baseline.step(400);
    const c = pressed.car('p')!;
    expect(c.spinMs).toBe(0);
    // Two quick presses move it about two steps from where it would have been; no spin, no swerve.
    expect(Math.abs(c.off - baseline.car('p')!.off)).toBeLessThan(STEER_STEP * 2 + 1);
    // A double drift press is one drift: the speed cost is paid once.
    const v = c.v;
    pressed.press('p', 'drift');
    pressed.press('p', 'drift');
    expect(c.v).toBeCloseTo(v * 0.92, 5);
  });

  it('rate-limits presses and ignores input from finished, unknown or bogus sources', () => {
    const s = sim();
    let accepted = 0;
    for (let i = 0; i < 200; i++) if (s.press('p', 'left')) accepted++;
    expect(accepted).toBeLessThanOrEqual(41);
    expect(s.press('nobody', 'gas')).toBe(false);
    expect(s.press('p', 'teleport' as never)).toBe(false);
    s.car('p')!.finishedMs = 1000;
    expect(s.press('p', 'gas')).toBe(false);
  });
});

describe('racing: collisions', () => {
  it('car-to-car contact slows the car behind, pushes them apart, and costs both a little', () => {
    const s = sim({ mode: 'lan' }, [
      { id: 'a', name: 'A', style: 0, human: true },
      { id: 'b', name: 'B', style: 1, human: true },
    ]);
    const a = s.car('a')!;
    const b = s.car('b')!;
    s.step(3000);
    a.d = b.d + 1;
    a.off = b.off = 0;
    a.target = b.target = 0;
    a.v = 10;
    b.v = 18;
    s.step(20);
    expect(b.v).toBeLessThan(18);
    expect(a.hits).toBe(1);
    expect(b.hits).toBe(1);
    expect(a.damage).toBeGreaterThan(0);
    expect(Math.abs(a.off - b.off) > 0 || a.d - b.d >= 3).toBe(true);
    // A pile-up doesn't charge the same contact every step.
    s.step(200);
    expect(a.hits).toBe(1);
    // Ghosted (disconnected) cars can't be hit.
    s.step(2000);
    a.ghost = true;
    a.d = b.d + 1;
    a.off = b.off;
    s.step(20);
    expect(b.hits).toBe(1);
  });

  it('hazards: oil spins you, barrels hurt, each counts once', () => {
    const t = new Track({ seed: 'haz', kind: 'circuit', preset: 'hard' });
    const oil = t.hazards.find((h) => h.kind === 'oil') ?? t.hazards[0];
    const s = new RaceSim({ mode: 'timetrial', seed: 'haz', preset: 'hard', laps: 1, countdownMs: 0 }, solo());
    const c = s.car('p')!;
    s.step(100);
    c.d = oil.d - 5;
    c.off = c.target = oil.off;
    c.v = 15;
    s.step(400);
    expect(c.hits).toBe(1);
    if (oil.kind === 'oil') expect(c.spinMs).toBeGreaterThan(0);
    expect(c.v).toBeLessThan(15);
    s.step(600);
    expect(c.hits).toBe(1);
  });

  it('hazard collisions use a hitbox, not the decorated art: passing a lane over is safe', () => {
    const t = new Track({ seed: 'haz2', kind: 'circuit', preset: 'normal' });
    const h = t.hazards[0];
    const s = new RaceSim({ mode: 'timetrial', seed: 'haz2', preset: 'normal', laps: 1, countdownMs: 0 }, solo());
    const c = s.car('p')!;
    s.step(100);
    c.d = h.d - 5;
    const side = h.off > 0 ? -1 : 1;
    c.off = c.target = h.off + side * (h.half + CAR_HALF_W + 0.1);
    c.v = 15;
    s.step(500);
    expect(c.hits).toBe(0);
  });
});

describe('racing: tracks', () => {
  it('the same seed builds the same track; another seed builds another', () => {
    const sample = (t: Track) => JSON.stringify([t.lapLength, t.lanes, t.conditions, t.hazards, [0, 77, 301].map((d) => [t.center(d), t.half(d)])]);
    const a = new Track({ seed: 'S1', kind: 'circuit', preset: 'normal' });
    expect(sample(a)).toBe(sample(new Track({ seed: 'S1', kind: 'circuit', preset: 'normal' })));
    expect(sample(a)).not.toBe(sample(new Track({ seed: 'S2', kind: 'circuit', preset: 'normal' })));
    // Fixing the weather doesn't reshuffle the rest of the track.
    const rainy = new Track({ seed: 'S1', kind: 'circuit', preset: 'normal', conditions: 'rain' });
    expect(rainy.conditions).toBe('rain');
    expect(JSON.stringify(rainy.hazards)).toBe(JSON.stringify(a.hazards));
    const h1 = new Track({ seed: 'H', kind: 'highway', preset: 'normal' });
    const h2 = new Track({ seed: 'H', kind: 'highway', preset: 'normal' });
    expect(JSON.stringify(h1.hazardsIn(0, 3000))).toBe(JSON.stringify(h2.hazardsIn(0, 3000)));
  });

  it('every generated track is drivable: smooth, closed, wide enough, hazards leave two lanes', () => {
    const problems: string[] = [];
    for (let i = 0; i < 40; i++) {
      for (const preset of ['easy', 'normal', 'hard'] as const) {
        const t = new Track({ seed: `fair-${i}`, kind: 'circuit', preset });
        const L = t.lapLength;
        if (Math.abs(t.center(0) - t.center(L)) > 1e-6) problems.push(`${i}/${preset}: lap doesn't close`);
        for (let d = 0; d < L; d++) {
          if (Math.abs(t.center(d + 1) - t.center(d)) > MAX_SLOPE + 1e-6) problems.push(`${i}/${preset}@${d}: too sharp`);
          // Narrow sections squeeze the lanes but always leave well over two lanes' width.
          if (t.half(d) * 2 < LANE_W * 2 + 2) problems.push(`${i}/${preset}@${d}: too narrow`);
        }
        for (const h of t.hazards) {
          if (h.d < START_CLEAR || h.d > L - START_CLEAR) problems.push(`${i}/${preset}: hazard near the line`);
          if (Math.abs(h.off) + h.half > t.half(h.d)) problems.push(`${i}/${preset}: hazard off the road`);
          // Free road beside the hazard, on its wider side, fits two lanes.
          const free = Math.max(t.half(h.d) - (h.off + h.half), h.off - h.half + t.half(h.d));
          if (free < LANE_W * 2) problems.push(`${i}/${preset}@${h.d}: only ${free.toFixed(1)} columns free`);
        }
        const ds = t.hazards.map((h) => h.d);
        for (let k = 1; k < ds.length; k++) if (ds[k] - ds[k - 1] < 30) problems.push(`${i}/${preset}: hazards bunched`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('circuit hazards repeat every lap, and the highway is endless', () => {
    const t = new Track({ seed: 'rep', kind: 'circuit', preset: 'normal' });
    const lap1 = t.hazardsIn(0, t.lapLength).map((h) => [h.off, h.d]);
    const lap2 = t.hazardsIn(t.lapLength, 2 * t.lapLength).map((h) => [h.off, h.d - t.lapLength]);
    expect(lap2).toEqual(lap1);
    const hw = new Track({ seed: 'hw', kind: 'highway', preset: 'hard' });
    expect(hw.lapLength).toBe(Infinity);
    expect(hw.hazardsIn(50_000, 52_000).length).toBeGreaterThan(0);
    expect(Math.abs(hw.center(50_001) - hw.center(50_000))).toBeLessThanOrEqual(MAX_SLOPE);
  });
});

describe('racing: laps and the finish', () => {
  it('counts laps (not the start line), times them, and interpolates the finish', () => {
    const s = sim({ laps: 2, countdownMs: 1000 });
    autodrive(s);
    const events: string[] = [];
    let finish = 0;
    while (s.phase !== 'done' && s.time < 200_000) {
      s.step(100);
      for (const e of s.takeEvents()) {
        events.push(e.kind);
        if (e.kind === 'finish') finish = e.ms;
      }
    }
    const c = s.car('p')!;
    expect(events.filter((e) => e === 'go')).toHaveLength(1);
    expect(events.filter((e) => e === 'lap')).toHaveLength(1);
    expect(events.filter((e) => e === 'finish')).toHaveLength(1);
    expect(c.lapTimes).toHaveLength(2);
    expect(c.finishedMs).toBe(finish);
    // Interpolated, not rounded to a 100ms step boundary.
    expect(c.finishedMs! % 20).not.toBe(0);
    expect(Math.abs(c.lapTimes[0] + c.lapTimes[1] - c.finishedMs!)).toBeLessThanOrEqual(2);
    expect(s.lapOf(c)).toBe(2);
    expect(s.phase).toBe('done');
  });

  it('cars cannot move during the countdown', () => {
    const s = sim({ countdownMs: 3000 });
    s.press('p', 'gas');
    s.step(2900);
    expect(s.car('p')!.d).toBeLessThan(0);
    expect(s.car('p')!.v).toBe(0);
    expect(s.phase).toBe('countdown');
  });

  it('standings: finishers by time, then by distance, retired last', () => {
    const s = sim({ mode: 'lan', laps: 1 }, [
      { id: 'a', name: 'A', style: 0, human: true },
      { id: 'b', name: 'B', style: 1, human: true },
      { id: 'c', name: 'C', style: 2, human: true },
    ]);
    s.step(100);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => s.car(id)!);
    a.d = 100;
    b.d = 200;
    c.d = 300;
    expect(s.standings().map((r) => r.id)).toEqual(['c', 'b', 'a']);
    a.finishedMs = 30_000;
    expect(s.standings().map((r) => r.id)).toEqual(['a', 'c', 'b']);
    s.retire('c');
    expect(s.standings().map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(s.standings()[2].retired).toBe(true);
  });

  it('the finish window ends the race for stragglers', () => {
    const s = sim({ mode: 'lan', laps: 1, finishWindowMs: 5000 }, [
      { id: 'a', name: 'A', style: 0, human: true },
      { id: 'b', name: 'B', style: 1, human: true },
    ]);
    autodrive(s, 'a');
    s.car('b')!.pedal = 'coast';
    while (s.car('a')!.finishedMs === null) s.step(100);
    expect(s.phase).toBe('racing');
    s.step(5200);
    expect(s.phase).toBe('done');
    expect(s.standings().map((r) => r.id)).toEqual(['a', 'b']);
    expect(s.standings()[1].finishedMs).toBeNull();
  });
});

describe('racing: AI', () => {
  it('AI drivers finish races, stay on the road and mostly avoid hazards', () => {
    for (const seed of ['ai-1', 'ai-2', 'ai-3']) {
      const field = aiField('normal', 4, new Rng(seed));
      const s = new RaceSim({ mode: 'grandprix', seed, preset: 'normal', laps: 2, finishWindowMs: 60_000 },
        field.map((ai, i) => ({ id: `c${i}`, name: ai.name, style: i, ai, human: i === 0 })));
      let offroad = 0;
      let steps = 0;
      const hazardHits = new Map<string, number>();
      while (s.phase !== 'done' && s.time < 300_000) {
        s.step(100);
        steps++;
        offroad += s.cars.filter((c) => c.offroad).length;
        for (const e of s.takeEvents()) if (e.kind === 'hazard') hazardHits.set(e.id, (hazardHits.get(e.id) ?? 0) + 1);
      }
      expect(s.phase).toBe('done');
      expect(s.car('c0')!.finishedMs).not.toBeNull();
      expect(offroad / steps / 4).toBeLessThan(0.05);
      // Two laps pass every hazard twice; AI hits well under half of them.
      const passed = s.track.hazards.length * 2;
      for (const c of s.racers) expect(hazardHits.get(c.id) ?? 0, `${c.id} on ${seed}`).toBeLessThanOrEqual(Math.ceil(passed / 2));
    }
  });

  it('harder AI is faster', () => {
    const lapTime = (preset: 'easy' | 'hard') => {
      const [ai] = aiField(preset, 1, new Rng('pace'));
      const s = new RaceSim({ mode: 'timetrial', seed: 'pace', preset: 'normal', laps: 2 }, [{ id: 'x', name: 'x', style: 0, ai, human: true }]);
      while (s.phase !== 'done' && s.time < 300_000) s.step(100);
      return s.car('x')!.finishedMs!;
    };
    expect(lapTime('hard')).toBeLessThan(lapTime('easy'));
  });

  it('the network driver sees only snapshot data and still drives sensibly', () => {
    const t = new Track({ seed: 'nd', kind: 'circuit', preset: 'normal' });
    expect(netDriver(t, { off: 0, d: 10, v: 2 }, [])).toContain('g');
    expect(netDriver(t, { off: 0, d: 10, v: 30 }, [])).toContain('b');
    // Something right in front: change lanes.
    const lanes = laneOffsets(t);
    const out = netDriver(t, { off: lanes[1], d: 10, v: 15 }, [{ off: lanes[1], d: 13, v: 5 }]);
    expect(out).toMatch(/[lr]/);
  });
});

describe('racing: sprites and rendering', () => {
  it('vehicle sprites: same footprint, distinct looks, every frame, body hitboxes', () => {
    const looks = new Set<string>();
    for (const s of [...CARS, ...TRAFFIC]) {
      expect(s.width).toBe(5);
      expect(s.height).toBe(3);
      expect(s.anchor).toEqual({ x: 2, y: 2 });
      expect(s.hitbox).toEqual([{ dx: -2, dy: 0, w: 5, h: 3 }]);
      expect(s.compact).not.toBeNull();
      looks.add(s.frames[0].join('\n'));
    }
    expect(looks.size).toBe(CARS.length + TRAFFIC.length);
    for (const s of CARS) expect(s.frames).toHaveLength(4);
    for (const s of ALL_RACING_SPRITES) for (const f of s.frames) {
      expect(glyphSpan(f[0])).not.toBeNull();
      for (const row of f) expect(row).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(Object.keys(HAZARD_SPRITES)).toEqual(['cone', 'oil', 'pothole', 'barrel']);
  });

  it('renders every mode at every size without overflowing, in plain ASCII', () => {
    for (const make of [(c: ReturnType<typeof ctx>) => new GrandPrix(c), (c: ReturnType<typeof ctx>) => new TimeTrial(c), (c: ReturnType<typeof ctx>) => new Highway(c)]) {
      const g = make(ctx('render'));
      autodrive(g.sim, YOU);
      for (let i = 0; i < 300; i++) g.update(33);
      for (const [w, h] of [[RACE_MIN_W, 17], [60, 20], [76, 18], [120, 40]]) {
        g.setViewport(w, h);
        const lines = g.render();
        expect(lines.length).toBeGreaterThanOrEqual(17);
        for (const l of lines) {
          expect(visibleWidth(l)).toBeLessThanOrEqual(Math.max(w, RACE_MIN_W));
          expect(stripAnsi(l)).toMatch(/^[\x20-\x7e]*$/);
        }
      }
      // Without a viewport it stays within minSize.
      const fresh = make(ctx('render2'));
      for (const l of fresh.render()) expect(visibleWidth(l)).toBeLessThanOrEqual(fresh.minSize.width);
    }
  });

  it('shows the road, your car and rivals with name tags', () => {
    const g = new GrandPrix(ctx('look'));
    g.setViewport(76, 18);
    for (let i = 0; i < 20; i++) g.update(33);
    const text = g.render().map(stripAnsi).join('\n');
    expect(text).toContain('/^\\'); // your car's nose
    expect(text).toMatch(/\[\|=\|\]/);
    expect(text).toMatch(/#=#=|=#=#/); // start line
    expect(text).toContain('[  ');
    const tags = g.sim.racers.filter((c) => c.id !== YOU).map((c) => c.name.slice(0, 8));
    expect(tags.some((t) => text.includes(t))).toBe(true);
  });

  it('the renderer only reads the scene (no simulation state changes)', () => {
    const g = new GrandPrix(ctx('pure'));
    for (let i = 0; i < 100; i++) g.update(33);
    const before = JSON.stringify(g.sim.cars.map((c) => [c.d, c.off, c.v]));
    for (let i = 0; i < 5; i++) g.render();
    expect(JSON.stringify(g.sim.cars.map((c) => [c.d, c.off, c.v]))).toBe(before);
    expect(new RaceView()).toBeDefined();
  });
});

describe('racing: arcade modes', () => {
  it('Grand Prix: race three AI rivals to the flag, score by place, track positions', () => {
    const g = new GrandPrix({ ...ctx('gp'), durationMs: null });
    autodrive(g.sim, YOU);
    expect(g.hud().find((h) => h.label === 'POS')?.value).toBe('4/4');
    let t = 0;
    while (!g.isOver() && t < 400_000) {
      g.update(50);
      t += 50;
    }
    expect(g.isOver()).toBe(true);
    const r = g.result();
    expect(r.endReason).toBe('win');
    expect(r.stats.races).toBe(1);
    expect(g.place).toBeGreaterThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(250);
    expect(r.metrics.find(([k]) => k === 'Laps')![1].split('  ')).toHaveLength(3);
  });

  it('Time Trial: records the time, splits and a ghost; keeps only a faster record', () => {
    const run = (records?: Record<string, import('../src/core/types.js').TimeRecord>) => {
      const g = new TimeTrial({ ...ctx('tt'), durationMs: null, ...(records ? { records } : {}) });
      autodrive(g.sim, YOU);
      while (!g.isOver()) g.update(50);
      return g;
    };
    const first = run();
    const r = first.result();
    expect(r.records).toHaveLength(1);
    const rec = r.records![0];
    expect(rec.key).toBe(first.recordKey);
    expect(rec.splits).toHaveLength(2);
    expect(rec.ghost!.length).toBeGreaterThan(100);

    const save = defaultSave();
    const session = generateSession(GAMES, { gameId: 'timetrial', seed: 'tt' });
    expect(saveTimeRecords(save, session, r)).toEqual([rec.key]);
    expect(saveTimeRecords(save, session, { ...r, records: [{ ...rec, ms: rec.ms + 500 }] })).toEqual([]);
    expect(save.timeRecords[rec.key].ms).toBe(rec.ms);
    expect(saveTimeRecords(save, session, { ...r, records: [{ ...rec, ms: rec.ms - 500 }] })).toEqual([rec.key]);

    // Same seed again: same track, the best shows in the HUD and as a ghost.
    const second = new TimeTrial({ ...ctx('tt'), durationMs: null, records: save.timeRecords });
    expect(second.recordKey).toBe(first.recordKey);
    expect(second.hud().find((h) => h.label === 'PB')!.value).not.toBe('-');
    expect(second.ghostAt(5000)).not.toBeNull();
    // Running slower than the record never ends the run.
    for (let i = 0; i < 2000 && !second.isOver(); i++) second.update(50);
    expect(second.result().endReason).not.toBe('time');
  });

  it('Endless Highway: no clock; it ends only when the car is wrecked (or you quit)', () => {
    const g = new Highway({ ...ctx('hw'), durationMs: null });
    expect(g.timeLeftMs()).toBeNull();
    autodrive(g.sim, YOU);
    for (let i = 0; i < 1200; i++) g.update(50);
    expect(g.isOver()).toBe(false);
    expect(g.sim.car(YOU)!.d).toBeGreaterThan(500);
    expect(g.sim.cars.some((c) => c.traffic)).toBe(true);
    expect(g.score).toBeGreaterThan(400);
    g.sim.car(YOU)!.damage = g.sim.cfg.damageLimit;
    for (let i = 0; i < 60 && !g.isOver(); i++) g.update(50);
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('Rush Hour (timed highway) ends on the clock', () => {
    const g = new Highway(ctx('rush', { durationMs: 5000 }));
    for (let i = 0; i < 200 && !g.isOver(); i++) g.update(50);
    expect(g.result().endReason).toBe('time');
  });

  it('races never get a deadline, and sit out the (always timed) daily challenge', () => {
    for (const id of ['racing', 'timetrial']) {
      const s = generateSession(GAMES, { gameId: id, durationSec: 30, untimed: false });
      expect(s.durationMs).toBeNull();
      expect(s.timingNote).toBeUndefined();
    }
    for (let d = 1; d <= 60; d++) {
      const s = generateSession(GAMES, { daily: `2026-11-${String((d % 28) + 1).padStart(2, '0')}`, seed: String(d) });
      expect(['racing', 'timetrial']).not.toContain(s.gameId);
      expect(s.durationMs).not.toBeNull();
    }
    expect(grandPrixDef.untimedOnly && timeTrialDef.untimedOnly).toBe(true);
    expect(highwayDef.modeNames).toEqual({ timed: 'Rush Hour', untimed: 'Endless Highway' });
  });

  it('modifiers apply to every car alike', () => {
    const g = new GrandPrix(ctx('mod', { effects: { speed: 1.2 } }));
    expect(g.sim.cfg.speedMult).toBe(1.2);
    for (let i = 0; i < 400; i++) g.update(33);
    expect(Math.max(...g.sim.racers.map((c) => c.v))).toBeGreaterThan(VMAX);
  });
});

describe('racing: in the arcade app', () => {
  it('Time Trial through the real App at 80x24: race, results, record saved; the arcade lists all ten games', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { App } = await import('../src/ui/app.js');
    const { FakeTerminal } = await import('../src/ui/terminal.js');
    const { SaveStore } = await import('../src/storage/save.js');
    const { FakeScheduler } = await import('./helpers.js');
    const store = new SaveStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-race-')), 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, scheduler: sched, start: { mode: 'play', session: { gameId: 'timetrial', seed: 'APP-TT' } } });
    const done = app.run();
    io.send('\r');
    const text = () => app.frame.map(stripAnsi).join('\n');
    sched.advance(500);
    expect(text()).toContain('RACING: TIME TRIAL');
    expect(text()).toContain('NO TIMER');
    expect(text()).toMatch(/LAP 1\/2/);
    expect(app.frame.every((l) => visibleWidth(l) <= 80)).toBe(true);
    const g = app.currentGame as TimeTrial;
    autodrive(g.sim, YOU);
    sched.advance(150_000);
    expect(app.stateKind).toBe('results');
    expect(text()).toMatch(/Time\s+\d:\d\d\.\d\d/);
    const rec = store.load().data.timeRecords[g.recordKey];
    expect(rec.ms).toBe(g.sim.car(YOU)!.finishedMs);
    expect(rec.ghost!.length).toBeGreaterThan(100);
    sched.advance(700);
    // Retry from the results screen: the same track, so the record now shows as BEST.
    io.send('r');
    sched.advance(200); // menus ignore a second Enter within 150ms
    io.send('\r'); // briefing: start
    sched.advance(300);
    expect((app.currentGame as TimeTrial).recordKey).toBe(g.recordKey);
    // The whole HUD fits 80 columns: the last item isn't cut off.
    expect(text()).toMatch(/PB \d:\d\d\.\d\d\s*$/m);
    io.send('q'); // end the round
    sched.advance(700);
    io.send('m');
    io.send('2');
    expect(text()).toContain('Racing: Grand Prix');
    expect(text()).toContain('Racing: Highway');
    expect(app.frame.length).toBeLessThanOrEqual(24);
    io.send('0'); // the tenth game
    expect(text()).toContain('RACING: HIGHWAY');
    app.quit();
    await done;
  }, 30_000);
});
