import type { Key } from '../../core/types.js';
import { isObj } from '../../mp/types.js';
import type { DoodleEvent, DoodleView } from '../../games/multiplayer/doodle.js';
import { scrub } from '../../net/sanitize.js';
import { c, padRight, theme } from '../style.js';
import { TextField, countdownStyled, lower, scoreboard, sideBySide } from './widgets.js';
import type { GameUiCtx, MpGameUi } from './types.js';

/**
 * Doodle Protocol client.
 *
 * Artist: arrows move the cursor; Space stamps the brush; P toggles "pen
 * down" so moving draws a line; E toggles the eraser; 1-9/0/-/= pick a
 * brush; C clears (press twice). Strokes are batched and flushed every
 * 50 ms, so holding an arrow key sends a handful of small messages.
 *
 * Guessers: type and press Enter.
 *
 * The client keeps its own copy of the canvas, applies stroke deltas in
 * revision order and asks the server for a snapshot if it ever misses one.
 */
export class DoodleUi implements MpGameUi {
  private view: DoodleView | null = null;
  private canvas: string[][] = [];
  private rev = -1;
  private cur = { x: 15, y: 6 };
  private brush = 0;
  private pen = false;
  private eraser = false;
  private confirmClear = false;
  private ops: Array<[number, number, string]> = [];
  private sinceFlush = 0;
  private sinceSync = 10_000;
  private readonly field = new TextField('', 40);

  constructor(private readonly ctx: GameUiCtx) {}

  private size(w: number, h: number): void {
    if (this.canvas.length === h && this.canvas[0]?.length === w) return;
    this.canvas = Array.from({ length: h }, () => Array(w).fill(' '));
    this.cur = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
  }

  setView(view: unknown): void {
    const v = view as DoodleView;
    if (this.view && this.view.turn !== v.turn) {
      this.pen = false;
      this.eraser = false;
      this.field.clear();
    }
    this.view = v;
    this.size(v.width, v.height);
  }

  onEvent(data: unknown): void {
    if (!isObj(data)) return;
    const ev = data as DoodleEvent;
    if (ev.kind === 'canvas' && Array.isArray(ev.rows)) {
      const v = this.view;
      if (v) this.size(v.width, v.height);
      this.canvas = this.canvas.map((row, y) => row.map((_, x) => cellChar(ev.rows[y]?.[x])));
      this.rev = ev.rev;
    } else if (ev.kind === 'ops' && Array.isArray(ev.ops)) {
      if (ev.rev !== this.rev + 1) {
        this.requestSync();
        return;
      }
      for (const op of ev.ops) {
        const [x, y, ch] = op;
        if (this.canvas[y]?.[x] !== undefined) this.canvas[y][x] = cellChar(ch);
      }
      this.rev = ev.rev;
    }
  }

  private requestSync(): void {
    if (this.sinceSync < 1000) return;
    this.sinceSync = 0;
    this.ctx.send({ kind: 'sync' });
  }

  private role(): DoodleView['role'] | null {
    return this.view?.role ?? null;
  }

  capturing(): boolean {
    const v = this.view;
    return !!v && v.phase === 'drawing' && v.role === 'guesser' && !v.youGuessed;
  }

  tick(dt: number): void {
    this.sinceFlush += dt;
    this.sinceSync += dt;
    if (this.ops.length && this.sinceFlush >= 50) this.flush();
    // Behind the server (missed deltas, reconnect)? Ask for a snapshot.
    if (this.view && this.view.rev !== this.rev && this.sinceSync >= 1500) this.requestSync();
  }

  private flush(): void {
    this.sinceFlush = 0;
    while (this.ops.length) this.ctx.send({ kind: 'draw', ops: this.ops.splice(0, 100) });
  }

  private stamp(): void {
    const v = this.view!;
    const ch = this.eraser ? ' ' : v.brushes[this.brush];
    const { x, y } = this.cur;
    if (this.canvas[y][x] === ch) return;
    // Optimistic local echo; the server's delta confirms it.
    this.canvas[y][x] = ch;
    this.ops.push([x, y, ch]);
  }

  onKey(key: Key): boolean {
    const v = this.view;
    if (!v) return false;
    if (this.capturing()) {
      if (key.name === 'enter') {
        if (this.field.value.trim()) this.ctx.send({ kind: 'guess', text: this.field.value });
        this.field.clear();
        return true;
      }
      return this.field.onKey(key);
    }
    const ch = lower(key);
    if (this.ctx.isHost() && ch === 'n' && v.role !== 'artist') {
      this.ctx.send({ kind: 'skip' });
      return true;
    }
    if (v.role !== 'artist' || v.phase !== 'drawing') return false;
    const d: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const m = d[key.name];
    if (m) {
      this.cur.x = Math.max(0, Math.min(v.width - 1, this.cur.x + m[0]));
      this.cur.y = Math.max(0, Math.min(v.height - 1, this.cur.y + m[1]));
      if (this.pen) this.stamp();
      this.confirmClear = false;
      return true;
    }
    if (key.name === 'space' || key.name === 'enter') { this.stamp(); return true; }
    if (ch === 'p') { this.pen = !this.pen; if (this.pen) this.stamp(); return true; }
    if (ch === 'e') { this.eraser = !this.eraser; return true; }
    if (ch === 'c') {
      if (this.confirmClear) {
        this.ops = [];
        this.ctx.send({ kind: 'clear' });
        this.confirmClear = false;
      } else this.confirmClear = true;
      return true;
    }
    if (ch === 's') { this.flush(); this.ctx.send({ kind: 'skip' }); return true; }
    const brushKeys = '1234567890-=';
    if (ch && brushKeys.includes(ch)) {
      const i = brushKeys.indexOf(ch);
      if (i < v.brushes.length) { this.brush = i; this.eraser = false; }
      return true;
    }
    return false;
  }

  render(width: number, height: number): string[] {
    const v = this.view;
    if (!v) return [theme.muted('Waiting for the server...')];
    const now = this.ctx.serverNow();
    const you = this.ctx.you();
    const out: string[] = [];
    const artist = v.role === 'artist';
    const time = countdownStyled(v.deadline, now);
    out.push(theme.title('DOODLE PROTOCOL') + theme.muted(`   turn ${v.turn}/${v.turns}   artist: `) + theme.primary(v.artistName) + (time ? '   ' + time : ''));
    if (v.phase === 'drawing') {
      out.push(artist
        ? theme.muted('Draw: ') + theme.gold(c.bold(v.word ?? '')) + theme.muted('  (no letters or words!)')
        : theme.muted('Word: ') + c.bold(v.mask) + theme.muted(`  (${v.mask.replace(/ /g, '').length} letters)`));
    } else {
      out.push(theme.muted('The word was: ') + theme.gold(c.bold(v.word ?? '')));
    }

    // Canvas with a border; the artist sees a cursor.
    const blink = Math.floor(this.ctx.anim() / 350) % 2 === 0;
    const canvas: string[] = [theme.muted('+' + '-'.repeat(v.width) + '+')];
    for (let y = 0; y < v.height; y++) {
      let row = '';
      for (let x = 0; x < v.width; x++) {
        const ch = this.canvas[y]?.[x] ?? ' ';
        const here = artist && v.phase === 'drawing' && this.cur.x === x && this.cur.y === y;
        row += here ? (blink ? c.inverse(ch === ' ' ? (this.eraser ? 'x' : v.brushes[this.brush]) : ch) : ch === ' ' ? theme.muted('·') : ch) : theme.text(ch);
      }
      canvas.push(theme.muted('|') + row + theme.muted('|'));
    }
    canvas.push(theme.muted('+' + '-'.repeat(v.width) + '+'));

    // Side panel: guesses feed and scores.
    const panel: string[] = [];
    const pw = Math.max(16, Math.min(34, width - v.width - 6));
    panel.push(theme.muted('GUESSES'));
    for (const f of v.feed.slice(-Math.max(3, v.height - 9))) {
      const line = f.kind === 'system' ? theme.muted(f.text) : f.kind === 'correct' ? theme.good(`${f.name} ${f.text}`) : `${theme.primary(f.name)}: ${f.text}`;
      panel.push(line);
    }
    panel.push('');
    panel.push(theme.muted('SCORES'));
    panel.push(...scoreboard(v.scores.map((s) => ({ ...s, name: v.guessed.includes(s.id) ? `${s.name} ✓` : s.name })), you, pw, 6));

    if (width >= v.width + 2 + 4 + 18) out.push(...sideBySide(canvas, panel.map((l) => padRight(l, 0)), 3));
    else out.push(...canvas);

    if (v.phase !== 'drawing' && v.lastTurn && v.lastTurn.guessers.length) {
      out.push(theme.good('Got it: ') + v.lastTurn.guessers.map((g) => `${g.name} +${g.points}`).join(', '));
    }
    if (v.note) out.push(theme.gold(v.note));
    if (v.phase === 'drawing') {
      if (artist) {
        const brushes = v.brushes.map((b, i) => (i === this.brush && !this.eraser ? c.inverse(` ${b} `) : ` ${b} `)).join('');
        out.push(theme.muted('Brush ') + brushes + (this.eraser ? ' ' + c.inverse(theme.bad(' ERASER ')) : '') + (this.pen ? ' ' + theme.good(c.bold('PEN DOWN')) : ''));
        if (this.confirmClear) out.push(theme.bad('Press C again to clear the canvas.'));
      } else if (v.role === 'guesser') {
        out.push(v.youGuessed ? theme.good('You got it! Waiting for the others...') : this.field.render(Math.min(width, 50), true, blink));
      } else {
        out.push(theme.muted('Spectating.'));
      }
    }
    return out.slice(0, height);
  }

  hints(): Array<[string, string]> {
    const v = this.view;
    if (!v || v.phase !== 'drawing') return this.ctx.isHost() ? [['N', 'next turn']] : [];
    if (v.role === 'artist') return [['Arrows', 'move'], ['Space', 'stamp'], ['P', 'pen'], ['E', 'eraser'], ['1-0,-,=', 'brush'], ['C C', 'clear'], ['S', 'give up']];
    const h: Array<[string, string]> = [];
    if (this.capturing()) h.push(['Enter', 'guess']);
    if (this.ctx.isHost() && !this.capturing()) h.push(['N', 'skip turn']);
    return h;
  }
}

/** Only accept single, safe, printable cells from the network. */
function cellChar(ch: unknown): string {
  const s = scrub(ch);
  return s.length === 1 ? s : ' ';
}
