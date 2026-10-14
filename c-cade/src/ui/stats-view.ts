import type { GameDefinition } from '../core/types.js';
import type { SaveData } from '../storage/save.js';
import { ACHIEVEMENTS, levelProgress } from '../core/progression.js';
import { todayUtc } from '../core/session.js';
import { bar, fmt, fmtDuration } from './layout.js';
import { c, padRight, theme } from './style.js';

/** Stats & achievements, shared by the in-app screen and `c-cade stats`. */
export function statsLines(save: SaveData, games: readonly GameDefinition[], width = 80, compact = false): string[] {
  const lp = levelProgress(save.xp);
  const lines: string[] = [];
  lines.push(theme.title('STATS & ACHIEVEMENTS'));
  lines.push('');
  const level = theme.muted('LEVEL ') + c.bold(String(lp.level)) + '  ' + bar(lp.into / lp.needed, compact ? 12 : 20) + theme.muted(`  ${fmt(lp.into)}/${fmt(lp.needed)} XP`);
  const rounds = `${fmt(save.rounds)} round${save.rounds === 1 ? '' : 's'} played · ${fmtDuration(save.playtimeMs)}`;
  // Compact (24-row terminals): one line for both.
  if (compact) lines.push(level + theme.muted(`   ${rounds}`));
  else {
    lines.push(level + theme.muted(`   total ${fmt(save.xp)} XP`));
    lines.push(theme.muted(`${rounds} total playtime`));
  }
  lines.push('');
  if (compact) {
    // Short terminals: two games per row, best score and plays.
    const cell = (g: GameDefinition) => {
      const best = save.highScores[g.id];
      const name = g.name.replace(/^Racing: /, 'Race: ');
      return padRight(theme.primary(name.slice(0, 19)), 20) + padRight(best ? c.bold(fmt(best.score)) : theme.muted('-'), 8) + padRight(theme.muted(`x${save.gameStats[g.id]?.plays ?? 0}`), 7);
    };
    lines.push(theme.muted(padRight('GAME', 20) + padRight('BEST', 8) + padRight('PLAYS', 7) + '  ' + padRight('GAME', 20) + padRight('BEST', 8) + 'PLAYS'));
    for (let i = 0; i < games.length; i += 2) lines.push(cell(games[i]) + '  ' + (games[i + 1] ? cell(games[i + 1]) : ''));
  }
  if (!compact) lines.push(theme.muted(padRight('GAME', 20) + padRight('BEST', 9) + padRight('PLAYS', 7) + 'HIGHLIGHT'));
  for (const g of compact ? [] : games) {
    const hs = save.highScores[g.id];
    const gs = save.gameStats[g.id];
    const highlight = gs ? gameHighlight(g.id, gs.bests, gs.totals) : theme.muted('not played yet');
    lines.push(
      padRight(theme.primary(g.name), 20) + padRight(hs ? c.bold(fmt(hs.score)) : theme.muted('-'), 9) + padRight(String(gs?.plays ?? 0), 7) + highlight,
    );
  }
  const today = save.daily[todayUtc()];
  lines.push('');
  const daily = theme.muted('Daily challenge today: ') + (today ? c.bold(fmt(today.best)) + theme.muted(` (${today.attempts} attempts)`) : theme.muted('not played yet'));
  const lan = theme.muted('LAN matches: ') + (save.lan.matches
    ? c.bold(fmt(save.lan.matches)) + theme.muted(' played, ') + c.bold(fmt(save.lan.wins)) + theme.muted(' won')
    : theme.muted('none yet'));
  if (compact) lines.push(daily + theme.muted('   ') + lan);
  else {
    lines.push(daily);
    lines.push(lan + (save.lan.matches ? theme.muted('  (' + Object.entries(save.lan.games).map(([id, g]) => `${id} ${g.plays}`).join(', ') + ')') : theme.muted(' (c-cade host / c-cade join)')));
  }
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
    case 'snake': return theme.muted(`longest snake ${b('maxLength')}`);
    case 'ski': return theme.muted(`farthest ${b('distance')}m`);
    case 'dungeon': return theme.muted(`escapes ${fmt(totals.escaped ?? 0)}`);
    case 'tetris': return theme.muted(`most lines ${b('lines')}`);
    case 'crossy': return theme.muted(`farthest ${b('distance')} lanes`);
    case 'racing': return theme.muted(`${fmt(totals.wins ?? 0)} wins, ${fmt(totals.podiums ?? 0)} podiums`);
    case 'timetrial': return theme.muted(`${fmt(totals.runs ?? 0)} timed runs`);
    case 'highway': return theme.muted(`farthest ${b('distance')}m, ${b('overtakes')} passed`);
    default: return '';
  }
}
