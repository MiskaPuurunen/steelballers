import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from '../storage/save.js';
import { MAX_SOURCE_BYTES } from './lua-game.js';

/**
 * Custom games live as plain .lua files in <config dir>/games/, next to the
 * save file. Loading a file or pasting code stores a copy there, so the game
 * is still in the list next time. Players can also drop files in directly.
 */

export function gamesDir(dir = configDir()): string {
  return path.join(dir, 'games');
}

export interface GameFile {
  file: string;
  source: string;
}

/** Every *.lua file in the library (unreadable or oversized files are skipped). */
export function listGameFiles(dir: string): GameFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.lua')).sort();
  } catch {
    return [];
  }
  const out: GameFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).size > MAX_SOURCE_BYTES) continue;
      out.push({ file, source: fs.readFileSync(file, 'utf8') });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Turn what the user typed or dropped into the path field into a real path.
 * Handles surrounding quotes, PowerShell's `& 'C:\path'` form from drag and
 * drop, file:// URLs and a leading ~.
 */
export function normalizeInputPath(input: string, cwd = process.cwd(), home = os.homedir()): string {
  let p = input.trim();
  if (p.startsWith('& ')) p = p.slice(2).trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/x -> C:/x
    } catch {
      /* keep as typed */
    }
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  return path.resolve(cwd, p);
}

/** Read a script the user pointed at. Throws with a readable message. */
export function readScript(file: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`File not found: ${file}`);
  }
  if (stat.isDirectory()) throw new Error('That is a folder. Point to a .lua file.');
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`File is larger than ${MAX_SOURCE_BYTES / 1024} KB.`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\u0000')) throw new Error('That does not look like a text file.');
  return text.replace(/^\uFEFF/, '');
}

/** Store a validated script as <dir>/<id>.lua (atomic). Returns the file path. */
export function saveScript(dir: string, id: string, source: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.lua`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, source);
  fs.renameSync(tmp, file);
  return file;
}

export function deleteScript(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
