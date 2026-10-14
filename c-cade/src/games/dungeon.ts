import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { applyEffect, endTurn, heal, startTurn } from './dungeon/effects.js';
import { Combat, type PlayerAction } from './dungeon/combat.js';
import { ENEMIES } from './dungeon/enemies.js';
import {
  CLASS_ORDER, CLASSES, UPGRADES, createHero, equip, gainXp, heroStats, refreshHero, takeUpgrade, upgradeChoices,
  type ClassId, type Hero, type UpgradeId,
} from './dungeon/hero.js';
import { CONSUMABLES, GEAR, POTION_HEAL, addToBag, rollConsumable, rollGear, type ConsumableId } from './dungeon/items.js';
import {
  DIRS, FLOORS, MAP_H, MAP_W, generateDungeon, rollGroup,
  type Dungeon, type MapEnemy, type Pos,
} from './dungeon/map.js';
import * as view from './dungeon/render.js';

export { MAP_H, MAP_W, FLOORS, bfsDistances, generateDungeon } from './dungeon/map.js';
export type { Dungeon, Item, ItemKind, MapEnemy, Pos } from './dungeon/map.js';

/**
 * DEPENDENCY DUNGEON — a compact roguelite.
 * Pick a class, explore four floors, install every dependency (&) to open
 * each gate (>), fight telegraphed turn-based battles, loot, level up, and
 * beat The Legacy Monolith on the last gate.
 *
 * Rules live in ./dungeon/*.ts (no terminal code); this class turns keys
 * into rule calls and owns the run's state; ./dungeon/render.ts draws it.
 */

const VIEW_RADIUS = 5.5;

type EventId = 'oracle' | 'npm' | 'runner';

export type Choice =
  | { kind: 'levelup'; options: UpgradeId[] }
  | { kind: 'loot'; gear: string }
  | { kind: 'safe' }
  | { kind: 'event'; event: EventId }
  | { kind: 'gate' }
  | { kind: 'boss' };

export interface Fight {
  combat: Combat;
  foe: MapEnemy | null;
  target: number;
  menu: 'main' | 'item';
  inspect: boolean;
  /** Refusal or hint for the last key (not consuming a turn). */
  notice: string | null;
  rewards: { xp: number; gold: number; drops: string[] } | null;
}

export type Mode =
  | { kind: 'class'; sel: number }
  | { kind: 'explore' }
  | { kind: 'bag' }
  | { kind: 'combat'; fight: Fight }
  | { kind: 'choice'; choice: Choice };

export class DependencyDungeon extends BaseGame {
  readonly minSize = { width: 72, height: 18 }; // fits 80x24

  map: Dungeon;
  player: Pos;
  hero: Hero;
  mode: Mode = { kind: 'class', sel: 0 };
  floor = 1;
  packages = 0;
  packagesNeeded: number;
  coins = 0;
  kills = 0;
  turns = 0;
  damageTaken = 0;
  /** Run stats for achievements. */
  readonly run = { combatWins: 0, flawless: 0, itemKills: 0, elites: 0, bosses: 0, pacifist: 0 };
  private fightsThisFloor = 0;
  private fightCount = 0;
  private safeUsed = false;
  private queue: Choice[] = [];
  private seen = new Set<string>();
  private log: string[] = [];
  private readonly lootRng: Rng;

  constructor(ctx: GameContext) {
    super(ctx);
    this.map = generateDungeon(this.rng.fork('map'), this.level, 1);
    this.player = { ...this.map.start };
    this.packagesNeeded = this.countPackages();
    this.lootRng = this.rng.fork('loot');
    this.hero = createHero('warrior');
  }

  /* -------------------------------------------------------- setup */

  /** Start the run as a class. Public for tests. */
  chooseClass(cls: ClassId): void {
    if (this.mode.kind !== 'class') return;
    this.hero = createHero(cls);
    // Limited-lives modifiers (Glass Cannon) start you hurt: 20% of max HP per life, up to full.
    if (this.effects.lives !== null) {
      this.hero.hp = Math.max(1, Math.round(this.hero.maxHp * Math.min(1, this.effects.lives / 5)));
    }
    this.mode = { kind: 'explore' };
    this.reveal();
    this.say(`${CLASSES[cls].name}. Get ${this.packagesNeeded} deps (&), then take the > gate.`);
  }

  private countPackages(): number {
    return this.map.items.filter((i) => i.kind === 'package').length;
  }

  private say(msg: string): void {
    this.log.push(msg);
    if (this.log.length > 2) this.log.shift();
  }

  /* --------------------------------------------------------- vision */

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

  private enemyAt(p: Pos): MapEnemy | undefined {
    return this.map.enemies.find((e) => e.x === p.x && e.y === p.y);
  }

  private walkable(p: Pos): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < MAP_W && p.y < MAP_H && this.map.tiles[p.y][p.x] === '.';
  }

  protected tick(): void {
    /* Turn-based: the world only advances on player input. */
  }

  /* ---------------------------------------------------------- input */

  protected onKey(key: Key): void {
    const ch = key.name === 'char' && !key.ctrl ? key.ch?.toLowerCase() : undefined;
    const digit = ch && /^[0-9]$/.test(ch) ? Number(ch) : null;
    switch (this.mode.kind) {
      case 'class': return this.classKey(key, digit);
      case 'explore': return this.exploreKey(key, ch);
      case 'bag': return this.bagKey(key, ch, digit);
      case 'combat': return this.combatKey(this.mode.fight, key, digit);
      case 'choice': if (digit !== null) this.choose(digit); return;
    }
  }

  private classKey(key: Key, digit: number | null): void {
    if (this.mode.kind !== 'class') return;
    if (digit !== null && digit >= 1 && digit <= CLASS_ORDER.length) return this.chooseClass(CLASS_ORDER[digit - 1]);
    if (key.name === 'left' || key.name === 'up') this.mode.sel = (this.mode.sel + CLASS_ORDER.length - 1) % CLASS_ORDER.length;
    else if (key.name === 'right' || key.name === 'down' || key.name === 'tab') this.mode.sel = (this.mode.sel + 1) % CLASS_ORDER.length;
    else if (key.name === 'enter' || key.name === 'space') this.chooseClass(CLASS_ORDER[this.mode.sel]);
  }

  private exploreKey(key: Key, ch: string | undefined): void {
    const keys: Record<string, Pos> = {
      w: DIRS[0], s: DIRS[1], a: DIRS[2], d: DIRS[3],
      k: DIRS[0], j: DIRS[1], h: DIRS[2], l: DIRS[3],
    };
    let dir: Pos | null = null;
    if (key.name === 'up') dir = DIRS[0];
    else if (key.name === 'down') dir = DIRS[1];
    else if (key.name === 'left') dir = DIRS[2];
    else if (key.name === 'right') dir = DIRS[3];
    else if (ch === 'i' || key.name === 'tab') { this.mode = { kind: 'bag' }; return; }
    else if (ch && keys[ch]) dir = keys[ch];
    else if (key.name === 'space' || ch === '.') dir = { x: 0, y: 0 }; // wait a turn
    if (dir) this.takeTurn(dir);
  }

  private bagKey(key: Key, ch: string | undefined, digit: number | null): void {
    if (ch === 'i' || key.name === 'tab' || key.name === 'backspace' || digit === 0) { this.mode = { kind: 'explore' }; return; }
    const items = view.bagEntries(this.hero).filter((e) => CONSUMABLES[e.id].field);
    if (digit !== null && digit >= 1 && digit <= items.length) this.useFieldItem(items[digit - 1].id);
  }

  /** Drink a potion etc. while exploring. Public for tests. */
  useFieldItem(id: ConsumableId): boolean {
    const h = this.hero;
    const i = h.bag.indexOf(id);
    if (i < 0 || !CONSUMABLES[id].field) return false;
    h.bag.splice(i, 1);
    const s = heroStats(h);
    if (id === 'potion') heal(h, POTION_HEAL);
    else if (id === 'ether') { h.sta = Math.min(s.maxSta, h.sta + 6); h.mp = Math.min(s.maxMp, h.mp + 6); }
    else if (id === 'antidote') h.effects = h.effects.filter((e) => e.id !== 'poison' && e.id !== 'burn' && e.id !== 'weaken');
    this.flash(`Used ${CONSUMABLES[id].name}.`, 'good', 900);
    return true;
  }

  private combatKey(f: Fight, key: Key, digit: number | null): void {
    f.notice = null;
    if (f.combat.outcome !== 'ongoing') {
      if (key.name === 'enter' || key.name === 'space') this.closeFight(f);
      return;
    }
    const living = f.combat.enemies.map((e, i) => (e.hp > 0 ? i : -1)).filter((i) => i >= 0);
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || key.name === 'up' || key.name === 'down') {
      const at = Math.max(0, living.indexOf(f.target));
      const step = key.name === 'left' || key.name === 'up' ? -1 : 1;
      f.target = living[(at + step + living.length) % living.length];
      return;
    }
    if (f.menu === 'item') {
      if (digit === 0 || key.name === 'backspace') { f.menu = 'main'; return; }
      const items = view.bagEntries(this.hero);
      if (digit !== null && digit >= 1 && digit <= items.length) {
        f.menu = 'main';
        this.combatAction({ type: 'item', item: items[digit - 1].id });
      }
      return;
    }
    const t = f.target;
    const actions: Record<number, PlayerAction | 'item' | 'inspect'> = {
      1: { type: 'attack', target: t }, 2: { type: 'heavy', target: t }, 3: { type: 'defend' }, 4: { type: 'dodge' },
      5: { type: 'skill', target: t }, 6: 'item', 7: 'inspect', 8: { type: 'flee' },
    };
    const a = digit !== null ? actions[digit] : undefined;
    if (!a) return;
    if (a === 'inspect') { f.inspect = !f.inspect; return; }
    if (a === 'item') {
      if (!this.hero.bag.length) f.notice = 'Your bag is empty.';
      else f.menu = 'item';
      return;
    }
    this.combatAction(a);
  }

  /** Take a combat action for the current fight. Public for tests. Returns the refusal reason, if any. */
  combatAction(a: PlayerAction): string | null {
    if (this.mode.kind !== 'combat') return 'Not in combat.';
    const f = this.mode.fight;
    const hpBefore = this.hero.hp;
    const why = f.combat.act(a);
    if (why) { f.notice = why; return why; }
    f.inspect = false;
    const lost = Math.max(0, hpBefore - this.hero.hp);
    if (lost > 0) this.flash(`-${lost} HP`, 'bad', 600);
    // Keep the target on a living enemy.
    if (!f.combat.enemies[f.target] || f.combat.enemies[f.target].hp <= 0) {
      const next = f.combat.enemies.findIndex((e) => e.hp > 0);
      if (next >= 0) f.target = next;
    }
    if (f.combat.outcome !== 'ongoing') this.resolveFight(f);
    return null;
  }

  /* ------------------------------------------------------- explore */

  /** Resolve one exploration step and the world's response. Public for tests. */
  takeTurn(dir: Pos): void {
    if (this.isOver() || this.mode.kind !== 'explore') return;
    const target = { x: this.player.x + dir.x, y: this.player.y + dir.y };
    const foe = dir.x || dir.y ? this.enemyAt(target) : undefined;
    if (foe) {
      this.turns++;
      this.startFight(foe.group, foe, false);
      return;
    }
    if (dir.x || dir.y) {
      if (!this.walkable(target)) return; // bumping a wall costs no turn
      this.player = target;
    }
    this.turns++;
    this.mapTurnEffects();
    if (this.isOver()) return;
    if (dir.x || dir.y) this.pickUp();
    if (this.mode.kind === 'explore' && this.queue.length) this.flushQueue();
    if (this.isOver() || this.mode.kind !== 'explore') { this.reveal(); return; }
    this.enemiesAct();
    if (this.mode.kind === 'explore') this.randomEncounter();
    this.reveal();
  }

  /** Each step is a hero turn: damage over time ticks, stamina and mana trickle back. */
  private mapTurnEffects(): void {
    const h = this.hero;
    const s = heroStats(h);
    const st = startTurn(h);
    endTurn(h);
    if (st.dot > 0) {
      this.damageTaken += st.dot;
      this.say(st.messages.join(' '));
      if (h.hp <= 0) return this.die('The poison finished the job.');
    }
    h.sta = Math.min(s.maxSta, h.sta + 1);
    if (this.turns % 2 === 0) h.mp = Math.min(s.maxMp, h.mp + 1);
  }

  private pickUp(): void {
    const p = this.player;
    const h = this.hero;
    const idx = this.map.items.findIndex((i) => i.x === p.x && i.y === p.y);
    if (idx >= 0) {
      const item = this.map.items[idx];
      if (item.kind !== 'safe') this.map.items.splice(idx, 1);
      switch (item.kind) {
        case 'package': {
          this.packages++;
          const pts = this.addScore(100);
          this.levelUps(gainXp(h, 3));
          this.say(`Installed dependency ${this.packages}/${this.packagesNeeded}. +${pts}`);
          if (this.packages === this.packagesNeeded) this.flash('All deps installed! Find the > gate.', 'gold', 1500);
          break;
        }
        case 'coin': {
          this.coins++;
          const gold = this.lootRng.int(3, 6) + this.floor * 2;
          h.gold += gold;
          const pts = this.addScore(25 * this.effects.specialMult);
          this.say(`Found ${gold} gold. +${pts}`);
          break;
        }
        case 'patch': {
          this.say(`Applied a hotfix patch. +${heal(h, 0.25)} HP`);
          break;
        }
        case 'trap': this.trap(); break;
        case 'chest': this.openChest(); break;
        case 'safe': this.open({ kind: 'safe' }); break;
        case 'event': this.open({ kind: 'event', event: this.lootRng.pick<EventId>(['oracle', 'npm', 'runner']) }); break;
      }
    }
    if (this.isOver()) return;
    if (p.x === this.map.exit.x && p.y === this.map.exit.y) {
      if (this.map.boss) this.open({ kind: 'boss' });
      else if (this.packages >= this.packagesNeeded) this.open({ kind: 'gate' });
      else this.say(`npm ERR! missing ${this.packagesNeeded - this.packages} dependencies.`);
    }
  }

  /** Traps: a SPD-based dodge roll halves the hit; some poison. */
  private trap(): void {
    const s = heroStats(this.hero);
    const avoid = this.lootRng.chance(s.dodge / 200);
    if (avoid) { this.say('You spot a breaking change and hop over it!'); return; }
    const dmg = Math.ceil((3 + this.floor * 2) * this.effects.penaltyMult);
    this.hurt(dmg, 'You stepped on a breaking change!');
    if (this.hero.hp > 0 && this.lootRng.chance(0.4)) {
      applyEffect(this.hero, 'poison', { turns: 3, potency: 1 + Math.floor(this.floor / 2) });
      this.say('A rusty pin: you are Poisoned.');
    }
  }

  private openChest(): void {
    const h = this.hero;
    this.levelUps(gainXp(h, 5));
    if (this.lootRng.chance(0.6)) {
      const gear = rollGear(this.lootRng, this.floor, { exclude: this.wornGear() });
      this.say(`The chest holds ${GEAR[gear.id].name}.`);
      this.queue.unshift({ kind: 'loot', gear: gear.id });
    } else {
      const got = [rollConsumable(this.lootRng), rollConsumable(this.lootRng)].map((id) => this.give(id));
      this.say(`The chest holds ${got.join(' and ')}.`);
    }
    this.flushQueue();
  }

  /** Add a consumable or sell it if the bag is full. Returns a description. */
  private give(id: ConsumableId): string {
    if (addToBag(this.hero.bag, id)) return `a ${CONSUMABLES[id].name}`;
    const gold = Math.floor(CONSUMABLES[id].price / 2);
    this.hero.gold += gold;
    return `a ${CONSUMABLES[id].name} (bag full: sold for ${gold}g)`;
  }

  private hurt(dmg: number, msg: string): void {
    const h = this.hero;
    h.hp = Math.max(0, h.hp - dmg);
    this.damageTaken += dmg;
    this.say(`${msg} -${dmg} HP`);
    this.flash(`-${dmg} HP`, 'bad', 500);
    if (h.hp <= 0) this.die();
  }

  private wornGear(): string[] {
    return Object.values(this.hero.gear).filter((id): id is string => !!id);
  }

  private die(msg = 'Build failed. You were garbage collected.'): void {
    this.hero.hp = 0;
    this.flash(msg, 'bad', 2500);
    this.end('gameover');
  }

  private enemiesAct(): void {
    for (const e of this.map.enemies) {
      if (this.mode.kind !== 'explore' || this.isOver()) return;
      if (e.dazed > 0) { e.dazed--; continue; }
      const dx = this.player.x - e.x;
      const dy = this.player.y - e.y;
      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan === 1) {
        this.startFight(e.group, e, true);
        return;
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
      if (step) {
        e.x += step.x;
        e.y += step.y;
        // Closing the gap is the ambush: the fight starts right away.
        if (Math.abs(this.player.x - e.x) + Math.abs(this.player.y - e.y) === 1) {
          this.startFight(e.group, e, true);
          return;
        }
      }
    }
  }

  private canEnemyStep(e: MapEnemy, d: Pos): boolean {
    const n = { x: e.x + d.x, y: e.y + d.y };
    if (!this.walkable(n)) return false;
    if (n.x === this.player.x && n.y === this.player.y) return false;
    if (n.x === this.map.exit.x && n.y === this.map.exit.y) return false;
    return !this.enemyAt(n);
  }

  private randomEncounter(): void {
    const chance = this.effects.chaos ? 0.05 : 0.015;
    if (!this.rng.chance(chance) || this.map.enemies.length >= 8) return;
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
    const group = rollGroup(this.rng, this.floor);
    this.map.enemies.push({ ...p, group, dazed: 0 });
    this.say(this.effects.chaos ? 'Merge conflict! Something spawned nearby.' : `A wild ${ENEMIES[group[0]].name} appears!`);
  }

  /* -------------------------------------------------------- combat */

  private startFight(group: string[], foe: MapEnemy | null, ambush: boolean): void {
    this.fightsThisFloor++;
    const combat = new Combat(this.hero, group, this.rng.fork(`fight${this.fightCount++}`), {
      floor: this.floor,
      level: this.level,
      ambush,
      penaltyMult: this.effects.penaltyMult,
    });
    const fight: Fight = { combat, foe, target: 0, menu: 'main', inspect: false, notice: null, rewards: null };
    this.mode = { kind: 'combat', fight };
    if (combat.outcome !== 'ongoing') this.resolveFight(fight);
  }

  /** Bookkeeping when a fight ends (the result screen waits for Enter). */
  private resolveFight(f: Fight): void {
    const c = f.combat;
    this.damageTaken += c.damageTaken;
    if (c.outcome === 'defeat') return;
    if (c.outcome === 'fled') {
      const lost = Math.floor(this.hero.gold * 0.1);
      this.hero.gold -= lost;
      if (f.foe) f.foe.dazed = 4;
      f.rewards = { xp: 0, gold: -lost, drops: [] };
      return;
    }
    // Victory
    this.run.combatWins++;
    if (c.damageTaken === 0) this.run.flawless++;
    if (c.itemKill) this.run.itemKills++;
    const dead = c.enemies.filter((e) => e.hp <= 0 && !e.summoned);
    this.kills += dead.length;
    if (dead.some((e) => e.def.rank === 'elite')) this.run.elites++;
    const boss = dead.some((e) => e.def.rank === 'boss');
    if (f.foe) this.map.enemies = this.map.enemies.filter((e) => e !== f.foe);
    const { xp, gold } = c.rewards();
    this.hero.gold += gold;
    this.addScore(xp * 10 + gold);
    const drops: string[] = [];
    if (!boss) {
      const elite = dead.some((e) => e.def.rank === 'elite');
      if (elite || this.lootRng.chance(0.15)) {
        const g = rollGear(this.lootRng, this.floor, { elite, exclude: this.wornGear() });
        drops.push(g.name);
        this.queue.push({ kind: 'loot', gear: g.id });
      }
      if (this.lootRng.chance(0.35)) drops.push(this.give(rollConsumable(this.lootRng)));
    }
    const levels = gainXp(this.hero, xp);
    for (let i = 0; i < levels; i++) this.queue.push({ kind: 'levelup', options: upgradeChoices(this.hero, this.lootRng) });
    f.rewards = { xp, gold, drops };
    if (boss) {
      this.run.bosses++;
      const pts = this.addScore(1500 + this.hero.hp * 10);
      this.flash(`The Monolith falls! Shipped to production. +${pts}`, 'gold', 3000);
    }
  }

  /** Leave the fight's result screen. */
  private closeFight(f: Fight): void {
    const c = f.combat;
    if (c.outcome === 'defeat') return this.die();
    if (c.enemies.some((e) => e.def.rank === 'boss' && e.hp <= 0)) return this.end('win');
    this.mode = { kind: 'explore' };
    if (c.outcome === 'victory') this.say(`Won: +${f.rewards?.xp ?? 0} XP, +${f.rewards?.gold ?? 0} gold.`);
    else this.say(`You escaped, dropping ${-(f.rewards?.gold ?? 0)} gold.`);
    this.flushQueue();
  }

  /* -------------------------------------------------------- choices */

  private open(c: Choice): void {
    this.queue.unshift(c);
    this.flushQueue();
  }

  private flushQueue(): void {
    if (this.isOver() || this.mode.kind === 'combat') return;
    const next = this.queue.shift();
    this.mode = next ? { kind: 'choice', choice: next } : { kind: 'explore' };
  }

  private levelUps(n: number): void {
    for (let i = 0; i < n; i++) this.queue.push({ kind: 'levelup', options: upgradeChoices(this.hero, this.lootRng) });
    if (n > 0) this.flash(`Level up! Level ${this.hero.level}.`, 'gold', 1200);
  }

  /** Pick option n on the current choice screen. Public for tests. */
  choose(n: number): void {
    if (this.mode.kind !== 'choice') return;
    const c = this.mode.choice;
    const h = this.hero;
    let done = true;
    switch (c.kind) {
      case 'levelup': {
        const id = c.options[n - 1];
        if (!id) return;
        takeUpgrade(h, id);
        this.say(`${UPGRADES[id].name}: ${UPGRADES[id].describe}.`);
        break;
      }
      case 'loot': {
        if (n === 1) {
          const old = equip(h, c.gear);
          this.say(`Equipped ${GEAR[c.gear].name}${old ? ` (scrapped ${GEAR[old].name})` : ''}.`);
        } else if (n === 2) {
          const gold = { common: 3, uncommon: 8, rare: 15, epic: 25 }[GEAR[c.gear].rarity];
          h.gold += gold;
          this.say(`Scrapped ${GEAR[c.gear].name} for ${gold} gold.`);
        } else return;
        break;
      }
      case 'safe': {
        if (n === 1 && !this.safeUsed) {
          this.safeUsed = true;
          const s = heroStats(h);
          heal(h, 0.5);
          h.sta = s.maxSta;
          h.mp = s.maxMp;
          h.effects = [];
          this.say('You rest by the server rack. HP, STA and MP restored.');
        } else if (n >= 2 && n <= 4) {
          const id = (['potion', 'bomb', 'ether'] as const)[n - 2];
          const price = CONSUMABLES[id].price;
          if (h.gold < price) { this.flash(`Need ${price} gold.`, 'bad', 900); return; }
          if (!addToBag(h.bag, id)) { this.flash('Your bag is full.', 'bad', 900); return; }
          h.gold -= price;
          this.flash(`Bought a ${CONSUMABLES[id].name}.`, 'good', 900);
          done = false;
        } else if (n !== 0) return;
        break;
      }
      case 'event': {
        if (n !== 1 && n !== 2) return;
        this.resolveEvent(c.event, n);
        break;
      }
      case 'gate': {
        if (n === 1) { this.descend(); return; }
        if (n !== 2) return;
        this.say('You keep exploring. The gate stays open.');
        break;
      }
      case 'boss': {
        if (n === 1) {
          this.mode = { kind: 'explore' };
          this.startFight([this.map.boss!], null, false);
          return;
        }
        if (n !== 2) return;
        this.say('Not yet. The Monolith hums patiently.');
        break;
      }
    }
    if (done) this.flushQueue();
  }

  private resolveEvent(e: EventId, n: number): void {
    const h = this.hero;
    if (e === 'oracle') {
      if (n === 1) { this.levelUps(gainXp(h, 15)); this.say('The Oracle explains closures. +15 XP'); }
      else this.say(`An accepted answer soothes you. +${heal(h, 0.3)} HP`);
    } else if (e === 'npm') {
      if (n === 2) { this.say('You walk away from the suspicious package.'); return; }
      if (this.lootRng.chance(0.5)) {
        const g = rollGear(this.lootRng, this.floor + 1, { exclude: this.wornGear() });
        this.say(`It installs cleanly: ${g.name}!`);
        this.queue.unshift({ kind: 'loot', gear: g.id });
      } else {
        applyEffect(h, 'poison', { turns: 3, potency: 2 });
        this.hurt(Math.ceil(5 * this.effects.penaltyMult), 'Postinstall script! Malware.');
      }
    } else if (n === 1) {
      const gold = 15 + this.floor * 5;
      h.gold += gold;
      this.say(`You mine the idle CI runner: +${gold} gold.`);
    } else this.say(`You salvage ${this.give('bomb')}.`);
  }

  private descend(): void {
    if (this.fightsThisFloor === 0) this.run.pacifist++;
    this.floor++;
    this.fightsThisFloor = 0;
    this.safeUsed = false;
    this.queue = this.queue.filter((q) => q.kind === 'levelup' || q.kind === 'loot');
    this.map = generateDungeon(this.rng.fork(`map${this.floor}`), this.level, this.floor);
    this.player = { ...this.map.start };
    this.packages = 0;
    this.packagesNeeded = this.countPackages();
    this.seen.clear();
    const pts = this.addScore(200 * (this.floor - 1));
    refreshHero(this.hero);
    this.mode = { kind: 'explore' };
    this.reveal();
    if (this.map.boss) this.flash(`Floor ${this.floor}: the Legacy Monolith guards the gate. +${pts}`, 'gold', 2500);
    else this.flash(`Floor ${this.floor}. Deeper and nastier. +${pts}`, 'gold', 1800);
    this.say(this.map.boss ? 'The final gate (M) awaits. Prepare yourself.' : `Get ${this.packagesNeeded} deps (&), then take the > gate.`);
    this.flushQueue();
  }

  /* -------------------------------------------------------- render */

  render(): string[] {
    switch (this.mode.kind) {
      case 'class': return view.renderClassSelect(this.mode.sel);
      case 'combat': return view.renderCombat(this.mode.fight, this.hero, this.floor);
      case 'choice': return view.renderChoice(this.mode.choice, this, this.safeUsed);
      case 'bag': return view.renderBag(this.hero);
      case 'explore': return view.renderExplore(this, this.seen, (p) => this.visible(p), this.log);
    }
  }

  hud(): HudItem[] {
    const h = this.hero;
    if (this.mode.kind === 'class') return [{ label: 'PICK', value: 'a class' }];
    return [
      { label: 'HP', value: `${h.hp}/${h.maxHp}`, tone: h.hp <= h.maxHp * 0.3 ? 'bad' : 'good' },
      { label: 'LV', value: String(h.level), tone: 'info' },
      { label: 'FLOOR', value: `${this.floor}/${FLOORS}`, tone: 'gold' },
      { label: 'DEPS', value: this.map.boss ? 'boss' : `${this.packages}/${this.packagesNeeded}`, tone: this.packages === this.packagesNeeded ? 'gold' : 'info' },
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
      floor: this.floor,
      level: this.hero.level,
      combatWins: this.run.combatWins,
      flawlessWins: this.run.flawless,
      itemKills: this.run.itemKills,
      elites: this.run.elites,
      bosses: this.run.bosses,
      pacifistFloors: this.run.pacifist,
    };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Outcome', this.endReason === 'win' ? 'Shipped! Monolith defeated' : this.endReason === 'gameover' ? 'Garbage collected' : 'Still in the dungeon'],
      ['Class', `${CLASSES[this.hero.cls].name} (level ${this.hero.level})`],
      ['Floor reached', `${this.floor}/${FLOORS}`],
      ['Fights won', String(this.run.combatWins)],
      ['Enemies defeated', String(this.kills)],
      ['Gold', String(this.hero.gold)],
      ['Turns', String(this.turns)],
    ];
  }

  protected isPerfect(): boolean {
    return this.endReason === 'win' && this.hero.hp >= this.hero.maxHp / 2;
  }
}

export const dungeonDef: GameDefinition = {
  id: 'dungeon',
  name: 'Dependency Dungeon',
  genre: 'Tactical roguelite',
  tagline: 'Pick a class, fight telegraphed battles, loot, level up and topple the Legacy Monolith.',
  controls: [
    ['Arrows / WASD / HJKL', 'move; bump an enemy to fight'],
    ['Space or .', 'wait a turn'],
    ['I or Tab', 'bag and gear (use potions)'],
    ['1-8', 'combat actions (Inspect is free)'],
    ['Left / Right', 'switch target in combat'],
  ],
  weight: 2,
  xpScale: 20,
  create: (ctx) => new DependencyDungeon(ctx),
};
