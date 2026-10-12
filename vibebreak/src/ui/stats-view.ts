import type { GameDefinition } from '../core/types.js';
import type { SaveData } from '../storage/save.js';
import { ACHIEVEMENTS, levelProgress } from '../core/progression.js';
import { todayUtc } from '../core/session.js';
import { bar, fmt, fmtDuration, padRight } from './layout.js';
import { c, theme } from './style.js';

/** Stats & achievements, shared by the in-app screen and `vibebreak stats`. */
export function statsLines(save: SaveData, games: readonly GameDefinition[], width = 80, compact = false): string[] {
  const lp = levelProgress(save.xp);
  const lines: string[] = [];
  lines.push(theme.title('STATS & ACHIEVEMENTS'));
  lines.push('');
  lines.push(
    theme.muted('LEVEL ') + c.bold(String(lp.level)) + '  ' + bar(lp.into / lp.needed, 20) + theme.muted(`  ${fmt(lp.into)}/${fmt(lp.needed)} XP`) +
      theme.muted(`   total ${fmt(save.xp)} XP`),
  );
  lines.push(theme.muted(`${fmt(save.rounds)} round${save.rounds === 1 ? '' : 's'} played · ${fmtDuration(save.playtimeMs)} total playtime`));
  lines.push('');
  lines.push(theme.muted(padRight('GAME', 22) + padRight('BEST', 10) + padRight('PLAYS', 7) + 'HIGHLIGHT'));
  for (const g of games) {
    const hs = save.highScores[g.id];
    const gs = save.gameStats[g.id];
    const highlight = gs ? gameHighlight(g.id, gs.bests, gs.totals) : theme.muted('not played yet');
    lines.push(
      padRight(theme.primary(g.name), 22) + padRight(hs ? c.bold(fmt(hs.score)) : theme.muted('-'), 10) + padRight(String(gs?.plays ?? 0), 7) + highlight,
    );
  }
  const today = save.daily[todayUtc()];
  lines.push('');
  lines.push(theme.muted('Daily challenge today: ') + (today ? c.bold(fmt(today.best)) + theme.muted(` (${today.attempts} attempts)`) : theme.muted('not played yet')));
  lines.push('');
  const unlocked = ACHIEVEMENTS.filter((a) => save.achievements[a.id]).length;
  lines.push(theme.muted(`ACHIEVEMENTS ${unlocked}/${ACHIEVEMENTS.length}`));
  if (compact) {
    // Names only, wrapped to the width: fits a 24-row terminal.
    let line = '';
    let w = 0;
    for (const a of ACHIEVEMENTS) {
      const got = !!save.achievements[a.id];
      const plain = `[${got ? 'x' : ' '}] ${a.name}  `;
      if (w + plain.length > width - 4 && line) {
        lines.push(line);
        line = '';
        w = 0;
      }
      line += got ? theme.gold(`[x] `) + c.bold(a.name) + '  ' : theme.muted(plain);
      w += plain.length;
    }
    if (line) lines.push(line);
    return lines;
  }
  const colW = width >= 90 ? 44 : 0;
  const items = ACHIEVEMENTS.map((a) => {
    const got = !!save.achievements[a.id];
    return got ? theme.gold('[x] ') + c.bold(a.name) + theme.muted(' - ' + a.description) : theme.muted('[ ] ' + a.name + ' - ' + a.description);
  });
  if (colW) {
    for (let i = 0; i < items.length; i += 2) lines.push(padRight(truncatePlain(items[i], colW - 1), colW) + (items[i + 1] ? truncatePlain(items[i + 1], colW - 1) : ''));
  } else {
    lines.push(...items);
  }
  return lines;
}

function truncatePlain(s: string, w: number): string {
  // Achievement descriptions are short; we only trim the visible tail if needed.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= w) return s;
  return s.startsWith('\x1b') || plain !== s ? stylePrefix(s, plain.slice(0, w - 1) + '~') : plain.slice(0, w - 1) + '~';
}

function stylePrefix(original: string, text: string): string {
  return original.includes('[x]') ? theme.gold(text) : theme.muted(text);
}

function gameHighlight(id: string, bests: Record<string, number>, totals: Record<string, number>): string {
  const b = (k: string) => fmt(bests[k] ?? 0);
  switch (id) {
    case 'bugbash': return theme.muted(`best combo ${b('maxCombo')}`);
    case 'snake': return theme.muted(`longest snake ${b('maxLength')}`);
    case 'codesprint': return theme.muted(`top speed ${b('wpm')} wpm`);
    case 'stack': return theme.muted(`tallest tower ${b('height')}`);
    case 'dungeon': return theme.muted(`escapes ${fmt(totals.escaped ?? 0)}`);
    default: return '';
  }
}
