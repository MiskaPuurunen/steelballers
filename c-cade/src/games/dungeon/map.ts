import type { Rng } from '../../core/rng.js';
import { floorPool } from './enemies.js';

/**
 * Procedural floors for Dependency Dungeon: rooms joined by corridors, with
 * dependencies to collect, loot, hazards, a safe room and enemy groups.
 */

export const MAP_W = 40;
export const MAP_H = 13;
/** The last floor holds the final boss at the gate. */
export const FLOORS = 4;

export interface Pos { x: number; y: number }
interface Room { x: number; y: number; w: number; h: number }

/**
 * package: a dependency (all are needed to open the gate)
 * coin: gold · patch: small heal · trap: hazard · chest: loot
 * safe: safe room (rest / merchant) · event: a random choice
 */
export type ItemKind = 'package' | 'coin' | 'patch' | 'trap' | 'chest' | 'safe' | 'event';
export interface Item extends Pos { kind: ItemKind }

export interface MapEnemy extends Pos {
  /** Enemy ids in this encounter; the first is shown on the map. */
  group: string[];
  /** Map turns it won't chase or engage (after you flee from it). */
  dazed: number;
}

export interface Dungeon {
  tiles: string[][]; // '#' wall or '.' floor
  start: Pos;
  exit: Pos;
  items: Item[];
  enemies: MapEnemy[];
  /** The final boss waits on the gate of the last floor. */
  boss: string | null;
}

export const DIRS: Pos[] = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
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

/** Roll an encounter group for a floor: mostly one enemy, sometimes a pair deeper down. */
export function rollGroup(rng: Rng, floor: number): string[] {
  const pool = floorPool(floor);
  const lead = rng.pick(pool).id;
  if (floor >= 2 && rng.chance(0.25)) return [lead, rng.pick(floorPool(Math.min(floor, 2))).id];
  return [lead];
}

/** Procedurally generate a fully connected floor. Deterministic per rng. */
export function generateDungeon(rng: Rng, level: 0 | 1 | 2, floor = 1): Dungeon {
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

  const bossFloor = floor >= FLOORS;
  const items: Item[] = [];
  const counts: Array<[ItemKind, number]> = [
    ['package', bossFloor ? 0 : level === 0 ? 2 : 3],
    ['coin', rng.int(6, 10)],
    ['patch', level === 2 ? 1 : 2],
    ['trap', [2, 3, 4][level]],
    ['chest', floor === 1 ? 1 : 2],
    ['safe', 1],
    ['event', 1],
  ];
  for (const [kind, n] of counts) {
    for (let i = 0; i < n; i++) { const p = take(); if (p) items.push({ ...p, kind }); }
  }
  const enemies: MapEnemy[] = [];
  const enemyCount = [3, 4, 5][level];
  // Enemies never start within 6 steps of the player.
  const farCells = free.slice(cursor).filter((p) => (dist.get(pk(p)) ?? 0) >= 6);
  let farCursor = 0;
  const place = (group: string[]) => {
    const p = farCursor < farCells.length ? farCells[farCursor++] : null;
    if (p) enemies.push({ ...p, group, dazed: 0 });
  };
  for (let i = 0; i < enemyCount; i++) place(rollGroup(rng, floor));
  // An optional elite on the middle floors: risky, but it drops great loot.
  if (floor >= 2 && !bossFloor) place(['breaker']);
  return { tiles, start, exit, items, enemies, boss: bossFloor ? 'monolith' : null };
}
