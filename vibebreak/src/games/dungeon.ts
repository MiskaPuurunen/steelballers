import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { c, theme } from '../ui/style.js';

/**
 * DEPENDENCY DUNGEON — a compact turn-based roguelike.
 * Install every dependency (&), then reach the publish gate (>).
 */

export const MAP_W = 40;
export const MAP_H = 13;
const VIEW_RADIUS = 5.5;

export interface Pos { x: number; y: number }
interface Room { x: number; y: number; w: number; h: number }

export type ItemKind = 'package' | 'coin' | 'patch' | 'trap';
export interface Item extends Pos { kind: ItemKind }

export interface EnemyType { glyph: string; name: string; hp: number; dmg: number }
export const ENEMY_TYPES: EnemyType[] = [
  { glyph: 'b', name: 'flaky test', hp: 1, dmg: 1 },
  { glyph: 'n', name: 'NaN', hp: 2, dmg: 1 },
  { glyph: 'G', name: 'God Object', hp: 3, dmg: 2 },
];
export interface Enemy extends Pos { type: EnemyType; hp: number }

export interface Dungeon {
  tiles: string[][]; // '#' wall or '.' floor
  start: Pos;
  exit: Pos;
  items: Item[];
  enemies: Enemy[];
}

const DIRS: Pos[] = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
const pk = (p: Pos) => `${p.x},${p.y}`;

export function bfsDistances(tiles: string[][], from: Pos): Map<string, number> {
  const dist = new Map<string, number>([[pk(from), 0]]);
  const q: Pos[] = [from];
  while (q.length) {
    const p = q.shift()!;
    const d = dist.get(pk(p))!;
    for (const dir of DIRS) {
      const n = { x: p.x + dir.x, y: p.y + dir.y };
      if (n.x < 0 || n.y < 0 || n.x >= MAP_W || n.y >= MAP_H) continue;
      if (tiles[n.y][n.x] !== '.' || dist.has(pk(n))) continue;
      dist.set(pk(n), d + 1);
      q.push(n);
    }
  }
  return dist;
}

/** Procedurally generate a fully connected dungeon. Deterministic per rng. */
export function generateDungeon(rng: Rng, level: 0 | 1 | 2): Dungeon {
  const tiles = Array.from({ length: MAP_H }, () => Array.from({ length: MAP_W }, () => '#'));
  const rooms: Room[] = [];
  const target = rng.int(5, 7);
  for (let attempt = 0; attempt < 200 && rooms.length < target; attempt++) {
    const w = rng.int(4, 9);
    const h = rng.int(3, 4);
    const x = rng.int(1, MAP_W - w - 1);
    const y = rng.int(1, MAP_H - h - 1);
    const overlaps = rooms.some((r) => x <= r.x + r.w && x + w >= r.x && y <= r.y + r.h && y + h >= r.y);
    if (overlaps) continue;
    rooms.push({ x, y, w, h });
  }
  // Sort left-to-right so corridors form a sensible chain.
  rooms.sort((a, b) => a.x - b.x);
  for (const r of rooms) {
    for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) tiles[yy][xx] = '.';
  }
  const centre = (r: Room): Pos => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
  const carveH = (x1: number, x2: number, y: number) => { for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) tiles[y][x] = '.'; };
  const carveV = (y1: number, y2: number, x: number) => { for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) tiles[y][x] = '.'; };
  for (let i = 1; i < rooms.length; i++) {
    const a = centre(rooms[i - 1]);
    const b = centre(rooms[i]);
    if (rng.chance(0.5)) { carveH(a.x, b.x, a.y); carveV(a.y, b.y, b.x); }
    else { carveV(a.y, b.y, a.x); carveH(a.x, b.x, b.y); }
  }
  // An extra loop corridor sometimes, so maps are not always linear.
  if (rooms.length > 3 && rng.chance(0.6)) {
    const a = centre(rooms[0]);
    const b = centre(rooms[rng.int(2, rooms.length - 1)]);
    carveV(a.y, b.y, a.x); carveH(a.x, b.x, b.y);
  }

  const start = centre(rooms[0]);
  const dist = bfsDistances(tiles, start);
  let exit = start;
  let best = -1;
  for (const [k, d] of dist) {
    if (d > best) { best = d; const [x, y] = k.split(',').map(Number); exit = { x, y }; }
  }

  // Candidate cells: reachable floor, not start/exit, not right next to start.
  const free = rng.shuffle(
    [...dist.keys()]
      .map((k) => { const [x, y] = k.split(',').map(Number); return { x, y }; })
      .filter((p) => !(p.x === exit.x && p.y === exit.y) && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 2),
  );
  let cursor = 0;
  const take = (): Pos | null => (cursor < free.length ? free[cursor++] : null);

  const items: Item[] = [];
  const counts: Array<[ItemKind, number]> = [
    ['package', level === 0 ? 2 : 3],
    ['coin', rng.int(6, 10)],
    ['patch', level === 2 ? 1 : 2],
    ['trap', [2, 3, 4][level]],
  ];
  for (const [kind, n] of counts) {
    for (let i = 0; i < n; i++) { const p = take(); if (p) items.push({ ...p, kind }); }
  }
  const enemies: Enemy[] = [];
  const enemyCount = [3, 4, 6][level];
  // Enemies never start within 6 steps of the player.
  const farCells = free.slice(cursor).filter((p) => (dist.get(pk(p)) ?? 0) >= 6);
  let farCursor = 0;
  for (let i = 0; i < enemyCount; i++) {
    const p = farCursor < farCells.length ? farCells[farCursor++] : null;
    if (!p) break;
    const pool = level === 2 ? ENEMY_TYPES : ENEMY_TYPES.slice(0, 2);
    const type = rng.pick(pool);
    enemies.push({ ...p, type, hp: type.hp });
  }
  return { tiles, start, exit, items, enemies };
}

export class DependencyDungeon extends BaseGame {
  readonly minSize = { width: MAP_W + 8, height: MAP_H + 5 }; // fits 80x24

  readonly map: Dungeon;
  player: Pos;
  hp: number;
  readonly maxHp: number;
  packages = 0;
  readonly packagesNeeded: number;
  coins = 0;
  kills = 0;
  turns = 0;
  damageTaken = 0;
  private seen = new Set<string>();
  private log: string[] = [];

  constructor(ctx: GameContext) {
    super(ctx);
    this.map = generateDungeon(this.rng.fork('map'), this.level);
    this.player = { ...this.map.start };
    const baseHp = [7, 6, 5][this.level];
    this.maxHp = this.effects.lives !== null ? Math.min(baseHp, this.effects.lives) : baseHp;
    this.hp = this.maxHp;
    this.packagesNeeded = this.map.items.filter((i) => i.kind === 'package').length;
    this.reveal();
    this.say(`Get ${this.packagesNeeded} deps (&), then publish at the > gate.`);
  }

  private say(msg: string): void {
    this.log.push(msg);
    if (this.log.length > 2) this.log.shift();
  }

  private visible(p: Pos): boolean {
    const dx = p.x - this.player.x;
    const dy = (p.y - this.player.y) * 1.6; // terminal cells are taller than wide
    return dx * dx + dy * dy <= VIEW_RADIUS * VIEW_RADIUS * 1.6;
  }

  private reveal(): void {
    let fresh = 0;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!this.visible({ x, y })) continue;
        const k = `${x},${y}`;
        if (!this.seen.has(k)) {
          this.seen.add(k);
          if (this.map.tiles[y][x] === '.') fresh++;
        }
      }
    }
    if (fresh > 0 && this.turns > 0) this.addScore(fresh);
  }

  explored(): number {
    let n = 0;
    for (const k of this.seen) { const [x, y] = k.split(',').map(Number); if (this.map.tiles[y][x] === '.') n++; }
    return n;
  }

  /** Walls are only drawn where they border floor, so rock stays dark. */
  private isEdgeWall(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < MAP_W && ny < MAP_H && this.map.tiles[ny][nx] === '.') return true;
      }
    }
    return false;
  }

  private enemyAt(p: Pos): Enemy | undefined {
    return this.map.enemies.find((e) => e.x === p.x && e.y === p.y && e.hp > 0);
  }

  private walkable(p: Pos): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < MAP_W && p.y < MAP_H && this.map.tiles[p.y][p.x] === '.';
  }

  protected tick(): void {
    /* Turn-based: the world only advances on player input. */
  }

  protected onKey(key: Key): void {
    const map: Record<string, Pos> = {
      w: DIRS[0], s: DIRS[1], a: DIRS[2], d: DIRS[3],
      k: DIRS[0], j: DIRS[1], h: DIRS[2], l: DIRS[3],
    };
    let dir: Pos | null = null;
    if (key.name === 'up') dir = DIRS[0];
    else if (key.name === 'down') dir = DIRS[1];
    else if (key.name === 'left') dir = DIRS[2];
    else if (key.name === 'right') dir = DIRS[3];
    else if (key.ch && map[key.ch.toLowerCase()]) dir = map[key.ch.toLowerCase()];
    else if (key.name === 'space' || key.ch === '.') dir = { x: 0, y: 0 }; // wait a turn
    if (!dir) return;
    this.takeTurn(dir);
  }

  /** Resolve one player action and the world's response. Public for tests. */
  takeTurn(dir: Pos): void {
    if (this.isOver()) return;
    const target = { x: this.player.x + dir.x, y: this.player.y + dir.y };
    const foe = dir.x || dir.y ? this.enemyAt(target) : undefined;

    if (foe) {
      foe.hp--;
      if (foe.hp <= 0) {
        this.kills++;
        const pts = this.addScore(40 * foe.type.hp);
        this.say(`You resolved the ${foe.type.name}. +${pts}`);
      } else {
        this.say(`You hit the ${foe.type.name}.`);
      }
    } else if (dir.x || dir.y) {
      if (!this.walkable(target)) return; // bumping a wall costs no turn
      this.player = target;
      this.pickUp();
      if (this.isOver()) return;
    }

    this.turns++;
    this.enemiesAct();
    this.randomEncounter();
    this.reveal();
  }

  private pickUp(): void {
    const p = this.player;
    const idx = this.map.items.findIndex((i) => i.x === p.x && i.y === p.y);
    if (idx >= 0) {
      const item = this.map.items[idx];
      this.map.items.splice(idx, 1);
      if (item.kind === 'package') {
        this.packages++;
        const pts = this.addScore(100);
        this.say(`Installed dependency ${this.packages}/${this.packagesNeeded}. +${pts}`);
        if (this.packages === this.packagesNeeded) this.flash('All deps installed! Find the > gate.', 'gold', 1500);
      } else if (item.kind === 'coin') {
        this.coins++;
        const pts = this.addScore(25 * this.effects.specialMult);
        this.say(`Found a GitHub star. +${pts}`);
      } else if (item.kind === 'patch') {
        const before = this.hp;
        this.hp = Math.min(this.maxHp, this.hp + 2);
        this.say(`Applied a hotfix patch. +${this.hp - before} HP`);
      } else if (item.kind === 'trap') {
        this.hurt(1, 'You stepped on a breaking change!');
      }
    }
    if (p.x === this.map.exit.x && p.y === this.map.exit.y) {
      if (this.packages >= this.packagesNeeded) {
        // Untimed rounds have no clock, so no time bonus.
        const timeBonus = Math.floor((this.timeLeftMs() ?? 0) / 1000) * 5;
        const pts = this.addScore(300 + timeBonus + this.hp * 20);
        this.flash(`Published! +${pts}`, 'gold', 2000);
        this.end('win');
      } else {
        this.say(`npm ERR! missing ${this.packagesNeeded - this.packages} dependencies.`);
      }
    }
  }

  private hurt(base: number, msg: string): void {
    const dmg = Math.ceil(base * this.effects.penaltyMult);
    this.hp -= dmg;
    this.damageTaken += dmg;
    this.say(`${msg} -${dmg} HP`);
    this.flash(`-${dmg} HP`, 'bad', 500);
    if (this.hp <= 0) {
      this.hp = 0;
      this.flash('Build failed. You were garbage collected.', 'bad', 2500);
      this.end('gameover');
    }
  }

  private enemiesAct(): void {
    for (const e of this.map.enemies) {
      if (e.hp <= 0 || this.isOver()) continue;
      const dx = this.player.x - e.x;
      const dy = this.player.y - e.y;
      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan === 1) {
        if (this.rng.chance(0.7)) this.hurt(e.type.dmg, `The ${e.type.name} bites.`);
        continue;
      }
      let step: Pos | null = null;
      if (manhattan <= 6) {
        const options = [
          Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) },
          Math.abs(dx) >= Math.abs(dy) ? { x: 0, y: Math.sign(dy) } : { x: Math.sign(dx), y: 0 },
        ].filter((o) => o.x || o.y);
        step = options.find((o) => this.canEnemyStep(e, o)) ?? null;
      } else if (this.rng.chance(0.3)) {
        const o = this.rng.pick(DIRS);
        if (this.canEnemyStep(e, o)) step = o;
      }
      if (step) { e.x += step.x; e.y += step.y; }
    }
  }

  private canEnemyStep(e: Enemy, d: Pos): boolean {
    const n = { x: e.x + d.x, y: e.y + d.y };
    if (!this.walkable(n)) return false;
    if (n.x === this.player.x && n.y === this.player.y) return false;
    return !this.enemyAt(n);
  }

  private randomEncounter(): void {
    const chance = this.effects.chaos ? 0.08 : 0.025;
    if (!this.rng.chance(chance)) return;
    const candidates: Pos[] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const p = { x, y };
        const d = Math.abs(x - this.player.x) + Math.abs(y - this.player.y);
        if (this.walkable(p) && d >= 5 && d <= 10 && !this.enemyAt(p)) candidates.push(p);
      }
    }
    if (!candidates.length) return;
    const p = this.rng.pick(candidates);
    const type = ENEMY_TYPES[this.rng.int(0, this.level === 2 ? 2 : 1)];
    this.map.enemies.push({ ...p, type, hp: type.hp });
    this.say(this.effects.chaos ? 'Merge conflict! Something spawned nearby.' : `A wild ${type.name} appears!`);
  }

  render(): string[] {
    const lines: string[] = [theme.muted('+' + '-'.repeat(MAP_W) + '+')];
    for (let y = 0; y < MAP_H; y++) {
      let row = '';
      for (let x = 0; x < MAP_W; x++) {
        const p = { x, y };
        const k = `${x},${y}`;
        const vis = this.visible(p);
        if (!this.seen.has(k)) { row += ' '; continue; }
        if (x === this.player.x && y === this.player.y) { row += theme.primary(c.bold('@')); continue; }
        const isExit = x === this.map.exit.x && y === this.map.exit.y;
        if (!vis) {
          row += isExit ? c.dim('>') : this.map.tiles[y][x] === '#' ? (this.isEdgeWall(x, y) ? c.gray('#') : ' ') : ' ';
          continue;
        }
        const foe = this.enemyAt(p);
        if (foe) { row += c.bold(c.red(foe.type.glyph)); continue; }
        const item = this.map.items.find((i) => i.x === x && i.y === y);
        if (item) {
          row += item.kind === 'package' ? theme.accent(c.bold('&'))
            : item.kind === 'coin' ? theme.gold('*')
            : item.kind === 'patch' ? theme.good('+')
            : c.yellow('^');
          continue;
        }
        if (isExit) { row += this.packages >= this.packagesNeeded ? theme.gold(c.bold('>')) : c.white('>'); continue; }
        row += this.map.tiles[y][x] === '#' ? (this.isEdgeWall(x, y) ? c.white('#') : ' ') : c.gray('.');
      }
      lines.push(theme.muted('|') + row + theme.muted('|'));
    }
    lines.push(theme.muted('+' + '-'.repeat(MAP_W) + '+'));
    for (const m of this.log) lines.push(theme.muted('> ') + (m.length > MAP_W + 4 ? m.slice(0, MAP_W + 3) + '~' : m));
    while (lines.length < MAP_H + 4) lines.push('');
    lines.push(
      theme.primary('@') + theme.muted('you ') + theme.accent('&') + theme.muted('dep ') + theme.gold('*') + theme.muted('star ') +
      theme.good('+') + theme.muted('patch ') + c.yellow('^') + theme.muted('trap ') + c.red('bnG') + theme.muted(' bugs >gate'),
    );
    return lines;
  }

  hud(): HudItem[] {
    return [
      { label: 'HP', value: `${'#'.repeat(this.hp)}${'.'.repeat(Math.max(0, this.maxHp - this.hp))}`, tone: this.hp <= 2 ? 'bad' : 'good' },
      { label: 'DEPS', value: `${this.packages}/${this.packagesNeeded}`, tone: this.packages === this.packagesNeeded ? 'gold' : 'info' },
    ];
  }

  protected stats(): Record<string, number> {
    return {
      escaped: this.endReason === 'win' ? 1 : 0,
      kills: this.kills,
      stars: this.coins,
      packages: this.packages,
      explored: this.explored(),
      turns: this.turns,
      damageTaken: this.damageTaken,
    };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Outcome', this.endReason === 'win' ? 'Published!' : this.endReason === 'gameover' ? 'Garbage collected' : 'Still in the dungeon'],
      ['Dependencies', `${this.packages}/${this.packagesNeeded}`],
      ['Bugs resolved', String(this.kills)],
      ['Stars found', String(this.coins)],
      ['Tiles explored', String(this.explored())],
      ['Turns', String(this.turns)],
    ];
  }

  protected isPerfect(): boolean {
    return this.endReason === 'win' && this.damageTaken === 0;
  }
}

export const dungeonDef: GameDefinition = {
  id: 'dungeon',
  name: 'Dependency Dungeon',
  genre: 'Mini roguelike',
  tagline: 'Install every dependency, dodge the bugs, publish at the gate.',
  controls: [
    ['Arrows / WASD / HJKL', 'move / attack by bumping'],
    ['Space or .', 'wait a turn'],
  ],
  weight: 2,
  defaultDurationSec: 60,
  untimed: true,
  xpScale: 10,
  create: (ctx) => new DependencyDungeon(ctx),
};
