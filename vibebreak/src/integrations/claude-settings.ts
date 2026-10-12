import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from './agent-status.js';

/**
 * Add or remove VibeBreak's hooks in Claude Code's user settings file
 * (~/.claude/settings.json). Only runs when the user explicitly asks
 * (`hook install --write` / `hook uninstall --write`). Other settings and
 * other hooks are preserved, and a backup is written first.
 */

export { HOOK_EVENTS };

interface Handler { type?: string; command?: string; [k: string]: unknown }
interface Group { matcher?: string; hooks?: Handler[]; [k: string]: unknown }
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

/** Recognises handlers this tool created (either install style). */
export function isVibeBreakHandler(h: Handler): boolean {
  const cmd = String(h.command ?? '');
  return /vibebreak hook/.test(cmd) || (/vibebreak/i.test(cmd) && /index\.js"?\s+hook\b/.test(cmd));
}

/** Remove every VibeBreak handler, dropping groups/events left empty. */
export function stripVibeBreak(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isVibeBreakHandler(h)) } : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

/** Merge VibeBreak's handlers in (replacing any previous VibeBreak ones). */
export function mergeVibeBreak(settings: Settings, command: string, launchCommand?: string): Settings {
  stripVibeBreak(settings);
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const cmd = event === 'UserPromptSubmit' && launchCommand ? launchCommand : command;
    (settings.hooks[event] ??= []).push({ hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] });
  }
  return settings;
}

export type WriteResult =
  | { ok: true; file: string; backup: string | null }
  | { ok: false; file: string; reason: string };

export function updateClaudeSettings(
  change: (s: Settings) => Settings,
  file = claudeSettingsPath(),
): WriteResult {
  let settings: Settings = {};
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, file, reason: 'the file is not a JSON object' };
      }
      settings = parsed as Settings;
    } catch {
      return { ok: false, file, reason: 'the file is not valid JSON, so it was left untouched' };
    }
    backup = `${file}.vibebreak-backup`;
    fs.copyFileSync(file, backup);
  }
  const next = change(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { ok: true, file, backup };
}

export interface InstallReport {
  file: string;
  exists: boolean;
  readable: boolean;
  /** Events that have a VibeBreak handler. */
  installed: string[];
  /** Recommended events with no VibeBreak handler (older install). */
  missing: string[];
  /** Whether UserPromptSubmit auto-launches a game. */
  launch: boolean;
  /** Script paths referenced by the handlers that don't exist on disk. */
  brokenPaths: string[];
}

/** Inspect (read-only) how VibeBreak is wired into Claude Code's settings. */
export function inspectInstall(file = claudeSettingsPath()): InstallReport {
  const rep: InstallReport = { file, exists: fs.existsSync(file), readable: false, installed: [], missing: [], launch: false, brokenPaths: [] };
  let settings: Settings = {};
  if (rep.exists) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Settings;
      rep.readable = true;
    } catch { /* reported as unreadable */ }
  }
  const paths = new Set<string>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const handlers = groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).filter(isVibeBreakHandler);
    if (!handlers.length) continue;
    rep.installed.push(event);
    for (const h of handlers) {
      const cmd = String(h.command ?? '');
      if (event === 'UserPromptSubmit' && /--launch\b/.test(cmd)) rep.launch = true;
      const script = /"([^"]+index\.js)"/.exec(cmd)?.[1];
      if (script) paths.add(script);
    }
  }
  rep.missing = HOOK_EVENTS.filter((e) => !rep.installed.includes(e));
  rep.brokenPaths = [...paths].filter((p) => !fs.existsSync(p));
  return rep;
}
