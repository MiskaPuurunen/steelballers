import type { Rng } from '../../core/rng.js';
import {
  isInt, isObj, ok, rankStandings, reject,
  type ActionResult, type MatchContext, type MatchOutcome, type MpEvent, type MpGameDefinition, type MpMatch, type MpPlayer, type Presence,
} from '../../mp/types.js';

/**
 * ASCII Battleship: two players, private 10x10 boards, standard fleet.
 *
 * Privacy model: the only private data in a view is `mine` (your own ship
 * positions). Everything about a board that the opponent may know (shots
 * fired at it and ships already sunk) is in `boards[]`, which is public.
 * An opponent's unhit ship positions never leave the server.
 */

export const SIZE = 10;
export const COLS = 'ABCDEFGHIJ';

export const FLEET = [
  { id: 'carrier', name: 'Carrier', len: 5, glyph: 'C' },
  { id: 'battleship', name: 'Battleship', len: 4, glyph: 'B' },
  { id: 'cruiser', name: 'Cruiser', len: 3, glyph: 'R' },
  { id: 'submarine', name: 'Submarine', len: 3, glyph: 'S' },
  { id: 'destroyer', name: 'Destroyer', len: 2, glyph: 'D' },
] as const;

export type ShipId = (typeof FLEET)[number]['id'];
export type Dir = 'h' | 'v';

export interface Placement {
  id: ShipId;
  x: number;
  y: number;
  dir: Dir;
}

export type ShotMark = 'h' | 'm';
/** [x, y, mark] */
export type Shot = [number, number, ShotMark];

export const shipLen = (id: ShipId): number => FLEET.find((s) => s.id === id)!.len;
export const shipName = (id: ShipId): string => FLEET.find((s) => s.id === id)!.name;

export function shipCells(p: Placement): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < shipLen(p.id); i++) cells.push(p.dir === 'h' ? [p.x + i, p.y] : [p.x, p.y + i]);
  return cells;
}

/** "B4" -> {x:1, y:3}; also "b10", "J 1". Null when invalid. */
export function parseCoord(input: string): { x: number; y: number } | null {
  const m = /^\s*([A-Ja-j])\s*(10|[1-9])\s*$/.exec(input);
  if (!m) return null;
  return { x: COLS.indexOf(m[1].toUpperCase()), y: Number(m[2]) - 1 };
}

export const formatCoord = (x: number, y: number): string => `${COLS[x]}${y + 1}`;

/** Why `p` cannot go on a board that already holds `existing`, or null if it fits. */
export function placementError(existing: Placement[], p: Placement): string | null {
  const cells = shipCells(p);
  if (cells.some(([x, y]) => x < 0 || y < 0 || x >= SIZE || y >= SIZE)) return `${shipName(p.id)} would extend beyond the board`;
  const taken = new Set(existing.filter((e) => e.id !== p.id).flatMap(shipCells).map(([x, y]) => `${x},${y}`));
  if (cells.some(([x, y]) => taken.has(`${x},${y}`))) return `${shipName(p.id)} would overlap another ship`;
  return null;
}

/** Validate an untrusted fleet: exactly one of each ship, in bounds, no overlaps. */
export function validateFleet(raw: unknown): { ok: true; fleet: Placement[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length !== FLEET.length) return { ok: false, error: `Place all ${FLEET.length} ships` };
  const fleet: Placement[] = [];
  for (const r of raw) {
    if (!isObj(r)) return { ok: false, error: 'Invalid ship' };
    const def = FLEET.find((s) => s.id === r.id);
    if (!def) return { ok: false, error: 'Unknown ship' };
    if (fleet.some((f) => f.id === def.id)) return { ok: false, error: `Duplicate ${def.name}` };
    if (!isInt(r.x, 0, SIZE - 1) || !isInt(r.y, 0, SIZE - 1)) return { ok: false, error: `Invalid coordinates for the ${def.name}` };
    if (r.dir !== 'h' && r.dir !== 'v') return { ok: false, error: `Invalid direction for the ${def.name}` };
    const p: Placement = { id: def.id, x: r.x, y: r.y, dir: r.dir };
    const err = placementError(fleet, p);
    if (err) return { ok: false, error: err };
    fleet.push(p);
  }
  return { ok: true, fleet };
}

/** Random legal placement for the given ships (others already placed are kept). */
export function randomFleet(rng: Rng, keep: Placement[] = []): Placement[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const fleet = [...keep];
    let failed = false;
    for (const s of FLEET) {
      if (fleet.some((f) => f.id === s.id)) continue;
      let placed = false;
      for (let t = 0; t < 200 && !placed; t++) {
        const dir: Dir = rng.chance(0.5) ? 'h' : 'v';
        const p: Placement = { id: s.id, dir, x: rng.int(0, dir === 'h' ? SIZE - s.len : SIZE - 1), y: rng.int(0, dir === 'v' ? SIZE - s.len : SIZE - 1) };
        if (!placementError(fleet, p)) {
          fleet.push(p);
          placed = true;
        }
      }
      if (!placed) { failed = true; break; }
    }
    if (!failed) return FLEET.map((s) => fleet.find((f) => f.id === s.id)!);
  }
  throw new Error('could not place fleet');
}

/* ----------------------------------------------------------------- views */

export interface PublicBoard {
  /** Shots fired AT this board. */
  shots: Shot[];
  /** Ships on this board that have been sunk (fully revealed). */
  sunk: Placement[];
  /** Ships still afloat. */
  afloat: number;
  ready: boolean;
}

export interface BattleshipView {
  phase: 'placing' | 'battle' | 'over';
  /** Index of the viewer (0/1), null for spectators. */
  you: 0 | 1 | null;
  players: Array<{ id: string; name: string; connected: boolean }>;
  boards: [PublicBoard, PublicBoard];
  /** Viewer's own fleet (private). Null until placed, or for spectators. */
  mine: Placement[] | null;
  turn: 0 | 1;
  turnDeadline: number | null;
  placeDeadline: number | null;
  /** Most recent shot, for hit/miss/sunk notifications. */
  last: { by: 0 | 1; x: number; y: number; result: 'hit' | 'miss' | 'sunk'; ship?: string } | null;
  log: string[];
  /** Waiting for a disconnected player. */
  paused: string | null;
  winner: 0 | 1 | null;
  endReason: 'victory' | 'forfeit' | 'no-contest' | 'ended' | null;
  stats: Array<{ shots: number; hits: number; sunk: number }>;
  turns: number;
  /** Both fleets, only once the match is over. */
  revealed: Array<Placement[] | null> | null;
}

/* ----------------------------------------------------------------- match */

interface Side {
  player: MpPlayer;
  fleet: Placement[] | null;
  /** Shots received, keyed "x,y". */
  received: Map<string, ShotMark>;
  connected: boolean;
  stats: { shots: number; hits: number; sunk: number };
}

export class BattleshipMatch implements MpMatch {
  private readonly sides: [Side, Side];
  private phase: BattleshipView['phase'] = 'placing';
  private turn: 0 | 1;
  private turns = 0;
  private turnDeadline: number | null = null;
  private placeDeadline: number | null;
  private pausedRemaining: { turn: number | null; place: number | null } | null = null;
  private last: BattleshipView['last'] = null;
  private log: string[] = [];
  private winner: 0 | 1 | null = null;
  private endReason: BattleshipView['endReason'] = null;
  private readonly turnMs: number;
  private readonly onLeave: string;
  private readonly rng: Rng;
  private events: MpEvent[] = [];

  constructor(ctx: MatchContext) {
    if (ctx.players.length !== 2) throw new Error('Battleship needs exactly 2 players');
    const side = (p: MpPlayer): Side => ({ player: p, fleet: null, received: new Map(), connected: true, stats: { shots: 0, hits: 0, sunk: 0 } });
    this.sides = [side(ctx.players[0]), side(ctx.players[1])];
    this.rng = ctx.rng;
    this.turn = ctx.rng.chance(0.5) ? 0 : 1;
    this.turnMs = Number(ctx.options.turnTime) * 1000;
    const placeMs = Number(ctx.options.placeTime) * 1000;
    this.placeDeadline = placeMs > 0 ? ctx.now + placeMs : null;
    this.onLeave = String(ctx.options.onLeave);
    this.say('Deploy your fleet.');
  }

  private idx(playerId: string): 0 | 1 | -1 {
    return this.sides[0].player.id === playerId ? 0 : this.sides[1].player.id === playerId ? 1 : -1;
  }

  private say(line: string): void {
    this.log.push(line);
    if (this.log.length > 6) this.log.shift();
  }

  handleAction(playerId: string, action: unknown, now: number): ActionResult {
    const i = this.idx(playerId);
    if (i === -1) return reject('NOT_PLAYING', 'You are not playing in this match');
    if (!isObj(action)) return reject('INVALID', 'Invalid action');
    if (this.phase === 'over') return reject('PHASE', 'The match is over');
    if (this.pausedRemaining) return reject('PAUSED', 'Waiting for the other player to reconnect');
    const me = this.sides[i];
    switch (action.kind) {
      case 'place': {
        if (this.phase !== 'placing') return reject('PHASE', 'Ships can only be placed before the battle');
        const v = validateFleet(action.fleet);
        if (!v.ok) return reject('INVALID', v.error);
        me.fleet = v.fleet;
        this.say(`${me.player.name} is ready.`);
        this.maybeStartBattle(now);
        return ok;
      }
      case 'unplace': {
        if (this.phase !== 'placing') return reject('PHASE', 'The battle has started');
        me.fleet = null;
        return ok;
      }
      case 'fire': {
        if (this.phase !== 'battle') return reject('PHASE', 'The battle has not started');
        if (this.turn !== i) return reject('NOT_YOUR_TURN', "It is not your turn");
        if (!isInt(action.x, 0, SIZE - 1) || !isInt(action.y, 0, SIZE - 1)) return reject('INVALID', 'Coordinates are off the board');
        const target = this.sides[1 - i];
        const key = `${action.x},${action.y}`;
        if (target.received.has(key)) return reject('ALREADY_FIRED', `You already fired at ${formatCoord(action.x, action.y)}`);
        this.fire(i, action.x, action.y, now);
        return ok;
      }
      default:
        return reject('INVALID', 'Unknown action');
    }
  }

  private maybeStartBattle(now: number): void {
    if (!this.sides[0].fleet || !this.sides[1].fleet) return;
    this.phase = 'battle';
    this.placeDeadline = null;
    this.turnDeadline = this.turnMs > 0 ? now + this.turnMs : null;
    this.say(`Battle stations! ${this.sides[this.turn].player.name} fires first.`);
  }

  private fire(i: 0 | 1, x: number, y: number, now: number): void {
    const me = this.sides[i];
    const target = this.sides[1 - i];
    const ship = target.fleet!.find((p) => shipCells(p).some(([cx, cy]) => cx === x && cy === y));
    me.stats.shots++;
    this.turns++;
    const coord = formatCoord(x, y);
    if (!ship) {
      target.received.set(`${x},${y}`, 'm');
      this.last = { by: i, x, y, result: 'miss' };
      this.say(`${me.player.name} fired at ${coord}: miss.`);
    } else {
      target.received.set(`${x},${y}`, 'h');
      me.stats.hits++;
      const sunk = shipCells(ship).every(([cx, cy]) => target.received.get(`${cx},${cy}`) === 'h');
      if (sunk) {
        me.stats.sunk++;
        this.last = { by: i, x, y, result: 'sunk', ship: shipName(ship.id) };
        this.say(`${me.player.name} fired at ${coord}: HIT and SUNK the ${shipName(ship.id)}!`);
      } else {
        this.last = { by: i, x, y, result: 'hit' };
        this.say(`${me.player.name} fired at ${coord}: HIT!`);
      }
      if (this.afloat(1 - i as 0 | 1) === 0) {
        this.finish(i, 'victory');
        this.say(`${me.player.name} sank the whole fleet!`);
        return;
      }
    }
    this.turn = (1 - i) as 0 | 1;
    this.turnDeadline = this.turnMs > 0 ? now + this.turnMs : null;
  }

  private afloat(i: 0 | 1): number {
    const s = this.sides[i];
    if (!s.fleet) return FLEET.length;
    return s.fleet.filter((p) => !shipCells(p).every(([x, y]) => s.received.get(`${x},${y}`) === 'h')).length;
  }

  private finish(winner: 0 | 1 | null, reason: NonNullable<BattleshipView['endReason']>): void {
    this.phase = 'over';
    this.winner = winner;
    this.endReason = reason;
    this.turnDeadline = null;
    this.placeDeadline = null;
    this.pausedRemaining = null;
  }

  tick(now: number): void {
    if (this.phase === 'over' || this.pausedRemaining) return;
    if (this.phase === 'placing' && this.placeDeadline !== null && now >= this.placeDeadline) {
      for (const s of this.sides) {
        if (!s.fleet) {
          s.fleet = randomFleet(this.rng.fork(`auto:${s.player.id}`));
          this.say(`${s.player.name} ran out of time; fleet auto-deployed.`);
        }
      }
      this.maybeStartBattle(now);
    } else if (this.phase === 'battle' && this.turnDeadline !== null && now >= this.turnDeadline) {
      this.say(`${this.sides[this.turn].player.name} ran out of time and lost the turn.`);
      this.turn = (1 - this.turn) as 0 | 1;
      this.turnDeadline = now + this.turnMs;
    }
  }

  setPresence(playerId: string, presence: Presence, now: number): void {
    const i = this.idx(playerId);
    if (i === -1 || this.phase === 'over') return;
    const s = this.sides[i];
    if (presence === 'gone') {
      s.connected = false;
      if (this.onLeave === 'no-contest') {
        this.finish(null, 'no-contest');
        this.say(`${s.player.name} left. No contest.`);
      } else {
        this.finish((1 - i) as 0 | 1, 'forfeit');
        this.say(`${s.player.name} left the match. ${this.sides[1 - i].player.name} wins by forfeit.`);
      }
      return;
    }
    s.connected = presence === 'connected';
    const anyoneAway = this.sides.some((x) => !x.connected);
    if (anyoneAway && !this.pausedRemaining) {
      // Freeze clocks so nobody loses a turn to a network blip.
      this.pausedRemaining = {
        turn: this.turnDeadline !== null ? Math.max(0, this.turnDeadline - now) : null,
        place: this.placeDeadline !== null ? Math.max(0, this.placeDeadline - now) : null,
      };
      this.say(`${s.player.name} disconnected. Waiting for them to come back...`);
    } else if (!anyoneAway && this.pausedRemaining) {
      const r = this.pausedRemaining;
      this.pausedRemaining = null;
      if (r.turn !== null) this.turnDeadline = now + Math.max(r.turn, 5000);
      if (r.place !== null) this.placeDeadline = now + Math.max(r.place, 10000);
      this.say(`${s.player.name} is back. Resume!`);
    }
  }

  abort(reason: string): void {
    if (this.phase === 'over') return;
    this.finish(null, 'ended');
    this.say(reason);
  }

  private publicBoard(i: 0 | 1): PublicBoard {
    const s = this.sides[i];
    const shots: Shot[] = [...s.received].map(([k, m]) => {
      const [x, y] = k.split(',').map(Number);
      return [x, y, m];
    });
    const sunk = (s.fleet ?? []).filter((p) => shipCells(p).every(([x, y]) => s.received.get(`${x},${y}`) === 'h'));
    return { shots, sunk, afloat: this.afloat(i), ready: !!s.fleet };
  }

  viewFor(playerId: string | null): BattleshipView {
    const i = playerId === null ? -1 : this.idx(playerId);
    const you = i < 0 ? null : (i as 0 | 1);
    // After the match both fleets are revealed: no more secrets to keep.
    return {
      phase: this.phase,
      you,
      players: this.sides.map((s) => ({ id: s.player.id, name: s.player.name, connected: s.connected })),
      boards: [this.publicBoard(0), this.publicBoard(1)],
      mine: you === null ? null : this.sides[you].fleet ? [...this.sides[you].fleet!] : null,
      turn: this.turn,
      turnDeadline: this.turnDeadline,
      placeDeadline: this.placeDeadline,
      last: this.last,
      log: [...this.log],
      paused: this.pausedRemaining ? this.sides.filter((s) => !s.connected).map((s) => s.player.name).join(', ') : null,
      winner: this.winner,
      endReason: this.endReason,
      stats: this.sides.map((s) => ({ ...s.stats })),
      turns: this.turns,
      revealed: this.phase === 'over' ? this.sides.map((s) => (s.fleet ? [...s.fleet] : null)) : null,
    };
  }

  takeEvents(): MpEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  isOver(): boolean {
    return this.phase === 'over';
  }

  outcome(): MatchOutcome | null {
    if (this.phase !== 'over') return null;
    const standings = rankStandings(this.sides.map((s, i) => ({
      playerId: s.player.id,
      name: s.player.name,
      score: this.winner === i ? 1 : 0,
    })));
    const w = this.winner !== null ? this.sides[this.winner].player.name : null;
    const headline =
      this.endReason === 'victory' ? `${w} sank the whole fleet!` :
      this.endReason === 'forfeit' ? `${w} wins by forfeit (opponent left)` :
      this.endReason === 'no-contest' ? 'No contest: a player left' :
      'Match ended by the host';
    const stats: Record<string, Record<string, number>> = {};
    this.sides.forEach((s, i) => {
      stats[s.player.id] = { ...s.stats, won: this.winner === i ? 1 : 0 };
    });
    return { standings, headline, stats, ...(this.endReason === 'victory' || this.endReason === 'forfeit' ? {} : { incomplete: true }) };
  }
}

export const battleshipDef: MpGameDefinition = {
  id: 'battleship',
  name: 'Battleship',
  kind: 'versus',
  tagline: 'Hide your fleet. Find theirs. Classic 10x10 naval duel.',
  minPlayers: 2,
  maxPlayers: 2,
  playersLabel: '2 players',
  rules: [
    'Place 5 ships: Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2.',
    'Take turns firing at the enemy grid. X = hit, o = miss.',
    'Sink every enemy ship to win. Extra players spectate.',
  ],
  options: [
    { key: 'turnTime', label: 'Turn timer', values: [0, 20, 30, 60], default: 0, unit: 's' },
    { key: 'placeTime', label: 'Placement timer', values: [0, 60, 90, 120], default: 0, unit: 's' },
    { key: 'onLeave', label: 'If a player leaves', values: ['forfeit', 'no-contest'], default: 'forfeit' },
  ],
  create: (ctx) => new BattleshipMatch(ctx),
};
