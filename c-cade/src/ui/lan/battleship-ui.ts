import type { Key } from '../../core/types.js';
import { Rng, makeSeed } from '../../core/rng.js';
import {
  COLS, FLEET, SIZE, formatCoord, parseCoord, placementError, randomFleet, shipCells,
  type BattleshipView, type Dir, type Placement, type PublicBoard,
} from '../../games/multiplayer/battleship.js';
import { c, padRight, theme } from '../style.js';
import { countdownStyled, sideBySide } from './widgets.js';
import type { GameUiCtx, MpGameUi } from './types.js';

/**
 * Battleship client: manual placement with a cursor (or typed coordinates
 * like "B4"), optional random placement, then a target grid to fire on.
 * The local fleet is only submitted when complete; the server re-validates.
 */

type Cell = { ch: string; style: (s: string) => string };

const WATER: Cell = { ch: '.', style: (s) => theme.muted(s) };

export class BattleshipUi implements MpGameUi {
  private view: BattleshipView | null = null;
  private placed: Placement[] = [];
  private submitted = false;
  private dir: Dir = 'h';
  private cur = { x: 0, y: 0 };
  private aim = { x: 4, y: 4 };
  private coord = '';
  private message = '';
  private showOwn = false;
  private readonly rng = new Rng(makeSeed());

  constructor(private readonly ctx: GameUiCtx) {}

  setView(view: unknown): void {
    const v = view as BattleshipView;
    const prev = this.view;
    this.view = v;
    if (prev && prev.phase !== v.phase) this.message = '';
    if (v.mine) {
      // The server has our fleet (also after a reconnect).
      this.placed = v.mine;
      this.submitted = true;
    } else if (prev?.mine && !v.mine) {
      this.submitted = false;
    }
    if (prev && v.last && JSON.stringify(v.last) !== JSON.stringify(prev.last)) {
      const by = v.last.by === v.you ? 'You' : v.players[v.last.by].name;
      const at = formatCoord(v.last.x, v.last.y);
      this.message = v.last.result === 'miss' ? `${by} fired at ${at}: miss.`
        : v.last.result === 'hit' ? `${by} fired at ${at}: HIT!`
          : `${by} fired at ${at}: SUNK the ${v.last.ship}!`;
    }
  }

  onEvent(): void { /* Battleship sends everything in views. */ }

  capturing(): boolean {
    return this.coord.length > 0;
  }

  tick(): void { /* nothing animated locally */ }

  private nextShip(): (typeof FLEET)[number] | undefined {
    return FLEET.find((s) => !this.placed.some((p) => p.id === s.id));
  }

  private preview(): Placement | null {
    const s = this.nextShip();
    return s ? { id: s.id, x: this.cur.x, y: this.cur.y, dir: this.dir } : null;
  }

  onKey(key: Key): boolean {
    const v = this.view;
    if (!v || v.you === null || v.phase === 'over') return false;
    // Coordinate typing: a letter A-J starts it, digits continue it.
    const ch = key.name === 'char' && !key.ctrl ? key.ch ?? '' : '';
    if (/^[a-jA-J]$/.test(ch) && this.coord.length === 0) { this.coord = ch.toUpperCase(); return true; }
    if (this.coord && /^[0-9]$/.test(ch) && this.coord.length < 3) { this.coord += ch; return true; }
    if (this.coord && key.name === 'backspace') { this.coord = this.coord.slice(0, -1); return true; }
    if (this.coord && key.name === 'escape') { this.coord = ''; return true; }
    if (key.name === 'tab') { this.showOwn = !this.showOwn; return true; }
    if (v.phase === 'placing') return this.placingKey(key, ch.toLowerCase());
    if (v.phase === 'battle') return this.battleKey(key);
    return false;
  }

  private takeCoord(): { x: number; y: number } | null | undefined {
    if (!this.coord) return undefined;
    const p = parseCoord(this.coord);
    if (!p) this.message = `"${this.coord}" is not a square (A1-J10).`;
    this.coord = '';
    return p;
  }

  private move(target: { x: number; y: number }, key: Key): boolean {
    const d: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const m = d[key.name];
    if (!m) return false;
    target.x = Math.max(0, Math.min(SIZE - 1, target.x + m[0]));
    target.y = Math.max(0, Math.min(SIZE - 1, target.y + m[1]));
    return true;
  }

  private placingKey(key: Key, ch: string): boolean {
    if (this.submitted) {
      if (ch === 'u' || key.name === 'backspace') {
        this.ctx.send({ kind: 'unplace' });
        this.submitted = false;
        this.message = 'Fleet recalled. Adjust and confirm again.';
        return true;
      }
      return false;
    }
    if (this.move(this.cur, key)) return true;
    if (ch === 'r' || key.name === 'space') { this.dir = this.dir === 'h' ? 'v' : 'h'; return true; }
    if (ch === 'u' || key.name === 'backspace') { this.placed = this.placed.slice(0, -1); return true; }
    if (ch === 'x') {
      this.placed = randomFleet(this.rng, this.placed);
      this.message = 'Remaining ships placed at random. Enter to confirm.';
      return true;
    }
    if (key.name === 'enter') {
      const typed = this.takeCoord();
      if (typed === null) return true;
      if (typed) this.cur = typed;
      const p = this.preview();
      if (!p) {
        this.ctx.send({ kind: 'place', fleet: this.placed });
        this.submitted = true;
        this.message = 'Fleet submitted.';
        return true;
      }
      const err = placementError(this.placed, p);
      if (err) { this.message = err + '.'; return true; }
      this.placed = [...this.placed, p];
      this.message = this.nextShip() ? '' : 'All ships placed. Enter to confirm, U to undo.';
      return true;
    }
    return false;
  }

  private battleKey(key: Key): boolean {
    const v = this.view!;
    if (this.move(this.aim, key)) return true;
    if (key.name === 'enter' || key.name === 'space') {
      const typed = this.takeCoord();
      if (typed === null) return true;
      if (typed) this.aim = typed;
      if (v.paused) { this.message = 'Paused: waiting for a player to reconnect.'; return true; }
      if (v.turn !== v.you) { this.message = "Not your turn yet."; return true; }
      const opp = v.boards[1 - v.you!];
      if (opp.shots.some(([x, y]) => x === this.aim.x && y === this.aim.y)) {
        this.message = `You already fired at ${formatCoord(this.aim.x, this.aim.y)}.`;
        return true;
      }
      this.ctx.send({ kind: 'fire', x: this.aim.x, y: this.aim.y });
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ render */

  private grid(cell: (x: number, y: number) => Cell, cursor: { x: number; y: number } | null, title: string): string[] {
    const lines = [title, '   ' + theme.muted(COLS.split('').join(' '))];
    const blink = Math.floor(this.ctx.anim() / 400) % 2 === 0;
    for (let y = 0; y < SIZE; y++) {
      let row = theme.muted(String(y + 1).padStart(2) + ' ');
      for (let x = 0; x < SIZE; x++) {
        const k = cell(x, y);
        const here = cursor && cursor.x === x && cursor.y === y;
        row += here ? (blink ? c.inverse(k.style(k.ch)) : k.style(k.ch)) : k.style(k.ch);
        row += x < SIZE - 1 ? ' ' : '';
      }
      lines.push(row);
    }
    return lines;
  }

  /** Cell for a public board, optionally with ships drawn (own fleet / post-game reveal). */
  private boardCell(board: PublicBoard, ships: Placement[] | null, preview: Placement | null) {
    const shots = new Map(board.shots.map(([x, y, m]) => [`${x},${y}`, m]));
    const sunk = new Set(board.sunk.flatMap(shipCells).map(([x, y]) => `${x},${y}`));
    const shipAt = new Map<string, Placement>();
    for (const p of ships ?? []) for (const [x, y] of shipCells(p)) shipAt.set(`${x},${y}`, p);
    const pv = preview ? new Set(shipCells(preview).map(([x, y]) => `${x},${y}`)) : null;
    const pvOk = preview ? !placementError(ships ?? [], preview) : true;
    return (x: number, y: number): Cell => {
      const k = `${x},${y}`;
      if (pv?.has(k)) return { ch: FLEET.find((f) => f.id === preview!.id)!.glyph, style: pvOk ? theme.good : theme.bad };
      if (sunk.has(k)) return { ch: '#', style: (s) => c.bold(theme.bad(s)) };
      const m = shots.get(k);
      if (m === 'h') return { ch: 'X', style: (s) => c.bold(theme.gold(s)) };
      const ship = shipAt.get(k);
      if (m === 'm') return { ch: 'o', style: theme.primary };
      if (ship) return { ch: FLEET.find((f) => f.id === ship.id)!.glyph, style: theme.text };
      return WATER;
    };
  }

  private fleetStatus(board: PublicBoard, label: string): string {
    const sunk = new Set(board.sunk.map((p) => p.id));
    return theme.muted(padRight(label, 9)) + FLEET.map((s) => (sunk.has(s.id) ? theme.bad(c.dim(s.glyph.repeat(s.len))) : theme.good(s.glyph.repeat(s.len)))).join(' ');
  }

  render(width: number, height: number): string[] {
    const v = this.view;
    if (!v) return [theme.muted('Waiting for the server...')];
    const now = this.ctx.serverNow();
    const out: string[] = [];
    const you = v.you;
    const opp = you === null ? null : ((1 - you) as 0 | 1);
    const narrow = width < 56;

    // Status line.
    let status: string;
    if (v.phase === 'placing') {
      const ready = v.boards.map((b, i) => `${v.players[i].name} ${b.ready ? theme.good('ready') : theme.muted('placing')}`).join(theme.muted('  ·  '));
      status = theme.title('DEPLOY YOUR FLEET') + '   ' + ready + (v.placeDeadline ? '   ' + countdownStyled(v.placeDeadline, now) : '');
    } else if (v.phase === 'battle') {
      const turnName = v.turn === you ? theme.good(c.bold('YOUR TURN')) : theme.muted(`${v.players[v.turn].name}'s turn`);
      status = theme.title('BATTLE') + '   ' + turnName + (v.turnDeadline ? '   ' + countdownStyled(v.turnDeadline, now) : '') +
        (opp !== null ? theme.muted(`   vs ${v.players[opp].name}`) : theme.muted(`   ${v.players[0].name} vs ${v.players[1].name}`));
    } else {
      const w = v.winner;
      status = w === null ? theme.title('NO WINNER') : w === you ? theme.good(c.bold('VICTORY!')) : you === null ? theme.title(`${v.players[w].name} WINS`) : theme.bad(c.bold('DEFEAT'));
      status += theme.muted(`   ${v.turns} shots fired`);
    }
    out.push(status);
    if (v.paused) out.push(theme.gold(`Paused: waiting for ${v.paused} to reconnect...`));
    else if (this.message) out.push(theme.primary(this.message));
    else if (v.log.length) out.push(theme.muted(v.log[v.log.length - 1]));
    else out.push('');

    // Boards.
    let left: string[];
    let right: string[];
    if (you === null) {
      left = this.grid(this.boardCell(v.boards[0], v.revealed?.[0] ?? null, null), null, theme.primary(v.players[0].name));
      right = this.grid(this.boardCell(v.boards[1], v.revealed?.[1] ?? null, null), null, theme.primary(v.players[1].name));
    } else {
      const placing = v.phase === 'placing' && !this.submitted;
      const ownShips = placing ? this.placed : v.mine ?? this.placed;
      left = this.grid(this.boardCell(v.boards[you], ownShips, placing ? this.preview() : null), placing ? this.cur : null, theme.primary('YOUR FLEET'));
      const oppShips = v.revealed?.[opp!] ?? null;
      right = this.grid(
        this.boardCell(v.boards[opp!], oppShips, null),
        v.phase === 'battle' && v.turn === you ? this.aim : null,
        theme.primary('TARGET GRID') + theme.muted(` (${v.players[opp!].name})`),
      );
    }
    if (narrow) {
      const showLeft = you === null ? !this.showOwn : v.phase === 'placing' || this.showOwn;
      out.push(...(showLeft ? left : right), theme.muted('Tab: switch board'));
    } else {
      out.push(...sideBySide(left, right, 6));
    }

    // Fleet status and helper line.
    if (height >= out.length + 3) {
      if (you !== null && opp !== null) {
        out.push(this.fleetStatus(v.boards[you], 'Yours') + '   ' + this.fleetStatus(v.boards[opp], 'Enemy'));
      } else {
        out.push(this.fleetStatus(v.boards[0], v.players[0].name.slice(0, 8)) + '   ' + this.fleetStatus(v.boards[1], v.players[1].name.slice(0, 8)));
      }
    }
    if (height >= out.length + 3 && v.phase !== 'placing') {
      for (const l of v.log.slice(-2, v.log.length - (this.message ? 0 : 1))) out.push(theme.muted(l));
    }
    if (v.phase === 'over' && you !== null && height >= out.length + 2) {
      const s = v.stats[you];
      const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
      out.push(theme.muted('Your stats: ') + `${s.shots} shots, ${s.hits} hits (${acc}%), ${s.sunk} ships sunk`);
    }
    if (you !== null && v.phase !== 'over') {
      if (this.coord) out.push(theme.primary(`Target: ${this.coord}_`) + theme.muted('  Enter to confirm'));
      else if (v.phase === 'placing' && !this.submitted) {
        const s = this.nextShip();
        out.push(s ? theme.muted('Placing: ') + c.bold(`${s.name} (${s.len})`) + theme.muted(` ${this.dir === 'h' ? 'horizontal' : 'vertical'}`) : theme.good('Fleet ready: press Enter to confirm.'));
      } else if (v.phase === 'placing') {
        out.push(theme.muted('Waiting for your opponent to deploy...'));
      }
    }
    return out;
  }

  hints(): Array<[string, string]> {
    const v = this.view;
    if (!v || v.you === null) return [];
    if (v.phase === 'placing') {
      return this.submitted ? [['U', 'recall fleet']] : [['Arrows', 'move'], ['R', 'rotate'], ['Enter', 'place'], ['U', 'undo'], ['X', 'auto-place'], ['B4', 'jump to square']];
    }
    if (v.phase === 'battle') return [['Arrows', 'aim'], ['Enter', 'fire'], ['B4 Enter', 'fire at a square'], ['Tab', 'boards']];
    return [];
  }
}

