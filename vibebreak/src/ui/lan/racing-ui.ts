import type { Key } from '../../core/types.js';
import { Track } from '../../games/racing/track.js';
import { KMH } from '../../games/racing/sim.js';
import { RaceView, type SceneCar } from '../../games/racing/render.js';
import { fmtMs, pressFor } from '../../games/racing/game.js';
import { FLAG, MAX_BATCH, PRESS_CODE, type RaceNetEvent, type RaceNetView } from '../../games/racing/mp.js';
import { c, theme } from '../style.js';
import { hudLine } from '../layout.js';
import type { GameUiCtx, MpGameUi } from './types.js';

/**
 * LAN racing client. It never simulates the race: it rebuilds the track from
 * the server's seed, renders the server's car snapshots (interpolated, so
 * 30 updates a second look smooth at any frame rate), and turns keys into
 * small input batches. Your own car leans the moment you steer, so the
 * controls feel immediate while the server stays in charge of where it is.
 */

const SEND_EVERY_MS = 40;
/** Render this far behind the newest snapshot, so there's always a pair to blend. */
const INTERP_MS = 45;

interface Snap {
  at: number;
  t: number;
  cars: Map<string, RaceNetView['cars'][number]>;
}

export class RacingUi implements MpGameUi {
  private view: RaceNetView | null = null;
  private track: Track | null = null;
  private trackKey = '';
  private prev: Snap | null = null;
  private cur: Snap | null = null;
  private readonly rv = new RaceView();
  private queue = '';
  private sinceSend = 0;
  private localSteer = 0;
  private localSteerMs = 0;
  private message = '';
  private messageMs = 0;

  constructor(private readonly ctx: GameUiCtx) {}

  setView(view: unknown): void {
    const v = view as RaceNetView;
    if (!v || v.v !== 1 || !Array.isArray(v.cars)) return;
    const key = `${v.seed}:${v.preset}:${v.conditions}`;
    if (key !== this.trackKey) {
      // Same seed, preset and weather as the server: the same track, row for row.
      this.track = new Track({ seed: v.seed, kind: 'circuit', preset: v.preset, conditions: v.conditions });
      this.trackKey = key;
      this.prev = this.cur = null;
    }
    const snap: Snap = { at: this.ctx.serverNow(), t: v.t, cars: new Map(v.cars.map((c) => [c[0], c])) };
    // Only advance on a newer race clock (duplicate views carry no motion).
    if (!this.cur || snap.t > this.cur.t) {
      this.prev = this.cur;
      this.cur = snap;
    }
    this.view = v;
  }

  onEvent(data: unknown): void {
    const e = data as RaceNetEvent;
    const v = this.view;
    if (!e || typeof e !== 'object' || !v) return;
    const name = (id: string) => (id === v.you ? 'You' : v.roster.find((r) => r.id === id)?.name ?? '?');
    if (e.k === 'go') this.say('GO! GO! GO!');
    else if (e.k === 'lap' && e.id === v.you) this.say(`Lap ${e.lap}/${v.laps}  ${fmtMs(e.ms)}`);
    else if (e.k === 'finish') this.say(e.id === v.you ? `FINISHED P${e.place}  ${fmtMs(e.ms)}` : `${name(e.id)} finished P${e.place}`, 2500);
    else if (e.k === 'crash') this.say('Contact! Lost speed.', 800);
    else if (e.k === 'hazard') this.say(e.what === 'oil' ? 'Oil slick! Spinning' : e.what === 'barrel' ? 'Hit a barrel!' : `Hit a ${e.what}`, 900);
  }

  private say(text: string, ms = 1500): void {
    this.message = text;
    this.messageMs = ms;
  }

  onKey(key: Key): boolean {
    const p = pressFor(key);
    if (!p) return false;
    if (!this.view?.you || this.view.phase === 'done') return true;
    if (this.queue.length < MAX_BATCH) this.queue += PRESS_CODE[p];
    if (p === 'left' || p === 'right') {
      this.localSteer = p === 'left' ? -1 : 1;
      this.localSteerMs = 220;
    }
    // Send right away when we've been quiet; otherwise batch.
    if (this.sinceSend >= SEND_EVERY_MS) this.flush();
    return true;
  }

  private flush(): void {
    if (!this.queue) return;
    this.ctx.send({ kind: 'in', p: this.queue });
    this.queue = '';
    this.sinceSend = 0;
  }

  tick(dtMs: number): void {
    this.sinceSend += dtMs;
    if (this.sinceSend >= SEND_EVERY_MS) this.flush();
    this.localSteerMs = Math.max(0, this.localSteerMs - dtMs);
    this.messageMs = Math.max(0, this.messageMs - dtMs);
  }

  capturing(): boolean {
    return false;
  }

  hints(): Array<[string, string]> {
    return [['A/D', 'steer'], ['W', 'gas'], ['S', 'brake'], ['Space', 'drift']];
  }

  /** Car positions at the server time we render (slightly in the past, blended). */
  private cars(): SceneCar[] {
    const v = this.view!;
    const cur = this.cur!;
    const prev = this.prev;
    const renderAt = this.ctx.serverNow() - INTERP_MS;
    const span = prev ? cur.at - prev.at : 0;
    const f = prev && span > 0 ? Math.max(0, Math.min(1.5, (renderAt - prev.at) / span)) : 1;
    return v.roster.flatMap((r) => {
      const now = cur.cars.get(r.id);
      if (!now) return [];
      const was = prev?.cars.get(r.id) ?? now;
      const lerp = (a: number, b: number) => (a + (b - a) * f) / 100;
      const you = r.id === v.you;
      const flags = now[5];
      return [{
        id: r.id, name: r.name, style: r.style,
        off: lerp(was[1], now[1]), d: lerp(was[2], now[2]),
        steer: you && this.localSteerMs > 0 ? this.localSteer : now[4],
        slide: (flags & FLAG.slide) !== 0, ghost: (flags & FLAG.ghost) !== 0, finished: (flags & FLAG.finished) !== 0, you,
      }];
    });
  }

  render(width: number, height: number): string[] {
    const v = this.view;
    if (!v || !this.track || !this.cur) return [theme.muted('Waiting for the race...')];
    const cars = this.cars();
    const me = cars.find((k) => k.you);
    const meSnap = v.you ? this.cur.cars.get(v.you) : undefined;
    // Spectators follow the leader.
    const focus = me ?? cars.find((k) => k.id === v.order[0]) ?? cars[0];
    const place = v.you ? v.order.indexOf(v.you) + 1 : 0;
    const raceT = v.t + (v.phase === 'done' ? 0 : this.ctx.serverNow() - v.at);
    const items = [
      { label: 'LAP', value: `${Math.min(v.laps, (meSnap?.[6] ?? 0) + 1)}/${v.laps}` },
      ...(v.you ? [{ label: 'POS', value: `${place}/${v.order.length}`, tone: place === 1 ? 'gold' as const : 'info' as const }] : [{ label: 'WATCHING', value: focus?.name ?? '-' }]),
      { label: 'SPEED', value: `${String(Math.round(((meSnap?.[3] ?? 0) / 10) * KMH)).padStart(3)}km/h`, tone: meSnap && meSnap[5] & FLAG.offroad ? 'bad' as const : 'info' as const },
      { label: 'RACE', value: fmtMs(meSnap && meSnap[7] >= 0 ? meSnap[7] : Math.max(0, raceT)) },
    ];
    const status = this.messageMs > 0 ? c.bold(theme.gold(this.message))
      : v.windowEndsAt !== null && v.phase !== 'done' ? theme.bad(`Finish window closes in ${Math.max(0, Math.ceil((v.windowEndsAt - this.ctx.serverNow()) / 1000))}s`)
        : meSnap && meSnap[5] & FLAG.ghost ? theme.bad('Reconnected? Your car is on autopilot until the server sees you.') : '';
    const standings = v.order.map((id, i) => {
      const r = v.roster.find((x) => x.id === id);
      const snap = this.cur!.cars.get(id);
      const tag = snap && snap[5] & FLAG.retired ? ' DNF' : snap && snap[5] & FLAG.ghost ? ' (away)' : snap && snap[7] >= 0 ? ` ${fmtMs(snap[7])}` : '';
      return `${i + 1}. ${id === v.you ? 'YOU' : (r?.name ?? '?').slice(0, 10)}${tag}`;
    });
    const road = this.rv.render({
      track: this.track,
      cars,
      focusD: focus?.d ?? 0,
      focusOff: focus?.off ?? 0,
      anim: this.ctx.anim(),
      phase: v.phase,
      countdownMs: -raceT,
      standings,
      banner: v.phase === 'done' ? (v.aborted ? 'RACE ENDED' : 'RACE OVER') : null,
    }, Math.min(width, 78), Math.max(6, height - 2));
    return [hudLine(items), status, ...road];
  }
}
