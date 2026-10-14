import { BaseGame } from '../../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key, TimeRecord } from '../../core/types.js';
import { KMH, RaceSim, type Car, type Press, type RaceEvent } from './sim.js';
import { aiField } from './ai.js';
import { RACE_MIN_H, RACE_MIN_W, RaceView, type Scene, type SceneCar } from './render.js';
import type { Preset } from './track.js';

/**
 * C-Cade Racing in the arcade: Grand Prix (vs AI), Time Trial (alone,
 * against the clock and your ghost) and Highway (endless traffic). All three
 * are thin shells around the shared RaceSim and RaceView; the LAN version
 * (src/games/racing/mp.ts) drives the very same simulation on the server.
 */

export const YOU = 'you';
const GP_LAPS = 3;
const TT_LAPS = 2;
/** Ghost samples: one [offset*10, distance*10] pair every GHOST_MS of race time. */
const GHOST_MS = 100;
const HOLD_MS = 1500;
const PLACE_POINTS = [1000, 700, 500, 350, 250, 180, 120, 80];

export function fmtMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** Map a key to a race input, or null. Shared by the arcade and the LAN client. */
export function pressFor(key: Key): Press | null {
  const ch = key.name === 'char' && !key.ctrl ? key.ch?.toLowerCase() : undefined;
  if (key.name === 'left' || ch === 'a') return 'left';
  if (key.name === 'right' || ch === 'd') return 'right';
  if (key.name === 'up' || ch === 'w') return 'gas';
  if (key.name === 'down' || ch === 's') return 'brake';
  if (key.name === 'space') return 'drift';
  return null;
}

/** The view of a sim car the renderer needs. */
function sceneCar(c: Car, you: boolean): SceneCar {
  return {
    id: c.id, name: c.name, style: c.style, off: c.off, d: c.d, steer: c.steer, slide: c.driftMs > 0 || c.spinMs > 0,
    ghost: c.ghost, finished: c.finishedMs !== null, you,
  };
}

abstract class RaceGame extends BaseGame {
  readonly minSize = { width: RACE_MIN_W, height: RACE_MIN_H };
  readonly sim: RaceSim;
  protected readonly view = new RaceView();
  protected viewW: number | null = null;
  protected viewH: number | null = null;
  protected holdMs = 0;
  protected banner: string | null = null;
  protected readonly preset: Preset;
  protected readonly trackSeed: string;
  private anim = 0;

  constructor(ctx: GameContext) {
    super(ctx);
    this.preset = ctx.difficulty;
    // Derived from the session seed, so the same session is the same track.
    this.trackSeed = `${this.rng.fork('track').int(0, 0x7fffffff).toString(36)}`;
    this.sim = this.makeSim();
  }

  protected abstract makeSim(): RaceSim;

  get me(): Car {
    return this.sim.car(YOU)!;
  }

  protected tick(dt: number): void {
    this.anim += dt;
    if (this.holdMs > 0) {
      this.sim.step(dt);
      this.holdMs -= dt;
      if (this.holdMs <= 0) this.end(this.endReasonOnFinish());
      return;
    }
    this.sim.step(dt);
    for (const e of this.sim.takeEvents()) this.onEvent(e);
    if (this.sim.phase === 'done' && !this.isOver()) this.finish();
  }

  protected endReasonOnFinish(): 'win' | 'gameover' {
    return 'win';
  }

  /** The race is over for the player: score it, then hold the view a moment. */
  protected abstract finish(): void;

  protected onEvent(e: RaceEvent): void {
    if (e.kind === 'go') this.flash('GO! GO! GO!', 'good', 800);
    if (e.kind === 'gust') this.flash('Crosswind!', 'info', 700);
    if ('id' in e && e.id !== YOU) return;
    if (e.kind === 'crash') this.flash('Contact! Lost speed.', 'bad', 600);
    else if (e.kind === 'hazard') {
      const msg = { cone: 'Clipped a cone', oil: 'Oil slick! Spinning', pothole: 'Pothole!', barrel: 'Hit a barrel!' }[e.hazard];
      this.flash(msg, 'bad', 700);
    }
  }

  protected onKey(key: Key): void {
    const p = pressFor(key);
    if (p) this.sim.press(YOU, p);
  }

  setViewport(width: number, height: number): void {
    this.viewW = width;
    this.viewH = height;
  }

  protected scene(): Scene {
    return {
      track: this.sim.track,
      cars: this.sim.cars.map((c) => sceneCar(c, c.id === YOU)),
      focusD: this.me.d,
      focusOff: this.me.off,
      anim: this.anim,
      phase: this.sim.phase,
      countdownMs: -this.sim.time,
      banner: this.banner,
    };
  }

  render(): string[] {
    const w = Math.min(this.viewW ?? this.minSize.width, 78);
    const h = Math.max(RACE_MIN_H, Math.min(this.viewH ?? this.minSize.height, 26));
    return this.view.render(this.scene(), w, h);
  }

  protected speedItem(): HudItem {
    // Unlabelled: "194km/h" says what it is, and the HUD has to fit 80 columns.
    const kmh = Math.round(this.me.v * KMH);
    return { label: '', value: `${kmh}km/h`, tone: this.me.offroad ? 'bad' : kmh >= 170 ? 'gold' : 'info' };
  }

  protected raceClock(): number {
    return Math.max(0, this.me.finishedMs ?? this.sim.time);
  }
}

/* ------------------------------------------------------------ Grand Prix */

export class GrandPrix extends RaceGame {
  place = 0;

  constructor(ctx: GameContext) {
    super(ctx);
  }

  protected makeSim(): RaceSim {
    const field = aiField(this.preset, 3, this.rng.fork('field'));
    return new RaceSim(
      { mode: 'grandprix', seed: this.trackSeed, preset: this.preset, laps: GP_LAPS, speedMult: this.effects.speed, chaos: this.effects.chaos },
      [
        // You start at the back of the grid: overtaking is the point.
        ...field.map((ai, i) => ({ id: `ai${i}`, name: ai.name, style: i + 1, ai })),
        { id: YOU, name: 'YOU', style: 0, human: true },
      ],
    );
  }

  protected onEvent(e: RaceEvent): void {
    super.onEvent(e);
    if (e.kind === 'lap' && e.id === YOU) this.flash(`Lap ${e.lap}/${GP_LAPS}  ${fmtMs(e.ms)}  P${this.sim.placeOf(YOU)}`, 'info', 1200);
  }

  protected finish(): void {
    this.place = this.sim.placeOf(YOU);
    const clean = this.me.hits === 0;
    const pts = PLACE_POINTS[this.place - 1] ?? 50;
    this.addScore(pts + (clean ? 200 : 0));
    this.banner = this.place === 1 ? 'CHECKERED FLAG - YOU WIN!' : `FINISHED P${this.place}`;
    this.flash(`${this.banner}  ${fmtMs(this.raceClock())}${clean ? '  clean race +200' : ''}`, this.place === 1 ? 'gold' : 'good', HOLD_MS);
    this.holdMs = HOLD_MS;
  }

  protected scene(): Scene {
    const s = super.scene();
    s.standings = this.sim.standings().map((r) => `${r.place}. ${r.id === YOU ? 'YOU' : r.name.slice(0, 12)}`);
    return s;
  }

  hud(): HudItem[] {
    const lap = Math.min(GP_LAPS, this.sim.lapOf(this.me) + 1);
    return [
      { label: 'LAP', value: `${lap}/${GP_LAPS}` },
      { label: 'POS', value: `${this.sim.placeOf(YOU)}/${this.sim.racers.length}`, tone: this.sim.placeOf(YOU) === 1 ? 'gold' : 'info' },
      this.speedItem(),
      { label: 'RACE', value: fmtMs(this.raceClock()) },
    ];
  }

  protected stats(): Record<string, number> {
    const done = this.me.finishedMs !== null;
    return {
      races: done ? 1 : 0,
      wins: done && this.place === 1 ? 1 : 0,
      podiums: done && this.place <= 3 ? 1 : 0,
      collisions: this.me.hits,
    };
  }

  protected metrics(): Array<[string, string]> {
    const st = this.sim.standings();
    const laps = this.me.lapTimes;
    return [
      ['Position', this.me.finishedMs !== null ? `${this.place} of ${st.length}` : 'did not finish'],
      ['Race time', this.me.finishedMs !== null ? fmtMs(this.me.finishedMs) : '-'],
      ['Best lap', laps.length ? fmtMs(Math.min(...laps)) : '-'],
      ['Laps', laps.map(fmtMs).join('  ') || '-'],
      ['Collisions', String(this.me.hits)],
      ['Track', `${this.sim.track.conditions}, ${this.sim.track.lanes} lanes`],
    ];
  }

  protected isPerfect(): boolean {
    return this.place === 1 && this.me.hits === 0;
  }
}

/* ------------------------------------------------------------ Time Trial */

export class TimeTrial extends RaceGame {
  readonly recordKey: string;
  readonly best: TimeRecord | null;
  private readonly samples: number[] = [];
  private nextSample = 0;

  constructor(ctx: GameContext) {
    super(ctx);
    this.recordKey = `timetrial:${this.trackSeed}:${this.preset}`;
    this.best = ctx.records?.[this.recordKey] ?? null;
  }

  protected makeSim(): RaceSim {
    return new RaceSim(
      { mode: 'timetrial', seed: this.trackSeed, preset: this.preset, laps: TT_LAPS, speedMult: this.effects.speed, chaos: this.effects.chaos },
      [{ id: YOU, name: 'YOU', style: 0, human: true }],
    );
  }

  protected tick(dt: number): void {
    super.tick(dt);
    while (this.sim.phase === 'racing' && this.sim.time >= this.nextSample && this.samples.length < 2400) {
      this.samples.push(Math.round(this.me.off * 10), Math.round(this.me.d * 10));
      this.nextSample += GHOST_MS;
    }
  }

  protected onEvent(e: RaceEvent): void {
    super.onEvent(e);
    if (e.kind === 'lap' && e.id === YOU) {
      const ref = this.best?.splits[e.lap - 1];
      const delta = ref !== undefined ? `  (${e.ms <= ref ? '-' : '+'}${(Math.abs(e.ms - ref) / 1000).toFixed(2)})` : '';
      this.flash(`Lap ${e.lap}/${TT_LAPS}  ${fmtMs(e.ms)}${delta}`, ref !== undefined && e.ms <= ref ? 'good' : 'info', 1500);
    }
  }

  protected finish(): void {
    const ms = this.me.finishedMs;
    if (ms === null) return;
    this.addScore(Math.round(6e7 / ms));
    const record = !this.best || ms < this.best.ms;
    this.banner = record ? `NEW RECORD ${fmtMs(ms)}` : `FINISH ${fmtMs(ms)}`;
    this.flash(record ? `New record! ${fmtMs(ms)}${this.best ? `  (-${((this.best.ms - ms) / 1000).toFixed(2)}s)` : ''}` : `${fmtMs(ms)}  (+${((ms - this.best!.ms) / 1000).toFixed(2)}s off your best)`, record ? 'gold' : 'info', HOLD_MS);
    this.holdMs = HOLD_MS;
  }

  /** Your best run, replayed by race time. */
  ghostAt(t: number): { off: number; d: number } | null {
    const g = this.best?.ghost;
    if (!g || g.length < 4 || t < 0) return null;
    const i = t / GHOST_MS;
    const a = Math.floor(i);
    if (a * 2 + 3 >= g.length) return null;
    const f = i - a;
    return { off: (g[a * 2] + (g[a * 2 + 2] - g[a * 2]) * f) / 10, d: (g[a * 2 + 1] + (g[a * 2 + 3] - g[a * 2 + 1]) * f) / 10 };
  }

  protected scene(): Scene {
    return { ...super.scene(), ghost: this.ghostAt(this.sim.time) };
  }

  hud(): HudItem[] {
    const lap = Math.min(TT_LAPS, this.sim.lapOf(this.me) + 1);
    return [
      { label: 'LAP', value: `${lap}/${TT_LAPS}  ${fmtMs(this.raceClock())}`, tone: this.best && this.raceClock() > this.best.ms ? 'bad' : 'info' },
      this.speedItem(),
      { label: 'PB', value: this.best ? fmtMs(this.best.ms) : '-', tone: 'gold' },
    ];
  }

  /** The candidate record (progression keeps it only if it's faster). */
  result() {
    const r = super.result();
    const ms = this.me.finishedMs;
    if (ms !== null) r.records = [{ key: this.recordKey, ms, splits: [...this.me.lapTimes], ghost: [...this.samples] }];
    return r;
  }

  protected stats(): Record<string, number> {
    return { runs: this.me.finishedMs !== null ? 1 : 0, collisions: this.me.hits };
  }

  protected metrics(): Array<[string, string]> {
    const ms = this.me.finishedMs;
    return [
      ['Time', ms !== null ? fmtMs(ms) : 'did not finish'],
      ['Personal best', this.best ? fmtMs(Math.min(this.best.ms, ms ?? Infinity)) : ms !== null ? fmtMs(ms) : '-'],
      ['Splits', this.me.lapTimes.map(fmtMs).join('  ') || '-'],
      ['Collisions', String(this.me.hits)],
      ['Track seed', `${this.trackSeed} (${this.preset})`],
    ];
  }

  protected isPerfect(): boolean {
    return this.me.finishedMs !== null && this.me.hits === 0;
  }
}

/* --------------------------------------------------------------- Highway */

export class Highway extends RaceGame {
  private banked = 0;

  constructor(ctx: GameContext) {
    super(ctx);
  }

  protected makeSim(): RaceSim {
    const lives = this.effects.lives;
    return new RaceSim(
      {
        mode: 'highway', seed: this.trackSeed, preset: this.preset, laps: 1, countdownMs: 1500, speedMult: this.effects.speed, chaos: this.effects.chaos,
        // Low Battery / Glass Cannon: a car that takes fewer knocks.
        damageLimit: lives ? Math.max(30, lives * 30) : 100,
      },
      [{ id: YOU, name: 'YOU', style: 0, human: true }],
    );
  }

  protected tick(dt: number): void {
    super.tick(dt);
    // 1 point per metre, banked in tens so modifiers apply cleanly.
    while (this.me.d - this.banked >= 10) {
      this.banked += 10;
      this.addScore(10);
    }
  }

  protected endReasonOnFinish(): 'win' | 'gameover' {
    return 'gameover';
  }

  protected onEvent(e: RaceEvent): void {
    super.onEvent(e);
    if (!('id' in e) || e.id !== YOU) return;
    if (e.kind === 'overtake') {
      const pts = this.addScore(e.near ? 40 : 25);
      if (e.near) this.flash(`Close call! +${pts}`, 'gold', 500);
    } else if (e.kind === 'pickup') {
      if (e.pickup === 'coin') this.flash(`Coin +${this.addScore(50)}`, 'gold', 400);
      else this.flash('Wrench: repaired!', 'good', 700);
    }
  }

  protected finish(): void {
    this.banner = 'WRECKED';
    this.flash(`Wrecked after ${Math.round(this.me.d)}m.`, 'bad', HOLD_MS);
    this.holdMs = HOLD_MS;
  }

  damage(): number {
    return Math.min(100, Math.round((this.me.damage / this.sim.cfg.damageLimit) * 100));
  }

  hud(): HudItem[] {
    const dmg = this.damage();
    return [
      { label: 'DIST', value: `${Math.round(Math.max(0, this.me.d))}m` },
      this.speedItem(),
      { label: 'DMG', value: `${dmg}%`, tone: dmg >= 70 ? 'bad' : dmg >= 40 ? 'gold' : 'good' },
      { label: 'PASS', value: String(this.me.overtakes) },
    ];
  }

  protected stats(): Record<string, number> {
    return {
      distance: Math.round(Math.max(0, this.me.d)),
      overtakes: this.me.overtakes,
      nearMisses: this.me.nearMisses,
      coins: this.me.coins,
      collisions: this.me.hits,
    };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Distance', `${Math.round(Math.max(0, this.me.d))}m`],
      ['Cars overtaken', String(this.me.overtakes)],
      ['Close calls', String(this.me.nearMisses)],
      ['Coins', String(this.me.coins)],
      ['Collisions', String(this.me.hits)],
      ['Damage', `${this.damage()}%`],
    ];
  }

  protected isPerfect(): boolean {
    return this.me.hits === 0 && this.me.d >= 2000;
  }
}

/* ------------------------------------------------------------ registry */

const CONTROLS: Array<[string, string]> = [
  ['A/D or Left/Right', 'steer (tap to nudge, hold to swerve)'],
  ['W or Up', 'gas (stays on)'],
  ['S or Down', 'brake (hold), then coast'],
  ['Space', 'drift through a bend'],
  ['P / R / Q', 'pause / restart / end'],
];

export const grandPrixDef: GameDefinition = {
  id: 'racing',
  name: 'Racing: Grand Prix',
  genre: 'Racing vs AI',
  tagline: `${GP_LAPS} laps against three AI rivals. Start last, finish first.`,
  controls: CONTROLS,
  weight: 1,
  xpScale: 10,
  excludedModifiers: ['low-battery', 'glass-cannon', 'bug-bounty'],
  appKeys: { pause: ['p'], restart: ['r'], quit: ['q'] },
  create: (ctx) => new GrandPrix(ctx),
};

export const timeTrialDef: GameDefinition = {
  id: 'timetrial',
  name: 'Racing: Time Trial',
  genre: 'Racing vs the clock',
  tagline: `${TT_LAPS} laps alone. Beat your best time and your ghost.`,
  controls: CONTROLS,
  weight: 1,
  retrySameSeed: true,
  xpScale: 10,
  excludedModifiers: ['low-battery', 'glass-cannon', 'bug-bounty'],
  appKeys: { pause: ['p'], restart: ['r'], quit: ['q'] },
  create: (ctx) => new TimeTrial(ctx),
};

export const highwayDef: GameDefinition = {
  id: 'highway',
  name: 'Racing: Highway',
  genre: 'Endless traffic',
  tagline: 'Weave through endless traffic. Overtake, collect coins, keep it in one piece.',
  controls: CONTROLS,
  weight: 2,
  xpScale: 14,
  appKeys: { pause: ['p'], restart: ['r'], quit: ['q'] },
  create: (ctx) => new Highway(ctx),
};
