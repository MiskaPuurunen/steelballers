import type {
  EndReason, Effects, GameContext, GameInstance, GameResult, HudItem, Key, Tone, Difficulty,
} from './types.js';
import type { Rng } from './rng.js';
import { difficultyLevel } from './modifiers.js';


export abstract class BaseGame implements GameInstance {
  abstract readonly minSize: { width: number; height: number };

  protected readonly rng: Rng;
  protected readonly effects: Effects;
  protected readonly difficulty: Difficulty;
  protected readonly level: 0 | 1 | 2;

  protected elapsedMs = 0;
  protected endReason: EndReason | null = null;
  private _score = 0;
  private fb: { text: string; tone: Tone; ttl: number } | null = null;

  constructor(ctx: GameContext) {
    this.rng = ctx.rng;
    this.effects = ctx.effects;
    this.difficulty = ctx.difficulty;
    this.level = difficultyLevel(ctx.difficulty);
  }

  get score(): number {
    return this._score;
  }

  /** Add points (scaled by the modifier). Returns the points actually added. */
  protected addScore(base: number): number {
    const pts = Math.round(base * this.effects.scoreMult);
    this._score = Math.max(0, this._score + pts);
    return pts;
  }

  /** Subtract points (scaled by penalty multiplier). Score never goes below 0. */
  protected penalize(base: number): number {
    const pts = Math.round(base * this.effects.penaltyMult);
    this._score = Math.max(0, this._score - pts);
    return pts;
  }

  protected flash(text: string, tone: Tone = 'info', ms = 900): void {
    this.fb = { text, tone, ttl: ms };
  }

  feedback(): { text: string; tone: Tone } | null {
    return this.fb ? { text: this.fb.text, tone: this.fb.tone } : null;
  }

  /** How far through its difficulty ramp the round is (0..1): it ramps over `rampMs` of play, then stays at the top. */
  protected rampProgress(rampMs: number): number {
    return Math.min(1, this.elapsedMs / rampMs);
  }

  isOver(): boolean {
    return this.endReason !== null;
  }

  protected end(reason: EndReason): void {
    if (this.endReason === null) this.endReason = reason;
  }

  forceEnd(reason: EndReason): void {
    this.end(reason);
  }

  update(dtMs: number): void {
    if (this.isOver()) return;
    // Clamp huge gaps (e.g. laptop sleep) so physics never explode.
    const dt = Math.min(Math.max(0, dtMs), 100);
    this.elapsedMs += dt;
    if (this.fb) {
      this.fb.ttl -= dt;
      if (this.fb.ttl <= 0) this.fb = null;
    }
    this.tick(dt);
  }

  handleInput(key: Key): void {
    if (this.isOver()) return;
    this.onKey(key);
  }

  result(): GameResult {
    return {
      score: this.score,
      endReason: this.endReason ?? 'quit',
      stats: this.stats(),
      metrics: this.metrics(),
      perfect: this.isPerfect(),
    };
  }

  dispose(): void {
    /* Games hold no external resources by design; override if needed. */
  }

  protected abstract tick(dtMs: number): void;
  protected abstract onKey(key: Key): void;
  abstract render(): string[];
  abstract hud(): HudItem[];
  protected abstract stats(): Record<string, number>;
  protected abstract metrics(): Array<[string, string]>;
  protected abstract isPerfect(): boolean;
}
