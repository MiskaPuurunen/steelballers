import type { Settings } from '../storage/save.js';
import { INTERFACES, describeTerminal, type InterfaceMode } from '../core/interfaces.js';
import type { AgentSnapshot } from '../integrations/agent-status.js';
import type { Health } from '../integrations/agent-status.js';
import type { InstallReport } from '../integrations/claude-settings.js';
import { wrapText } from '../net/sanitize.js';
import { keyHint, padRight } from './layout.js';
import { c, theme } from './style.js';

/**
 * The main menu and its smaller screens: Multiplayer, Settings, Agent status
 * and Help. Pure functions of what they show, so the App only routes keys and
 * state; nothing here touches the terminal, the save file or the network.
 */

export interface MenuItem {
  key: string;
  label: string;
  hint: string;
}

/** The main menu. Hidden shortcuts that still work: T (timer setting), H, J, P (LAN). */
export const MENU_ITEMS: readonly MenuItem[] = [
  { key: '1', label: 'QUICK PLAY', hint: 'random game, random modifier' },
  { key: '2', label: 'GAMES', hint: 'pick a game' },
  { key: '3', label: 'DAILY CHALLENGE', hint: 'same seed for everyone today' },
  { key: '4', label: 'MULTIPLAYER', hint: 'host or join a LAN game, party mode' },
  { key: '5', label: 'CUSTOM GAMES', hint: 'play your own Lua games' },
  { key: '6', label: 'STATS & ACHIEVEMENTS', hint: 'your progress' },
  { key: '7', label: 'AGENT STATUS', hint: 'what your AI coding agent is doing' },
  { key: '8', label: 'SETTINGS', hint: 'interface, timer, theme, colours' },
  { key: '9', label: 'HELP & ABOUT', hint: 'controls and commands' },
  { key: 'Q', label: 'QUIT', hint: 'back to work' },
];

export const MULTIPLAYER_ITEMS: readonly MenuItem[] = [
  { key: 'H', label: 'HOST A LAN GAME', hint: 'Battleship, Racing, Prompt Panic, Doodle Protocol' },
  { key: 'J', label: 'JOIN A LAN GAME', hint: 'find a room on your network, or type an address' },
  { key: 'P', label: 'PARTY MODE', hint: 'host a random party game mix' },
];

/** A vertical list with the selection highlighted, as the main menu draws it. */
export function menuList(items: readonly MenuItem[], sel: number, label: (it: MenuItem) => string = (it) => it.label): string[] {
  return items.map((it, i) => {
    const text = `[${it.key}] ${label(it)}`;
    return i === sel ? theme.primary('> ') + c.inverse(c.bold(` ${text} `)) + ' ' + theme.muted(it.hint) : '   ' + text + ' ';
  });
}

export function multiplayerLines(sel: number): string[] {
  return [
    theme.title('MULTIPLAYER'),
    theme.muted('Play with people on the same network. No accounts, no internet.'),
    '',
    ...menuList(MULTIPLAYER_ITEMS, sel),
    '',
    theme.muted('Friends join from their own terminal: vibebreak join <host address>'),
    '',
    keyHint([['Up/Down', 'select'], ['Enter', 'go'], ['H J P', 'shortcut'], ['Esc', 'back']]),
  ];
}

/* --------------------------------------------------------------- settings */

export type SettingId = 'interface' | 'timing' | 'theme' | 'animations' | 'color';

export interface SettingRow {
  id: SettingId;
  label: string;
  value: string;
  help: string;
}

const INTERFACE_ORDER: InterfaceMode[] = INTERFACES.map((i) => i.id);
const COLOR_ORDER: Settings['color'][] = ['auto', 'always', 'never'];

export function settingRows(s: Settings, themeName: string): SettingRow[] {
  return [
    { id: 'interface', label: 'Interface', value: s.interface, help: `Where "vibebreak" opens: ${INTERFACES.find((i) => i.id === s.interface)!.summary}. Takes effect next launch; --interface overrides it.` },
    { id: 'timing', label: 'Timer', value: s.timing === 'untimed' ? 'off (untimed)' : 'on', help: 'Default for Quick Play, the games list and replays. T on the briefing flips one round. The daily is always timed.' },
    { id: 'theme', label: 'Theme', value: themeName, help: 'Press Enter to browse themes with a live preview.' },
    { id: 'animations', label: 'Animations', value: s.animations ? 'on' : 'off', help: 'Ambient particles (snow, bubbles...) on menu screens. Never on a game board.' },
    { id: 'color', label: 'Colour', value: s.color, help: 'auto follows your terminal and NO_COLOR. Takes effect next launch.' },
  ];
}

/**
 * Step a setting to its next (dir 1) or previous (-1) value, in place.
 * Returns false for settings that open their own screen (theme).
 */
export function stepSetting(s: Settings, id: SettingId, dir: 1 | -1): boolean {
  const step = <T>(order: readonly T[], cur: T): T => order[(order.indexOf(cur) + dir + order.length) % order.length];
  switch (id) {
    case 'interface': s.interface = step(INTERFACE_ORDER, s.interface); return true;
    case 'timing': s.timing = s.timing === 'timed' ? 'untimed' : 'timed'; return true;
    case 'animations': s.animations = !s.animations; return true;
    case 'color': s.color = step(COLOR_ORDER, s.color); return true;
    case 'theme': return false;
  }
}

export function settingsLines(rows: SettingRow[], sel: number, width: number, notice: string | null): string[] {
  const lines = [theme.title('SETTINGS'), theme.muted('Saved on this computer and shared by every way of running VibeBreak.'), ''];
  rows.forEach((r, i) => {
    const value = i === sel ? c.inverse(c.bold(` < ${r.value} > `)) : theme.primary(r.value);
    lines.push((i === sel ? theme.primary('> ') : '  ') + padRight(r.label, 13) + value);
  });
  lines.push('');
  for (const l of wrapText(rows[sel].help, Math.min(width, 72))) lines.push(theme.muted(l));
  lines.push(notice ? theme.gold(notice) : '');
  lines.push('');
  lines.push(keyHint([['Up/Down', 'select'], ['Left/Right', 'change'], ['Enter', 'change / open'], ['Esc', 'back']]));
  return lines;
}

/* ----------------------------------------------------------- agent status */

export interface AgentScreenData {
  /** The same snapshot the HUD line is drawn from, or null when not monitoring. */
  snap: AgentSnapshot | null;
  monitoring: boolean;
  /** The HUD's own one-line rendering, so both always agree. */
  statusLine: string;
  install: InstallReport | null;
  health: Health | null;
  now: number;
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

export function agentLines(d: AgentScreenData, width: number): string[] {
  const L: string[] = [theme.title('AGENT STATUS'), ''];
  const row = (k: string, v: string) => L.push(theme.muted(padRight(k, 13)) + v);
  if (!d.monitoring) {
    L.push(theme.muted('Not following an AI agent in this run.'));
  } else {
    const p = d.snap?.primary ?? null;
    L.push(d.statusLine || theme.muted('AI UNKNOWN  no agent activity seen yet'));
    L.push('');
    if (p) {
      row('Status', `${p.status}${p.certainty === 'inferred' ? theme.muted('  (inferred: no recent event, so not certain)') : theme.muted('  (reported by the agent)')}`);
      row('Session', [p.project, p.sessionId.slice(0, 8)].filter(Boolean).join(' · '));
      row('Last event', `${ago(d.now - p.lastEventAt)} ago`);
      if (p.detail) row('Detail', wrapText(p.detail, Math.max(20, width - 14))[0]);
      const others = d.snap!.others.filter((o) => o.status !== 'IDLE');
      if (others.length) row('Other agents', others.map((o) => `${o.project || o.sessionId.slice(0, 6)} ${o.status}`).join(', ').slice(0, Math.max(20, width - 14)));
    } else {
      row('Status', 'UNKNOWN' + theme.muted('  (no session reported anything recently)'));
    }
  }
  L.push('');
  if (d.install) {
    const installed = d.install.installed.length > 0;
    row('Claude Code', installed
      ? theme.good('connected') + theme.muted(` (${d.install.installed.length} hook events${d.install.launch ? ', auto-launch on' : ''})`)
      : theme.gold('not connected') + theme.muted('  run: vibebreak hook install'));
  }
  row('Receiving', d.health ? `last event ${ago(Math.max(0, d.now - d.health.lastHookAt))} ago` + theme.muted(` (${d.health.received} total)`) : theme.muted('no event received yet'));
  L.push('');
  for (const l of wrapText('VibeBreak only reads status events. It never answers prompts, approves tools or touches the agent. Full diagnostics: vibebreak doctor', Math.min(width, 72))) L.push(theme.muted(l));
  L.push('');
  L.push(keyHint([['R', 'refresh'], ['Esc', 'back']]));
  return L;
}

/* ------------------------------------------------------------------ help */

export interface HelpData {
  version: string;
  saveFile: string;
  env: NodeJS.ProcessEnv;
}

export function helpLines(d: HelpData, width: number): string[] {
  const w = Math.min(width, 76);
  const L: string[] = [theme.title('HELP & ABOUT') + theme.muted(`   VibeBreak ${d.version}: your AI is thinking. You're playing.`), ''];
  const row = (k: string, v: string) => {
    const [first, ...more] = wrapText(v, w - 14);
    L.push(theme.primary(padRight(k, 14)) + first);
    for (const m of more) L.push(' '.repeat(14) + m);
  };
  row('Menus', 'Up/Down and Enter, or press the [key]. Esc goes back. Ctrl+C quits from anywhere.');
  row('In a game', 'Esc pauses (resume, restart, end round). Most games: P pause, R restart, Q end. Each game shows its own controls first.');
  row('Shortcuts', 'T timer setting, H host, J join, P party mode (from the main menu).');
  row('Commands', 'vibebreak play --game <id> | daily | list | stats | host | join <ip> | doctor | --help');
  row('Interface', `Running in ${describeTerminal(d.env)}. Settings > Interface picks where "vibebreak" opens; --interface terminal|standalone|auto overrides it once.`);
  row('Save file', d.saveFile);
  row('Docs', 'README.md, docs/LAN.md, docs/CUSTOM_GAMES.md, docs/ARCHITECTURE.md');
  L.push('');
  L.push(keyHint([['Esc', 'back']]));
  return L;
}
