import { BaseGame } from '../core/base-game.js';
import { NEUTRAL_EFFECTS } from '../core/modifiers.js';
import { Rng } from '../core/rng.js';
import type { GameContext, GameDefinition, GameInstance, HudItem, Key, Tone } from '../core/types.js';
import { c, theme } from '../ui/style.js';
import type { LuaRuntime, LuaVm } from './lua-runtime.js';

/**
 * Adapter that turns a user's Lua script into a normal GameDefinition, so the
 * shell (briefing, pause, modifiers, seeds, results) treats it like any other
 * minigame. Anything coming out of the script is validated, clamped and
 * stripped of control characters before it reaches the terminal.
 */

export const MAX_SOURCE_BYTES = 128 * 1024;
/** Largest game area that still fits an 80x24 terminal with the HUD. */
export const MAX_SIZE = { width: 78, height: 18 };
export const CUSTOM_PREFIX = 'custom:';

export interface CustomMeta {
  id: string;
  name: string;
  genre: string;
  tagline: string;
  durationSec: number;
  minSize: { width: number; height: number };
  controls: Array<[string, string]>;
}

/* ------------------------------------------------------------ helpers */

// C0 controls (except newline), DEL and C1 controls. Removing ESC here is what
// stops a script from emitting its own terminal escape sequences.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

export function sanitize(s: string): string {
  return s.replace(/\t/g, '  ').replace(CONTROL_RE, '');
}

function oneLine(s: string | undefined, max: number): string {
  return [...sanitize(s ?? '').replace(/\n/g, ' ').trim()].slice(0, max).join('');
}

const TONES: Record<string, (s: string) => string> = {
  good: theme.good,
  bad: theme.bad,
  gold: theme.gold,
  info: theme.primary,
  accent: theme.accent,
  muted: theme.muted,
  bold: c.bold,
};

/**
 * Render one line of game output with simple colour markup:
 * `{good}`, `{bad}`, `{gold}`, `{info}`, `{accent}`, `{muted}`, `{bold}` start
 * a style, `{/}` ends it, `{{` is a literal brace. The result is clipped to
 * `width` visible characters.
 */
export function renderMarkup(line: string, width: number): string {
  const chars = [...sanitize(line)];
  let out = '';
  let seg = '';
  let style: ((s: string) => string) | null = null;
  let visible = 0;
  const flush = () => {
    if (seg) out += style ? style(seg) : seg;
    seg = '';
  };
  for (let i = 0; i < chars.length && visible < width; i++) {
    const ch = chars[i];
    if (ch === '{') {
      if (chars[i + 1] === '{') {
        seg += '{';
        visible++;
        i++;
        continue;
      }
      const close = chars.indexOf('}', i);
      const tag = close > i ? chars.slice(i + 1, close).join('') : '';
      if (tag === '/' || TONES[tag]) {
        flush();
        style = tag === '/' ? null : TONES[tag];
        i = close;
        continue;
      }
    }
    seg += ch;
    visible++;
  }
  flush();
  return out;
}

function parseRows(s: string, cols: number): string[][] {
  if (!s) return [];
  return s.split('\n').map((row) => row.split('\t').slice(0, cols));
}

const TONE_NAMES = new Set<Tone>(['good', 'bad', 'gold', 'info']);
const asTone = (s: string | undefined): Tone | undefined => (TONE_NAMES.has(s as Tone) ? (s as Tone) : undefined);

/** Validate the `game` table the script declared. Throws with a readable message. */
export function parseMeta(raw: string): CustomMeta {
  const fields = new Map<string, string>();
  const controls: Array<[string, string]> = [];
  for (const row of parseRows(raw, 3)) {
    if (row[0] === 'control') {
      const keys = oneLine(row[1], 20);
      if (keys) controls.push([keys, oneLine(row[2], 40)]);
    } else if (row[0]) fields.set(row[0], row[1] ?? '');
  }
  const id = (fields.get('id') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) {
    throw new Error('game.id must be 1-24 characters: lowercase letters, digits and dashes (e.g. "whack-a-merge")');
  }
  const name = oneLine(fields.get('name'), 24) || id;
  const width = Math.round(Number(fields.get('width')));
  const height = Math.round(Number(fields.get('height')));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 10 || height < 3) {
    throw new Error('game.min_size must be { w = <10-78>, h = <3-18> } (the size of what render() draws)');
  }
  const duration = Number(fields.get('duration') ?? 30);
  return {
    id,
    name,
    genre: oneLine(fields.get('genre'), 24) || 'Custom',
    tagline: oneLine(fields.get('tagline'), 60),
    durationSec: Math.min(300, Math.max(15, Number.isFinite(duration) ? Math.round(duration) : 30)),
    minSize: { width: Math.min(MAX_SIZE.width, width), height: Math.min(MAX_SIZE.height, height) },
    controls: controls.slice(0, 6),
  };
}

/** Pull the line number out of a Lua error such as `game:12: attempt to ...`. */
export function errorLine(message: string): number | null {
  const m = /^game:(\d+):/.exec(message);
  return m ? Number(m[1]) : null;
}

/* --------------------------------------------------------------- game */

export class LuaGame extends BaseGame {
  readonly minSize: { width: number; height: number };
  /** First runtime error, if the script crashed during the round. */
  scriptError: string | null = null;
  private readonly vm: LuaVm;

  constructor(ctx: GameContext, meta: CustomMeta, source: string, runtime: LuaRuntime) {
    super(ctx);
    this.minSize = meta.minSize;
    this.vm = runtime.createVm({
      score: (n) => (this.isOver() ? 0 : this.addScore(n)),
      penalize: (n) => (this.isOver() ? 0 : this.penalize(n)),
      flash: (text, tone, ms) => this.flash(oneLine(text, 40), asTone(tone) ?? 'info', Math.min(5000, Math.max(100, ms))),
      finish: (reason) => this.end(reason === 'win' ? 'win' : 'gameover'),
      random: () => this.rng.next(),
      timeLeft: () => this.timeLeftMs(),
      elapsed: () => this.elapsedMs,
      getScore: () => this.score,
    });
    try {
      this.vm.call('load', source);
      const e = this.effects;
      const lives = e.lives === null ? 'nil' : String(e.lives);
      this.vm.call(
        'ctx',
        this.difficulty,
        `speed=${e.speed};special=${e.specialMult};penalty=${e.penaltyMult};score_mult=${e.scoreMult};chaos=${e.chaos};lives=${lives};duration=${this.durationMs}`,
      );
      this.vm.call('init');
    } catch (err) {
      this.vm.close();
      throw err;
    }
  }

  private guarded<T>(fn: () => T, fallback: T): T {
    if (this.scriptError) return fallback;
    try {
      return fn();
    } catch (err) {
      this.scriptError = err instanceof Error ? err.message : String(err);
      this.end('gameover');
      return fallback;
    }
  }

  protected tick(dtMs: number): void {
    this.guarded(() => this.vm.call('update', dtMs), '');
  }

  protected onKey(key: Key): void {
    if (key.name === 'paste' || key.name === 'unknown') return;
    this.guarded(() => this.vm.call('key', key.name, key.ch ?? '', key.ctrl === true), '');
  }

  render(): string[] {
    const { width, height } = this.minSize;
    if (this.scriptError) return this.errorLines(width);
    const raw = this.guarded(() => this.vm.call('render'), '');
    if (this.scriptError) return this.errorLines(width);
    return raw.split('\n').slice(0, height).map((l) => renderMarkup(l, width));
  }

  private errorLines(width: number): string[] {
    return [theme.bad('Script error:'), ...wrap(oneLine(this.scriptError!, 400), width).slice(0, this.minSize.height - 1)];
  }

  hud(): HudItem[] {
    const raw = this.guarded(() => this.vm.call('hud'), '');
    return parseRows(raw, 3).map(([label, value, t]) => {
      const tone = asTone(t);
      return { label: oneLine(label, 12), value: oneLine(value, 16), ...(tone ? { tone } : {}) };
    }).filter((h) => h.label || h.value);
  }

  protected stats(): Record<string, number> {
    return {};
  }

  protected metrics(): Array<[string, string]> {
    const raw = this.guarded(() => this.vm.call('metrics'), '');
    return parseRows(raw, 2)
      .map(([label, value]) => [oneLine(label, 20), oneLine(value, 14)] as [string, string])
      .filter(([l]) => l);
  }

  protected isPerfect(): boolean {
    return this.guarded(() => this.vm.call('perfect') === '1', false);
  }

  dispose(): void {
    this.vm.close();
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

export function scriptErrorOf(game: GameInstance): string | null {
  return game instanceof LuaGame ? game.scriptError : null;
}

/* ------------------------------------------------------------ compile */

export type CompileResult =
  | { ok: true; def: GameDefinition; meta: CustomMeta }
  | { ok: false; error: string; line: number | null };

const CHECK_KEYS: Key[] = [
  { name: 'up' }, { name: 'down' }, { name: 'left' }, { name: 'right' }, { name: 'space', ch: ' ' },
  { name: 'enter' }, ...'qweasdzxc123'.split('').map((ch) => ({ name: 'char' as const, ch })),
];

/**
 * Load a script, validate its metadata and give it a short headless test run
 * (init, a few seconds of updates with random keys, render and HUD) so most
 * mistakes are reported with a line number before the player starts a round.
 */
export function compileCustomGame(source: string, runtime: LuaRuntime, file?: string): CompileResult {
  const fail = (err: unknown): CompileResult => {
    const error = oneLine(err instanceof Error ? err.message : String(err), 300) || 'unknown error';
    return { ok: false, error, line: errorLine(error) };
  };
  if (!source.trim()) return { ok: false, error: 'The script is empty.', line: null };
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return { ok: false, error: `The script is larger than ${MAX_SOURCE_BYTES / 1024} KB.`, line: null };
  }

  let meta: CustomMeta;
  const probe = runtime.createVm({
    score: () => 0, penalize: () => 0, flash: () => {}, finish: () => {},
    random: () => 0.5, timeLeft: () => 30_000, elapsed: () => 0, getScore: () => 0,
  });
  try {
    meta = parseMeta(probe.call('load', source));
  } catch (err) {
    return fail(err);
  } finally {
    probe.close();
  }

  const def: GameDefinition = {
    id: CUSTOM_PREFIX + meta.id,
    name: meta.name,
    genre: meta.genre,
    tagline: meta.tagline,
    controls: meta.controls,
    weight: 0,
    defaultDurationSec: meta.durationSec,
    xpScale: 1,
    custom: { source, ...(file ? { file } : {}) },
    create: (ctx) => new LuaGame(ctx, meta, source, runtime),
  };

  let game: LuaGame | null = null;
  try {
    game = new LuaGame(
      { rng: new Rng('check'), difficulty: 'normal', effects: { ...NEUTRAL_EFFECTS }, durationMs: meta.durationSec * 1000 },
      meta, source, runtime,
    );
    const input = new Rng('check-input');
    for (let frame = 0; frame < 90 && !game.isOver(); frame++) {
      if (frame % 3 === 0) game.handleInput(input.pick(CHECK_KEYS));
      game.update(33);
      if (frame % 15 === 0) {
        game.render();
        game.hud();
      }
    }
    if (game.scriptError) return fail(game.scriptError);
  } catch (err) {
    return fail(err);
  } finally {
    game?.dispose();
  }
  return { ok: true, def, meta };
}
