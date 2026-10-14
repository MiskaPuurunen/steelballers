import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, envSetting } from '../storage/save.js';



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
 * suitable terminal can be found (e.g. no graphical desktop).
 *
 * `pane` (the agent hook) prefers splitting the current terminal so the game
 * sits next to the agent; `window` (`--interface standalone`) always asks
 * for a separate window.
 */
export function planLaunch(
  command: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  kind: 'pane' | 'window' = 'pane',
): LaunchPlan | null {
  const shellLine = command.map(shq).join(' ');

  if (platform === 'win32') {
    if (env.WT_SESSION && kind === 'window') {
      return { cmd: 'wt.exe', args: ['-w', 'new', '--title', 'C-Cade', ...command], target: 'new Windows Terminal window' };
    }
    if (env.WT_SESSION) {
      // Split the current Windows Terminal window, game on the right.
      return {
        cmd: 'wt.exe',
        args: ['-w', '0', 'split-pane', '-V', '--size', '0.45', '--title', 'C-Cade', ...command],
        target: 'Windows Terminal split pane',
      };
    }
    const quoted = command.map((a) => `"${a}"`).join(' ');
    return {
      cmd: 'cmd.exe',
      args: ['/d', '/s', '/c', `start "C-Cade" ${quoted}`],
      target: 'new console window',
      verbatim: true,
    };
  }

  if (env.TMUX && kind === 'window') {
    return { cmd: 'tmux', args: ['new-window', '-n', 'C-Cade', shellLine], target: 'new tmux window' };
  }
  if (env.TMUX) {
    return { cmd: 'tmux', args: ['split-window', '-h', '-l', '45%', shellLine], target: 'tmux split pane' };
  }

  if (platform === 'darwin') {
    const script = shellLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (env.TERM_PROGRAM === 'iTerm.app' && kind === 'pane') {
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
  const term = envSetting(env, 'TERMINAL') || env.TERMINAL;
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

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when an interactive C-Cade is already open. */
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

const DEFAULT_MIN_GAP_MS = 60_000;

interface AutoLaunchOptions {
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

type LaunchOutcome = 'launched' | 'already-running' | 'too-soon' | 'no-terminal' | 'failed';

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

  // `--interface terminal`: this pane is the arcade (never relaunch from here).
  const command = [process.execPath, cliEntry(), '--interface', 'terminal', '--from-hook'];
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
