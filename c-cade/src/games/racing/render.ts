import { c, theme } from '../../ui/style.js';
import { hash } from '../../core/rng.js';
import { Canvas } from '../../ui/canvas.js';
import { LANE_W, VERGE, type Track } from './track.js';
import { HAZARDS, PICKUPS, SCENERY, carSprite } from './sprites.js';

/**
 * Draws a race: road, scenery, hazards and cars, from a plain Scene. The
 * singleplayer games and the LAN client both build a Scene and call this, so
 * there is one renderer for every mode. Rendering never touches the
 * simulation: it only reads positions.
 *
 * Layout: one screen row is one row of road. The focused car (yours) sits
 * near the bottom, so most of the view is road ahead. The camera follows the
 * road horizontally, so curves sweep across the screen instead of leaving it.
 */

export const RACE_MIN_W = 44;
export const RACE_MIN_H = 17;
/** Rows below the focused car's rear row. */
const BELOW = 4;

export interface SceneCar {
  id: string;
  name: string;
  style: number;
  off: number;
  d: number;
  steer: number;
  /** Drifting or spinning: the car is drawn sideways. */
  slide: boolean;
  /** Disconnected or retired: drawn faded, it can't be hit. */
  ghost: boolean;
  finished: boolean;
  you: boolean;
}

export interface Scene {
  track: Track;
  cars: SceneCar[];
  /** The car the camera follows. */
  focusD: number;
  focusOff: number;
  /** Animation clock (ms), for weather and blinking. */
  anim: number;
  phase: 'countdown' | 'racing' | 'done';
  /** Time to the green light while counting down. */
  countdownMs: number;
  /** Time Trial: your best run, as a faded car. */
  ghost?: { off: number; d: number } | null;
  /** Shown in a side panel when there's room beside the road. */
  standings?: string[];
  /** Big centred message (finish, wreck). */
  banner?: string | null;
}

const CAR_TINTS = ['car0', 'car1', 'car2', 'car3', 'car4', 'car5', 'car6', 'car7'];

export function palette(tint: string): (s: string) => string {
  switch (tint) {
    case 'you': return (s) => c.bold(theme.primary(s));
    case 'car0': return (s) => c.bold(c.red(s));
    case 'car1': return (s) => c.bold(c.yellow(s));
    case 'car2': return (s) => c.bold(c.magenta(s));
    case 'car3': return (s) => c.bold(c.blue(s));
    case 'car4': return (s) => c.bold(c.green(s));
    case 'car5': return (s) => c.bold(c.brightYellow(s));
    case 'car6': return (s) => c.bold(c.brightMagenta(s));
    case 'car7': return (s) => c.bold(c.cyan(s));
    case 'traffic': return c.white;
    case 'tyre': return theme.muted;
    case 'trim': return c.white;
    case 'kerbA': return c.red;
    case 'kerbB': return c.white;
    case 'edge': return (s) => c.bold(c.white(s));
    case 'lane': return c.white;
    case 'finish': return (s) => c.bold(c.white(s));
    case 'barrier': return c.yellow;
    case 'grass': return c.green;
    case 'pine': return c.green;
    case 'snow': return (s) => c.bold(c.white(s));
    case 'trunk': return c.yellow;
    case 'rock': return (s) => c.bold(theme.muted(s));
    case 'stone': return c.white;
    case 'cone': return (s) => c.bold(c.brightYellow(s));
    case 'oil': return (s) => c.bold(c.magenta(s));
    case 'pothole': return (s) => c.bold(theme.muted(s));
    case 'barrel': return (s) => c.bold(c.red(s));
    case 'coin': return (s) => c.bold(theme.gold(s));
    case 'wrench': return (s) => c.bold(theme.good(s));
    case 'warn': return (s) => c.bold(theme.gold(s));
    case 'stand': return c.white;
    case 'crowd': return theme.accent;
    case 'sign': return (s) => c.bold(theme.accent(s));
    case 'rain': return c.blue;
    case 'flake': return c.white;
    case 'tag': return theme.muted;
    case 'banner': return (s) => c.bold(theme.gold(s));
    case 'count': return (s) => c.bold(theme.bad(s));
    case 'go': return (s) => c.bold(theme.good(s));
    case 'panel': return c.white;
    case 'panelYou': return (s) => c.bold(theme.primary(s));
    default: return theme.muted; // ground, ghost, texture
  }
}

export class RaceView {
  private camX: number | null = null;

  /** Render `scene` into exactly `height` lines of exactly `width` columns. */
  render(scene: Scene, width: number, height: number): string[] {
    const w = Math.max(RACE_MIN_W, width);
    const h = Math.max(RACE_MIN_H, height);
    const t = scene.track;
    const cv = new Canvas(w, h);
    const carRow = h - 1 - BELOW;
    const dAt = (r: number) => scene.focusD + (carRow - r);
    // Follow the road (and a little of the car's own line), smoothed so turns glide.
    const want = t.center(scene.focusD + 4) + scene.focusOff * 0.4;
    this.camX = this.camX === null ? want : this.camX + (want - this.camX) * 0.35;
    if (Math.abs(want - this.camX) > w / 3) this.camX = want;
    const col = (x: number) => Math.round(x - this.camX! + w / 2);
    const night = t.conditions === 'night';
    const snowy = t.conditions === 'snow';
    const baseHalf = (t.lanes * LANE_W) / 2;

    // Ground, verge, barrier, kerbs, edges, lane markings, start line.
    for (let r = 0; r < h; r++) {
      const d = dAt(r);
      const di = Math.floor(d);
      const cx = t.center(d);
      const half = t.half(d);
      const slope = t.slope(d);
      const l = col(cx - half);
      const rr = col(cx + half);
      const bl = col(cx - half - VERGE);
      const br = col(cx + half + VERGE);
      for (let x = 0; x < w; x++) {
        const hsh = hash(di, x + Math.round(this.camX!));
        if (x < bl || x > br) {
          if (hsh % (night ? 41 : 17) === 0) cv.put(x, r, snowy ? '.' : ',', 'ground');
          else if (hsh % 29 === 1) cv.put(x, r, snowy ? '*' : '.', snowy ? 'flake' : 'ground');
        } else if (x === bl || x === br) {
          cv.put(x, r, '#', 'barrier');
        } else if (x < l - 1 || x > rr + 1) {
          if (hsh % 9 === 0) cv.put(x, r, snowy ? '.' : "'", snowy ? 'flake' : 'grass');
        } else if (x === l - 1 || x === rr + 1) {
          cv.put(x, r, '=', Math.floor(di / 2) % 2 ? 'kerbA' : 'kerbB');
        } else if (x === l || x === rr) {
          cv.put(x, r, slope > 0.18 ? '/' : slope < -0.18 ? '\\' : '|', 'edge');
        }
      }
      // Dashed lane lines scroll with the road: the main sense of speed.
      if (di % 4 < 2) {
        for (let i = 1; i < t.lanes; i++) {
          const lx = col(cx - baseHalf + LANE_W * i);
          if (lx > l && lx < rr) cv.put(lx, r, '|', 'lane');
        }
      }
      if (t.kind === 'circuit' && ((di % t.lapLength) + t.lapLength) % t.lapLength === 0) {
        for (let x = l + 1; x < rr; x++) cv.put(x, r, (x + di) % 2 ? '#' : '=', 'finish');
      }
    }

    const dTop = dAt(0);
    const dBottom = dAt(h - 1);
    const rowOf = (d: number) => carRow - Math.round(d - scene.focusD);

    // Weather, behind everything solid so it never hides a hazard or a car.
    if (t.conditions === 'rain' || t.conditions === 'snow') {
      const n = Math.floor((w * h) / (t.conditions === 'rain' ? 22 : 30));
      for (let i = 0; i < n; i++) {
        const hs = hash(i, 911);
        const speed = t.conditions === 'rain' ? 26 : 5;
        const y = Math.floor((hs % (h * 8)) / 8 + (scene.anim * speed) / 1000) % h;
        const drift = t.conditions === 'rain' ? -(scene.anim * speed) / 2000 : Math.sin(scene.anim / 800 + i) * 1.5;
        const x = Math.floor(((((hs >>> 9) % (w * 8)) / 8 + drift) % w) + w) % w;
        if (cv.get(x, y) !== ' ') continue;
        cv.put(x, y, t.conditions === 'rain' ? "'" : i % 5 ? '.' : '*', t.conditions === 'rain' ? 'rain' : 'flake');
      }
    }

    // Scenery beyond the barriers.
    for (const s of t.sceneryIn(dBottom - 8, dTop + 8)) {
      const spr = SCENERY[s.sprite];
      const cx = t.center(s.d);
      const edge = t.half(s.d) + VERGE + 2 + s.gap;
      const x = col(cx + s.side * (edge + Math.ceil(spr.width / 2)));
      const barrierL = col(cx - t.half(s.d) - VERGE);
      const barrierR = col(cx + t.half(s.d) + VERGE);
      const clip = s.side < 0 ? { x0: 0, y0: 0, x1: barrierL, y1: h } : { x0: barrierR + 1, y0: 0, x1: w, y1: h };
      cv.draw(spr, x, rowOf(s.d), { clip, ...(night ? { tint: 'ground' } : {}) });
    }

    // Hazards and pickups, plus a warning for the ones just over the horizon.
    for (const hz of t.hazardsIn(dBottom - 2, dTop + 14)) {
      const x = col(t.center(hz.d) + hz.off);
      if (hz.d > dTop) {
        cv.put(x, 0, '!', 'warn');
        continue;
      }
      cv.draw(HAZARDS[hz.kind], x, rowOf(hz.d));
    }
    if (t.kind === 'highway') {
      for (const p of t.pickupsIn(dBottom - 2, dTop + 1)) {
        cv.draw(PICKUPS[p.kind], col(t.center(p.d) + p.off), rowOf(p.d), { frame: Math.floor(scene.anim / 250) });
      }
    }

    // Time Trial ghost.
    if (scene.ghost && scene.ghost.d > dBottom - 3 && scene.ghost.d < dTop + 1) {
      cv.draw(carSprite(0), col(t.center(scene.ghost.d) + scene.ghost.off), rowOf(scene.ghost.d), { tint: 'ghost' });
    }

    // Cars, far to near; far ones are drawn smaller.
    const cars = scene.cars.filter((k) => k.d > dBottom - 3 && k.d < dTop + 3).sort((a, b) => b.d - a.d || (a.you ? 1 : -1));
    const placed = cars.map((k) => ({ k, spr: carSprite(k.style), x: col(t.center(k.d) + k.off), y: rowOf(k.d) }));
    // Name tags first, so a car always covers a tag rather than the other way round.
    for (const { k, spr, x, y } of placed) {
      if (k.you || k.style >= 10 || y < h * 0.3) continue;
      const tag = k.name.slice(0, 8);
      const ty = y - spr.height;
      if (ty >= 1) cv.text(x - Math.floor(tag.length / 2), ty, tag, k.ghost ? 'ghost' : 'tag');
    }
    for (const { k, spr, x, y } of placed) {
      const frame = k.slide ? 3 : k.steer < 0 ? 1 : k.steer > 0 ? 2 : 0;
      const far = !k.you && y < h * 0.3;
      const body = k.you ? 'you' : k.style >= 10 ? 'traffic' : CAR_TINTS[k.style % CAR_TINTS.length];
      cv.draw(spr, x, y, { frame, compact: far, ...(k.ghost ? { tint: 'ghost' } : { remap: { body } }) });
    }

    // Standings beside the road, only where it doesn't cover any track.
    if (scene.standings?.length) {
      const pw = Math.max(...scene.standings.map((s) => s.length)) + 1;
      const x0 = w - pw;
      const rows = scene.standings.length;
      let fits = x0 > 0;
      for (let r = 0; r < rows + 1 && fits; r++) if (col(t.center(dAt(r)) + t.half(dAt(r)) + VERGE) >= x0 - 1) fits = false;
      if (fits) {
        scene.standings.forEach((line, r) => {
          const you = line.includes('YOU');
          cv.text(x0, r, ' '.repeat(pw), null);
          cv.text(x0, r, line, you ? 'panelYou' : 'panel');
        });
      }
    }

    // Countdown and banners in the middle of the road.
    const mid = Math.floor(h / 3);
    if (scene.phase === 'countdown') {
      // Near the top: the grid fills the lower part of the screen.
      const n = Math.ceil(scene.countdownMs / 1000);
      const text = n > 0 ? `[  ${n}  ]` : '[ GO! ]';
      cv.text(Math.floor((w - text.length) / 2), 1, text, n > 0 ? 'count' : 'go');
    } else if (scene.banner) {
      const text = ` ${scene.banner} `;
      cv.text(Math.max(0, Math.floor((w - text.length) / 2)), mid, text, 'banner');
    }
    return cv.lines(palette);
  }
}
