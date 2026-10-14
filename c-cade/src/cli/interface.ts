import { spawn } from 'node:child_process';
import { arcadeRunning, cliEntry, planLaunch, type LaunchPlan } from '../integrations/launcher.js';
import { describeTerminal, type InterfaceMode } from '../core/interfaces.js';

/**
 * Where the interactive arcade runs. There is one application (the App in
 * src/ui/app.ts) and one terminal driver (NodeTerminal); an interface only
 * decides which terminal the process draws in:
 *
 *  - terminal:   right here, in the current terminal (VS Code's integrated
 *                terminal, Windows Terminal, iTerm, tmux...). The default.
 *  - standalone: in a new terminal window. This process opens the window,
 *                prints where it went and exits; the window runs the same
 *                CLI with `--interface terminal`, so it shares the save file,
 *                settings, LAN code and agent status with every other run.
 *  - auto:       the current terminal. Without one (a pipe, a script, CI)
 *                it does NOT open a window by itself: it explains how to
 *                ask for one. Only an explicit choice ever spawns a window.
 *
 * Recursion guard: the launched window always gets `--interface terminal`
 * on its command line. Environment variables are set too, but they are not
 * relied on (Windows Terminal starts new windows from its own process, so
 * they don't propagate).
 */

/** Set in the environment of a window we opened (informational; see the recursion guard above). */
export const CHILD_ENV = 'C_CADE_LAUNCHED';

interface InterfaceContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** stdin and stdout are both TTYs. */
  interactive: boolean;
}

type InterfaceChoice = { run: 'inline'; reason: string } | { run: 'window'; reason: string };

/** CLI flag beats the saved preference, which beats auto. */
export function chooseInterface(cli: InterfaceMode | undefined, saved: InterfaceMode | undefined, ctx: InterfaceContext): InterfaceChoice {
  const mode = cli ?? saved ?? 'auto';
  const source = cli ? '--interface' : saved ? 'saved setting' : 'default';
  if (ctx.env[CHILD_ENV] === '1') return { run: 'inline', reason: 'opened by the standalone launcher' };
  if (mode === 'terminal') return { run: 'inline', reason: `terminal (${source})` };
  if (mode === 'standalone') return { run: 'window', reason: `standalone (${source})` };
  return ctx.interactive
    ? { run: 'inline', reason: `auto: running in ${describeTerminal(ctx.env, ctx.platform)}` }
    : { run: 'inline', reason: 'auto: no interactive terminal here (use --standalone to open a window)' };
}

/**
 * The command a standalone window runs: this same CLI with the user's
 * arguments, minus any interface choice, plus `--interface terminal` and
 * `--window` (so the window waits on an error instead of vanishing).
 */
export function childCommand(argv: string[], node = process.execPath, entry = cliEntry()): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interface' || a === '-i') {
      i++; // skip its value
      continue;
    }
    if (a.startsWith('--interface=') || a === '--standalone' || a === '--window') continue;
    rest.push(a);
  }
  return [node, ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), entry, ...rest, '--interface', 'terminal', '--window'];
}

type StandaloneOutcome =
  | { ok: true; target: string }
  | { ok: false; why: 'already-running' | 'no-terminal' | 'failed'; message: string };

interface StandaloneDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Starts the plan; resolves once the terminal process started, rejects if it couldn't. Mocked in tests. */
  start?: (plan: LaunchPlan, env: NodeJS.ProcessEnv) => Promise<void>;
  running?: () => boolean;
}

/** Open the arcade in a new window. Never throws; never opens a second arcade. */
export async function openStandalone(argv: string[], deps: StandaloneDeps = {}): Promise<StandaloneOutcome> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if ((deps.running ?? arcadeRunning)()) {
    return { ok: false, why: 'already-running', message: 'C-Cade is already open in another window.' };
  }
  const plan = planLaunch(childCommand(argv), env, platform, 'window');
  if (!plan) {
    return {
      ok: false,
      why: 'no-terminal',
      message: platform === 'linux'
        ? 'No terminal emulator found (no desktop session, or set C_CADE_TERMINAL=<your terminal>).'
        : 'Opening a new terminal window is not supported here.',
    };
  }
  try {
    await (deps.start ?? startDetached)(plan, { ...env, [CHILD_ENV]: '1' });
    return { ok: true, target: plan.target };
  } catch (e) {
    return { ok: false, why: 'failed', message: `Couldn't open ${plan.target}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Spawn the terminal detached (it outlives us) and report whether it started. */
function startDetached(plan: LaunchPlan, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.cmd, plan.args, {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: plan.cmd === 'cmd.exe',
      windowsVerbatimArguments: plan.verbatim ?? false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
