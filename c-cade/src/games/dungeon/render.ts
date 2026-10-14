import { c, padRight, theme, tone, truncate, visibleWidth } from '../../ui/style.js';
import { EFFECTS, type Combatant } from './effects.js';
import { DODGE_COST, CLASSES, CLASS_ORDER, UPGRADES, compareGear, heroStats, xpToNext, type Hero, type HeroStats } from './hero.js';
import { BAG_CAPACITY, CONSUMABLES, GEAR, RARITY_TAG, bagSummary, type GearDef, type Rarity } from './items.js';
import { ENEMIES } from './enemies.js';
import { FLOORS, MAP_H, MAP_W, type Dungeon, type MapEnemy, type Pos } from './map.js';
import type { Choice, Fight } from '../dungeon.js';

/**
 * ASCII views for Dependency Dungeon. Pure functions of game state: nothing
 * here changes the run. Everything stays readable without colour (effects
 * and rarities carry text tags, bars use # and -).
 */

export const WIDTH = 72;

const meter = (cur: number, max: number, w: number, paint: (s: string) => string) => {
  const f = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
  const n = Math.round(f * w);
  return theme.muted('[') + paint('#'.repeat(n)) + theme.muted('-'.repeat(w - n) + ']');
};
const hpPaint = (cur: number, max: number) => (cur <= max * 0.3 ? theme.bad : theme.good);

const rarityPaint = (r: Rarity): ((s: string) => string) =>
  r === 'epic' ? theme.accent : r === 'rare' ? theme.primary : r === 'uncommon' ? theme.good : c.white;

const gearLabel = (g: GearDef) => rarityPaint(g.rarity)(`[${RARITY_TAG[g.rarity]}] ${g.name}`);

function effectList(t: Combatant): string {
  return t.effects
    .map((e) => (EFFECTS[e.id].good ? theme.good : theme.bad)(`${EFFECTS[e.id].tag}${e.turns}`))
    .join(' ');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** Lay out columns side by side. */
function columns(blocks: string[][], widths: number[]): string[] {
  const h = Math.max(...blocks.map((b) => b.length));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(blocks.map((b, j) => padRight(truncate(b[i] ?? '', widths[j] - 1), widths[j])).join(''));
  return out;
}

/** Exactly `height` rows, none wider than the body. */
function fit(lines: string[], height: number): string[] {
  const out = lines.slice(0, height).map((l) => truncate(l, WIDTH));
  while (out.length < height) out.push('');
  return out;
}

const STAT_LABEL: Record<keyof HeroStats, string> = {
  maxHp: 'Max HP', maxSta: 'Max STA', maxMp: 'Max MP', atk: 'ATK', def: 'DEF', spd: 'SPD', crit: 'CRIT %', dodge: 'DODGE %', skillCost: 'Skill cost', heavyCost: 'Heavy cost',
};
/** Costs are better when lower. */
const LOWER_IS_BETTER = new Set<keyof HeroStats>(['skillCost', 'heavyCost']);

/* ---------------------------------------------------- class select */

export function renderClassSelect(sel: number): string[] {
  const blocks = CLASS_ORDER.map((id, i) => {
    const d = CLASSES[id];
    const b = d.base;
    const picked = i === sel;
    const name = `[${i + 1}] ${d.name}`;
    return [
      picked ? theme.primary(c.bold(`> ${name}`)) : `  ${c.bold(name)}`,
      theme.muted(`    ${d.role}`),
      ...d.sprite.map((s) => (picked ? theme.primary : c.white)(`     ${s}`)),
      `HP ${b.maxHp}  STA ${b.maxSta}  MP ${b.maxMp}`,
      `ATK ${b.atk} DEF ${b.def} SPD ${b.spd}`,
      theme.gold(`${d.skill.name}`),
      ...wrap(d.skill.describe, 22).map((l) => theme.muted(l)),
      theme.accent(d.passive.name),
      ...wrap(d.passive.describe, 22).map((l) => theme.muted(l)),
    ];
  });
  return fit([
    theme.title('DEPENDENCY DUNGEON') + theme.muted('  choose your class'),
    '',
    ...columns(blocks, [24, 24, 24]),
    '',
    theme.muted('1-3 or arrows + Enter to choose. Four floors; the Legacy Monolith waits on the last.'),
  ], 18);
}

/* ---------------------------------------------------------- explore */

interface ExploreView {
  map: Dungeon;
  player: Pos;
  hero: Hero;
  floor: number;
  packages: number;
  packagesNeeded: number;
}

/** Walls are only drawn where they border floor, so rock stays dark. */
function isEdgeWall(map: Dungeon, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < MAP_W && ny < MAP_H && map.tiles[ny][nx] === '.') return true;
    }
  }
  return false;
}

function enemyGlyph(e: MapEnemy): string {
  const d = ENEMIES[e.group[0]];
  const g = e.group.length > 1 ? d.glyph.toUpperCase() : d.glyph;
  if (e.dazed > 0) return c.dim(d.glyph);
  return d.rank === 'normal' ? c.bold(c.red(g)) : c.bold(theme.gold(g));
}

export function renderExplore(g: ExploreView, seen: Set<string>, visible: (p: Pos) => boolean, log: string[]): string[] {
  const { map, player } = g;
  const rows: string[] = [theme.muted('+' + '-'.repeat(MAP_W) + '+')];
  for (let y = 0; y < MAP_H; y++) {
    let row = '';
    for (let x = 0; x < MAP_W; x++) {
      const p = { x, y };
      if (!seen.has(`${x},${y}`)) { row += ' '; continue; }
      if (x === player.x && y === player.y) { row += theme.primary(c.bold('@')); continue; }
      const isExit = x === map.exit.x && y === map.exit.y;
      const vis = visible(p);
      if (!vis) {
        row += isExit ? c.dim(map.boss ? 'M' : '>') : map.tiles[y][x] === '#' ? (isEdgeWall(map, x, y) ? c.gray('#') : ' ') : ' ';
        continue;
      }
      const foe = map.enemies.find((e) => e.x === x && e.y === y);
      if (foe) { row += enemyGlyph(foe); continue; }
      const item = map.items.find((i) => i.x === x && i.y === y);
      if (item) {
        row += item.kind === 'package' ? theme.accent(c.bold('&'))
          : item.kind === 'coin' ? theme.gold('*')
          : item.kind === 'patch' ? theme.good('+')
          : item.kind === 'trap' ? c.yellow('^')
          : item.kind === 'chest' ? theme.gold(c.bold('$'))
          : item.kind === 'safe' ? theme.good(c.bold('S'))
          : theme.accent('?');
        continue;
      }
      if (isExit) {
        row += map.boss ? c.bold(theme.gold('M')) : g.packages >= g.packagesNeeded ? theme.gold(c.bold('>')) : c.white('>');
        continue;
      }
      row += map.tiles[y][x] === '#' ? (isEdgeWall(map, x, y) ? c.white('#') : ' ') : c.gray('.');
    }
    rows.push(theme.muted('|') + row + theme.muted('|'));
  }
  rows.push(theme.muted('+' + '-'.repeat(MAP_W) + '+'));

  const lines = columns([rows, heroPanel(g.hero, g.floor)], [MAP_W + 3, WIDTH - MAP_W - 3]);
  for (const m of log) lines.push(theme.muted('> ') + truncate(m, WIDTH - 2));
  while (lines.length < MAP_H + 4) lines.push('');
  lines.push(
    theme.accent('&') + theme.muted('dep ') + theme.gold('*') + theme.muted('gold ') + theme.good('+') + theme.muted('heal ') +
    c.yellow('^') + theme.muted('trap ') + theme.gold('$') + theme.muted('chest ') + theme.good('S') + theme.muted('safe ') +
    theme.accent('?') + theme.muted('event ') + c.red('a-z') + theme.muted(' foe ') + theme.gold('B') + theme.muted(' elite  [I] bag'),
  );
  return fit(lines, 18);
}

function heroPanel(h: Hero, floor: number): string[] {
  const s = heroStats(h);
  const cls = CLASSES[h.cls];
  const next = xpToNext(h.level);
  const gear = (['weapon', 'armor', 'accessory'] as const).map((slot) => {
    const id = h.gear[slot];
    return theme.muted({ weapon: 'Wpn ', armor: 'Arm ', accessory: 'Acc ' }[slot]) + (id ? gearLabel(GEAR[id]) : theme.muted('-'));
  });
  return [
    c.bold(theme.primary(cls.name)) + theme.muted(`  Lv ${h.level}  Floor ${floor}/${FLOORS}`),
    theme.muted('XP  ') + meter(h.xp, next, 10, theme.accent) + ` ${h.xp}/${next}`,
    theme.muted('HP  ') + meter(h.hp, h.maxHp, 10, hpPaint(h.hp, h.maxHp)) + ` ${h.hp}/${h.maxHp}`,
    theme.muted('STA ') + meter(h.sta, s.maxSta, 10, theme.gold) + ` ${h.sta}/${s.maxSta}`,
    s.maxMp > 0 ? theme.muted('MP  ') + meter(h.mp, s.maxMp, 10, theme.primary) + ` ${h.mp}/${s.maxMp}` : theme.muted('MP  -'),
    `ATK ${s.atk}  DEF ${s.def}  SPD ${s.spd}`,
    `CRIT ${s.crit}%  DODGE ${s.dodge}%`,
    theme.gold(`Gold ${h.gold}`) + theme.muted(`   Bag ${h.bag.length}/${BAG_CAPACITY}`),
    h.effects.length ? effectList(h) : '',
    ...gear,
  ];
}

/* ------------------------------------------------------------- bag */

export function bagEntries(h: Hero) {
  return bagSummary(h.bag);
}

export function renderBag(h: Hero): string[] {
  const s = heroStats(h);
  const lines = [theme.title('BAG & GEAR') + theme.muted(`   ${h.bag.length}/${BAG_CAPACITY} slots · ${h.gold} gold`), ''];
  const usable = bagEntries(h).filter((e) => CONSUMABLES[e.id].field);
  const entries = bagEntries(h);
  if (!entries.length) lines.push(theme.muted('  (empty)'));
  for (const e of entries) {
    const n = usable.findIndex((u) => u.id === e.id);
    const keyTag = n >= 0 ? theme.key(`[${n + 1}]`) : theme.muted('[-]');
    lines.push(`${keyTag} ${CONSUMABLES[e.id].name} x${e.count}  ` + theme.muted(CONSUMABLES[e.id].describe + (n < 0 ? ' (combat only)' : '')));
  }
  lines.push('');
  for (const slot of ['weapon', 'armor', 'accessory'] as const) {
    const id = h.gear[slot];
    const g = id ? GEAR[id] : undefined;
    lines.push(padRight(theme.muted(slot), 11) + (g ? gearLabel(g) + theme.muted(`  ${modsText(g)} · ${g.note}`) : theme.muted('-')));
  }
  lines.push('');
  lines.push(`HP ${h.hp}/${h.maxHp}  STA ${h.sta}/${s.maxSta}  MP ${h.mp}/${s.maxMp}  ATK ${s.atk}  DEF ${s.def}  SPD ${s.spd}  CRIT ${s.crit}%`);
  const ups = Object.entries(h.upgrades).map(([id, n]) => `${UPGRADES[id as keyof typeof UPGRADES].name} x${n}`);
  if (ups.length) lines.push(theme.muted('Upgrades: ' + ups.join(', ')));
  lines.push('');
  lines.push(theme.muted('Number: use item   I / Tab / 0: back to the map'));
  return fit(lines, 18);
}

function modsText(g: GearDef): string {
  const m = g.mods;
  const parts: string[] = [];
  const add = (v: number | undefined, label: string) => { if (v) parts.push(`${v > 0 ? '+' : ''}${v} ${label}`); };
  add(m.atk, 'ATK'); add(m.def, 'DEF'); add(m.spd, 'SPD'); add(m.crit, 'CRIT');
  add(m.maxHp, 'HP'); add(m.maxSta, 'STA'); add(m.maxMp, 'MP');
  if (m.skillCost) parts.push(`skill -${m.skillCost}`);
  if (m.heavyCost) parts.push(`heavy ${m.heavyCost > 0 ? '+' : ''}${m.heavyCost}`);
  return parts.join(', ');
}

/* ----------------------------------------------------------- combat */

export function renderCombat(f: Fight, h: Hero, floor: number): string[] {
  const cb = f.combat;
  const s = cb.stats;
  const cls = CLASSES[h.cls];
  const order = ['You', ...cb.living.map((e) => e.def.name.split(' ').pop()!)].join(theme.muted(' > '));
  const title = theme.title(`FLOOR ${floor}`) + theme.muted(cb.bossFight ? ' · BOSS BATTLE' : ' · BATTLE') + theme.muted(`   round ${cb.round}`);
  const header = padRight(title, 30) + theme.muted('  order: ') + order;

  const heroBlock = [
    c.bold(theme.primary(`${cls.name}`)) + theme.muted(` Lv${h.level}`),
    ...cls.sprite.map((l) => theme.primary(`  ${l}`)),
    theme.muted('HP  ') + meter(h.hp, h.maxHp, 8, hpPaint(h.hp, h.maxHp)) + ` ${h.hp}/${h.maxHp}`,
    theme.muted('STA ') + meter(h.sta, s.maxSta, 8, theme.gold) + ` ${h.sta}/${s.maxSta}`,
    s.maxMp > 0 ? theme.muted('MP  ') + meter(h.mp, s.maxMp, 8, theme.primary) + ` ${h.mp}/${s.maxMp}` : theme.muted(`ATK ${s.atk} DEF ${s.def} SPD ${s.spd}`),
    effectList(h) + (cb.evading ? theme.good(' DODGING') : ''),
  ];
  const n = Math.max(1, cb.enemies.length);
  const ew = Math.floor((WIDTH - 26) / n);
  const enemyBlocks = cb.enemies.map((e, i) => {
    if (e.hp <= 0) return ['', '', theme.muted(`  ${truncate(e.def.name, ew - 3)}`), theme.muted('  defeated'), ''];
    const sel = i === f.target && cb.outcome === 'ongoing';
    const paint = e.def.rank === 'normal' ? c.red : theme.gold;
    const it = cb.intentText(e);
    const intent = e.intent ? (e.charge > 0 || e.def.moves[e.intent].unblockable || (e.def.moves[e.intent].power ?? 0) >= 2 ? c.bold(theme.bad(it.text)) : theme.gold(it.text)) : theme.good('Stunned');
    return [
      (sel ? theme.primary(c.bold('> ')) : '  ') + c.bold(paint(truncate(e.def.name, ew - 3))),
      ...e.def.sprite.map((l) => paint(`  ${l}`)),
      theme.muted('HP ') + meter(e.hp, e.maxHp, Math.max(4, Math.min(10, ew - 12)), hpPaint(e.hp, e.maxHp)) + ` ${e.hp}`,
      effectList(e),
      theme.muted('Next: ') + intent,
      it.hint ? theme.muted(it.hint) : '',
    ];
  });
  const fighters = columns([heroBlock, ...enemyBlocks], [26, ...enemyBlocks.map(() => ew)]);

  let middle: string[];
  if (f.inspect && cb.enemies[f.target]?.hp > 0) {
    const e = cb.enemies[f.target];
    const it = cb.intentText(e);
    middle = [
      theme.title(e.def.name) + theme.muted(`  ${e.def.rank}`) + `  HP ${e.hp}/${e.maxHp}  ATK ${e.atk}  DEF ${e.defense}  SPD ${e.spd}`,
      theme.muted('Weak to: ') + (e.def.weak?.join(', ') ?? 'nothing') + theme.muted('   Resists: ') + (e.def.resist?.join(', ') ?? 'nothing') +
        (e.def.rank !== 'normal' ? theme.muted('   Stun: briefly, then Steady') : ''),
      theme.muted('Next: ') + it.text + (it.hint ? theme.muted(` - ${it.hint}`) : ''),
      theme.muted(truncate(e.def.blurb, WIDTH)),
    ];
  } else {
    middle = cb.log.slice(-4).map((l) => theme.muted('> ') + tone(l.tone)(truncate(l.text, WIDTH - 2)));
  }

  let actions: string[];
  if (cb.outcome !== 'ongoing') {
    const r = f.rewards;
    const head = cb.outcome === 'victory' ? theme.gold(c.bold('VICTORY!')) : cb.outcome === 'fled' ? theme.primary(c.bold('ESCAPED')) : theme.bad(c.bold('DEFEATED'));
    const detail = cb.outcome === 'victory' && r ? `  +${r.xp} XP  +${r.gold} gold${r.drops.length ? `  · ${r.drops.join(', ')}` : ''}` : cb.outcome === 'fled' && r ? `  dropped ${-r.gold} gold; it will be dazed for a few turns` : '';
    actions = [head + truncate(detail, WIDTH - 12), theme.key('[Enter]') + theme.muted(' continue')];
  } else if (f.menu === 'item') {
    const items = bagEntries(h).map((e, i) => theme.key(`[${i + 1}]`) + ` ${CONSUMABLES[e.id].name} x${e.count}`);
    actions = [items.join('  '), theme.key('[0]') + theme.muted(' back   ') + theme.muted(bagEntries(h).map((e) => `${CONSUMABLES[e.id].name}: ${CONSUMABLES[e.id].describe}`)[0] ?? '')];
  } else {
    const act = (k: number, label: string, ok: boolean) => (ok ? theme.key(`[${k}]`) + ' ' + label : theme.muted(`[${k}] ${label}`));
    const bl = (a: Parameters<typeof cb.blocked>[0]) => cb.blocked(a) === null;
    const t = f.target;
    const res = cls.skill.resource === 'mp' ? 'mp' : 'sta';
    const skill = h.skillCd > 0 ? `${cls.skill.name} cd${h.skillCd}` : `${cls.skill.name} ${s.skillCost}${res}`;
    actions = [
      [act(1, 'Attack', true), act(2, `Heavy ${s.heavyCost}sta`, bl({ type: 'heavy', target: t })), act(3, `Defend +2sta`, true), act(4, `Dodge ${DODGE_COST}sta ${s.dodge}%`, bl({ type: 'dodge' }))].join('  '),
      [act(5, skill, bl({ type: 'skill', target: t })), act(6, `Item (${h.bag.length})`, h.bag.length > 0), act(7, f.inspect ? 'Close info' : 'Inspect', true), act(8, cb.canFlee ? `Flee ${cb.fleeChance()}%` : 'Flee -', cb.canFlee)].join('  '),
    ];
  }
  const foot = f.notice ? theme.bad(f.notice) : cb.outcome === 'ongoing' && cb.living.length > 1 ? theme.muted('Left/Right: change target') : '';
  return fit([header, '', ...fit(fighters, 9), theme.muted('-'.repeat(WIDTH)), ...fit(middle, 4), ...actions, foot], 18);
}

/* ----------------------------------------------------------- choices */

interface ChoiceView { hero: Hero; floor: number }

export function renderChoice(ch: Choice, g: ChoiceView, safeUsed: boolean): string[] {
  const h = g.hero;
  const opt = (k: number | string, label: string, note = '') => theme.key(`[${k}]`) + ' ' + label + (note ? theme.muted(`  ${note}`) : '');
  let lines: string[];
  switch (ch.kind) {
    case 'levelup': {
      lines = [
        theme.gold(c.bold(`LEVEL UP!  You are now level ${h.level}.`)),
        theme.muted(`${CLASSES[h.cls].name} growth applied; HP partly restored, STA and MP refilled.`),
        '',
        'Choose an upgrade:',
        '',
        ...ch.options.map((id, i) => opt(i + 1, c.bold(UPGRADES[id].name), `${UPGRADES[id].describe}${h.upgrades[id] ? ` (have ${h.upgrades[id]})` : ''}`)),
      ];
      break;
    }
    case 'loot': {
      const gear = GEAR[ch.gear];
      const oldId = h.gear[gear.slot];
      const diffs = compareGear(h, ch.gear);
      lines = [
        theme.title('LOOT') + '  ' + gearLabel(gear) + theme.muted(`  ${gear.rarity} ${gear.slot}`),
        theme.muted(`"${gear.note}"  ${modsText(gear)}`),
        '',
        theme.muted('Replaces: ') + (oldId ? gearLabel(GEAR[oldId]) + theme.muted(`  ${modsText(GEAR[oldId])}`) : theme.muted('nothing (empty slot)')),
        '',
        ...(diffs.length ? diffs.map((d) => {
          const better = LOWER_IS_BETTER.has(d.stat) ? d.to < d.from : d.to > d.from;
          const delta = d.to - d.from;
          return padRight(`  ${STAT_LABEL[d.stat]}`, 14) + `${d.from} -> ${d.to}  ` + (better ? theme.good : theme.bad)(`(${delta > 0 ? '+' : ''}${delta}${better ? ' better' : ' worse'})`);
        }) : [theme.muted('  No stat change.')]),
        '',
        opt(1, 'Equip it'),
        opt(2, 'Scrap it for gold'),
      ];
      break;
    }
    case 'safe': {
      lines = [
        theme.good(c.bold('SAFE ROOM')) + theme.muted('  a humming server rack and a vending machine'),
        theme.muted(`HP ${h.hp}/${h.maxHp} · Gold ${h.gold} · Bag ${h.bag.length}/${BAG_CAPACITY}`),
        '',
        safeUsed ? theme.muted('[1] Rest (already rested on this floor)') : opt(1, 'Rest', 'restore 50% HP, all STA/MP, cure effects (once per floor)'),
        opt(2, `Buy ${CONSUMABLES.potion.name}`, `${CONSUMABLES.potion.price}g`),
        opt(3, `Buy ${CONSUMABLES.bomb.name}`, `${CONSUMABLES.bomb.price}g`),
        opt(4, `Buy ${CONSUMABLES.ether.name}`, `${CONSUMABLES.ether.price}g`),
        opt(0, 'Leave'),
      ];
      break;
    }
    case 'event': {
      const ev = {
        oracle: ['THE STACK OVERFLOW ORACLE', 'A glowing terminal offers wisdom or comfort.', ['Read the accepted answer (+15 XP)', 'Read the comments (heal 30%)']],
        npm: ['A SUSPICIOUS PACKAGE', '"left-pad-pro-max" has 3 downloads and no README.', ['npm install it (50%: rare gear, 50%: malware)', 'Walk away']],
        runner: ['AN ABANDONED CI RUNNER', 'Still powered on. Nobody is watching it.', [`Mine it for gold (+${15 + g.floor * 5})`, 'Salvage a Fork Bomb']],
      }[ch.event] as [string, string, string[]];
      lines = [theme.accent(c.bold(ev[0])), theme.muted(ev[1]), '', ...ev[2].map((t, i) => opt(i + 1, t))];
      break;
    }
    case 'gate': {
      lines = [
        theme.gold(c.bold(`THE GATE TO FLOOR ${g.floor + 1} IS OPEN`)),
        theme.muted(g.floor + 1 >= FLOORS ? 'Below: the Legacy Monolith itself.' : 'Deeper floors hit harder and drop better loot.'),
        '',
        opt(1, 'Descend'),
        opt(2, 'Keep exploring this floor', 'chests, the safe room and XP are still here'),
      ];
      break;
    }
    case 'boss': {
      const d = ENEMIES.monolith;
      lines = [
        theme.gold(c.bold('THE LEGACY MONOLITH')) + theme.muted('  final boss'),
        ...d.sprite.map((l) => theme.gold(`   ${l}`)),
        ...wrap(d.blurb, WIDTH).map((l) => theme.muted(l)),
        theme.muted('You cannot flee this fight. Stuns only hold it briefly.'),
        '',
        opt(1, 'Fight'),
        opt(2, 'Not yet', 'explore, shop and heal first'),
      ];
      break;
    }
  }
  return fit(['', ...lines], 18);
}
