import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local, account-free persistence. One small JSON file in the user's config
 * directory. No telemetry, no network. Missing or corrupted files are
 * recovered gracefully (a corrupted file is kept as a backup, never lost).
 */

export const SAVE_VERSION = 1;

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
}

export interface DailyRecord {
  best: number;
  attempts: number;
  gameId: string;
  modifierId: string;
}

export interface Settings {
  color: 'auto' | 'always' | 'never';
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
  settings: Settings;
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
    settings: { color: 'auto' },
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
  if (isObj(raw.settings) && ['auto', 'always', 'never'].includes(raw.settings.color as string)) {
    s.settings.color = raw.settings.color as Settings['color'];
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
