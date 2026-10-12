import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../storage/save.js';

/**
 * Opt-in auto-launch: when the agent starts working, open VibeBreak in a new
 * terminal pane or window next to it, unless one is already running.
 *
 * The launch is fire-and-forget: the child is spawned detached with no stdio
 * and unref'd, so the hook process exits immediately and the agent is never
 * blocked or touched.
 */

export interface LaunchPlan {
  cmd: string;
  args: string[];
  /** Human-readable target, e.g. "Windows Terminal split pane". */
  target: string;
  /** Windows only: pass args to cmd.exe untouched. */
  verbatim?: boolean;
}

/** Quote one argument for a POSIX shell string. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Path to this package's CLI entry (dist/cli/index.js or src/cli/index.ts). */
export function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, '..', 'cli', 'index.js');
  return fs.existsSync(js) ? js : path.join(here, '..', 'cli', 'index.ts');
}

/**
 * Decide how to open a new terminal running `command` (argv) on this
 * platform. Pure, so every branch is unit-tested. Returns null when no
 * suitable terminal can be found.
 */
export function planLaunch(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LaunchPlan | null {
  const shellLine = command.map(shq).join(' ');

  if (platform === 'win32') {
    if (env.WT_SESSION) {
      // Split the current Windows Terminal window, game on the right.
      return {
        cmd: 'wt.exe',
        args: ['-w', '0', 'split-pane', '-V', '--size', '0.45', '--title', 'VibeBreak', ...command],
        target: 'Windows Terminal split pane',
      };
    }
    const quoted = command.map((a) => `"${a}"`).join(' ');
    return {
      cmd: 'cmd.exe',
      args: ['/d', '/s', '/c', `start "VibeBreak" ${quoted}`],
      target: 'new console window',
      verbatim: true,
    };
  }

  if (env.TMUX) {
    return { cmd: 'tmux', args: ['split-window', '-h', '-l', '45%', shellLine], target: 'tmux split pane' };
  }

  if (platform === 'darwin') {
    const script = shellLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (env.TERM_PROGRAM === 'iTerm.app') {
      return {
        cmd: 'osascript',
        args: ['-e', `tell application "iTerm2" to tell current session of current window to split vertically with default profile command "${script}"`],
        target: 'iTerm2 split pane',
      };
    }
    return {
      cmd: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'],
      target: 'new Terminal.app window',
    };
  }

  // Linux / other Unix
  const term = env.VIBEBREAK_TERMINAL || env.TERMINAL;
  if (term) return { cmd: term, args: ['-e', ...command], target: `${term} window` };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    return { cmd: 'x-terminal-emulator', args: ['-e', ...command], target: 'new terminal window' };
  }
  return null;
}

/* ------------------------------------------------- running-arcade lock */

export function lockPath(dir = configDir()): string {
  return path.join(dir, 'arcade.lock');
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when an interactive VibeBreak is already open. */
export function arcadeRunning(file = lockPath()): boolean {
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
    return pidAlive(pid);
  } catch {
    return false;
  }
}

/** Mark this process as the running arcade. Returns a release function. */
export function acquireArcadeLock(file = lockPath()): () => void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } catch {
    return () => {};
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
      if (cur.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  return release;
}

/* ------------------------------------------------------------ launch */

export const DEFAULT_MIN_GAP_MS = 60_000;

export interface AutoLaunchOptions {
  durationSec?: number;
  /** Agent session that triggered the launch; the arcade follows it. */
  sessionId?: string;
  minGapMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dir?: string;
  now?: number;
  /** Injected for tests; defaults to a detached spawn. */
  run?: (plan: LaunchPlan) => void;
}

export type LaunchOutcome = 'launched' | 'already-running' | 'too-soon' | 'no-terminal' | 'failed';

export function autoLaunch(opts: AutoLaunchOptions = {}): LaunchOutcome {
  const dir = opts.dir ?? configDir();
  const now = opts.now ?? Date.now();
  if (arcadeRunning(lockPath(dir))) return 'already-running';

  const gapFile = path.join(dir, 'last-launch.json');
  try {
    const { at } = JSON.parse(fs.readFileSync(gapFile, 'utf8')) as { at: number };
    if (now - at < (opts.minGapMs ?? DEFAULT_MIN_GAP_MS)) return 'too-soon';
  } catch {
    /* no previous launch */
  }

  const command = [process.execPath, cliEntry(), 'play', '--from-hook'];
  if (opts.durationSec) command.push('--duration', String(opts.durationSec));
  if (opts.sessionId && /^[A-Za-z0-9_-]+$/.test(opts.sessionId)) command.push('--agent-session', opts.sessionId);
  const plan = planLaunch(command, opts.env ?? process.env, opts.platform ?? process.platform);
  if (!plan) return 'no-terminal';

  try {
    (opts.run ?? runDetached)(plan);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(gapFile, JSON.stringify({ at: now }));
    return 'launched';
  } catch {
    return 'failed';
  }
}

function runDetached(plan: LaunchPlan): void {
  const child = spawn(plan.cmd, plan.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: plan.cmd === 'cmd.exe',
    windowsVerbatimArguments: plan.verbatim ?? false,
  });
  child.on('error', () => {
    /* terminal not installed: stay silent, never break the agent */
  });
  child.unref();
}
