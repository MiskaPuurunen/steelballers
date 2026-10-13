import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TimeRecord } from '../core/types.js';
import { isInterfaceMode, type InterfaceMode } from '../core/interfaces.js';

/**
 * Local, account-free persistence. One small JSON file in the user's config
 * directory. No telemetry, no network. Missing or corrupted files are
 * recovered gracefully (a corrupted file is kept as a backup, never lost).
 */

export const SAVE_VERSION = 1;
/** Ghost replays are capped so the save file stays small. */
export const MAX_GHOST = 2400;

export interface GameStats {
  plays: number;
  totals: Record<string, number>;
  bests: Record<string, number>;
}

export interface HistoryEntry {
  gameId: string;
  score: number;
  at: string;
  seed: string;
  modifierId: string;
  difficulty: string;
  daily?: string;
  /** Played without a gameplay deadline. */
  untimed?: boolean;
}

export interface DailyRecord {
  best: number;
  attempts: number;
  gameId: string;
  modifierId: string;
}

export interface Settings {
  color: 'auto' | 'always' | 'never';
  /** Theme id, or 'seasonal'. Unknown ids fall back to the classic look. */
  theme: string;
  /** Ambient menu particles (snow, bubbles...). */
  animations: boolean;
  /** Display name for LAN games (remembered between sessions). */
  lanName?: string;
  /** Default for Quick Play, the arcade and replays: timed rounds or no gameplay deadline. */
  timing: 'timed' | 'untimed';
  /** Where `vibebreak` opens: this terminal, a new window, or auto. `--interface` overrides it. */
  interface: InterfaceMode;
}

/** LAN multiplayer record (local only: results as reported by the host you played on). */
export interface LanStats {
  matches: number;
  wins: number;
  games: Record<string, GameStats>;
}

export interface SaveData {
  version: number;
  createdAt: string;
  rounds: number;
  playtimeMs: number;
  xp: number;
  highScores: Record<string, { score: number; at: string; seed: string }>;
  gameStats: Record<string, GameStats>;
  achievements: Record<string, string>;
  history: HistoryEntry[];
  lastGameId: string | null;
  daily: Record<string, DailyRecord>;
  /** Best scores for user-made Lua games, kept apart from the built-in ones. */
  customScores: Record<string, { score: number; at: string; seed: string }>;
  /** Personal bests from untimed rounds, kept apart so endless runs never replace timed bests. */
  untimedScores: Record<string, { score: number; at: string; seed: string }>;
  settings: Settings;
  lan: LanStats;
  /** Best times (lower is better), e.g. Time Trial per seed. */
  timeRecords: Record<string, TimeRecord>;
}

export function defaultSave(now = new Date()): SaveData {
  return {
    version: SAVE_VERSION,
    createdAt: now.toISOString(),
    rounds: 0,
    playtimeMs: 0,
    xp: 0,
    highScores: {},
    gameStats: {},
    achievements: {},
    history: [],
    lastGameId: null,
    daily: {},
    customScores: {},
    untimedScores: {},
    settings: { color: 'auto', theme: 'classic', animations: true, timing: 'timed', interface: 'auto' },
    lan: { matches: 0, wins: 0, games: {} },
    timeRecords: {},
  };
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.VIBEBREAK_HOME) return env.VIBEBREAK_HOME;
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'vibebreak');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'vibebreak');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'vibebreak');
}

export function savePath(dir = configDir()): string {
  return path.join(dir, 'save.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numRecord = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
};

/** Coerce arbitrary parsed JSON into a valid SaveData, dropping junk. */
export function normalizeSave(raw: unknown): SaveData {
  const d = defaultSave();
  if (!isObj(raw)) return d;
  const s: SaveData = {
    ...d,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : d.createdAt,
    rounds: num(raw.rounds),
    playtimeMs: num(raw.playtimeMs),
    xp: Math.max(0, num(raw.xp)),
    lastGameId: typeof raw.lastGameId === 'string' ? raw.lastGameId : null,
  };
  if (isObj(raw.highScores)) {
    for (const [k, v] of Object.entries(raw.highScores)) {
      if (isObj(v) && typeof v.score === 'number') {
        s.highScores[k] = { score: v.score, at: String(v.at ?? ''), seed: String(v.seed ?? '') };
      }
    }
  }
  if (isObj(raw.gameStats)) {
    for (const [k, v] of Object.entries(raw.gameStats)) {
      if (isObj(v)) s.gameStats[k] = { plays: num(v.plays), totals: numRecord(v.totals), bests: numRecord(v.bests) };
    }
  }
  if (isObj(raw.achievements)) {
    for (const [k, v] of Object.entries(raw.achievements)) if (typeof v === 'string') s.achievements[k] = v;
  }
  if (Array.isArray(raw.history)) {
    s.history = raw.history
      .filter((h): h is Record<string, unknown> => isObj(h) && typeof h.gameId === 'string' && typeof h.score === 'number')
      .map((h) => ({
        gameId: h.gameId as string,
        score: h.score as number,
        at: String(h.at ?? ''),
        seed: String(h.seed ?? ''),
        modifierId: String(h.modifierId ?? 'standard'),
        difficulty: String(h.difficulty ?? 'normal'),
        ...(typeof h.daily === 'string' ? { daily: h.daily } : {}),
        ...(h.untimed === true ? { untimed: true } : {}),
      }))
      .slice(-20);
  }
  if (isObj(raw.daily)) {
    for (const [k, v] of Object.entries(raw.daily)) {
      if (isObj(v) && typeof v.best === 'number') {
        s.daily[k] = { best: v.best, attempts: num(v.attempts), gameId: String(v.gameId ?? ''), modifierId: String(v.modifierId ?? '') };
      }
    }
  }
  if (isObj(raw.customScores)) {
    for (const [k, v] of Object.entries(raw.customScores).slice(0, 500)) {
      if (isObj(v) && typeof v.score === 'number' && Number.isFinite(v.score)) {
        s.customScores[k] = { score: v.score, at: String(v.at ?? ''), seed: String(v.seed ?? '') };
      }
    }
  }
  if (isObj(raw.settings) && ['auto', 'always', 'never'].includes(raw.settings.color as string)) {
    s.settings.color = raw.settings.color as Settings['color'];
  }
  if (isObj(raw.settings) && typeof raw.settings.theme === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.settings.theme)) {
    s.settings.theme = raw.settings.theme;
  }
  if (isObj(raw.settings) && typeof raw.settings.animations === 'boolean') s.settings.animations = raw.settings.animations;
  if (isObj(raw.settings) && typeof raw.settings.lanName === 'string' && raw.settings.lanName.length <= 64) s.settings.lanName = raw.settings.lanName;
  if (isObj(raw.settings) && (raw.settings.timing === 'timed' || raw.settings.timing === 'untimed')) s.settings.timing = raw.settings.timing;
  // Unknown values (a typo, a newer version) keep the default rather than failing.
  if (isObj(raw.settings) && isInterfaceMode(raw.settings.interface)) s.settings.interface = raw.settings.interface;
  if (isObj(raw.untimedScores)) {
    for (const [k, v] of Object.entries(raw.untimedScores).slice(0, 100)) {
      if (isObj(v) && typeof v.score === 'number' && Number.isFinite(v.score)) {
        s.untimedScores[k] = { score: v.score, at: String(v.at ?? ''), seed: String(v.seed ?? '') };
      }
    }
  }
  if (isObj(raw.timeRecords)) {
    for (const [k, v] of Object.entries(raw.timeRecords).slice(0, 200)) {
      if (k.length > 120 || !isObj(v) || typeof v.ms !== 'number' || !Number.isFinite(v.ms) || v.ms <= 0) continue;
      const splits = Array.isArray(v.splits) ? v.splits.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, 20) : [];
      const ghost = Array.isArray(v.ghost) ? v.ghost.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, MAX_GHOST) : undefined;
      s.timeRecords[k] = { ms: v.ms, at: String(v.at ?? ''), seed: String(v.seed ?? ''), splits, ...(ghost?.length ? { ghost } : {}) };
    }
  }
  if (isObj(raw.lan)) {
    s.lan = { matches: num(raw.lan.matches), wins: num(raw.lan.wins), games: {} };
    if (isObj(raw.lan.games)) {
      for (const [k, v] of Object.entries(raw.lan.games)) {
        if (isObj(v)) s.lan.games[k] = { plays: num(v.plays), totals: numRecord(v.totals), bests: numRecord(v.bests) };
      }
    }
  }
  return s;
}

export interface LoadResult {
  data: SaveData;
  /** Set when the file existed but could not be parsed. */
  recoveredFrom?: string;
}

export class SaveStore {
  constructor(readonly file: string = savePath()) {}

  load(): LoadResult {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { data: defaultSave() }; // missing file: fresh start
    }
    try {
      return { data: normalizeSave(JSON.parse(text)) };
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch {
        /* ignore: we still start fresh */
      }
      return { data: defaultSave(), recoveredFrom: backup };
    }
  }

  /** Atomic write (temp file + rename). Never throws; returns success. */
  save(data: SaveData): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  reset(): boolean {
    return this.save(defaultSave());
  }
}
