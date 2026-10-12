import { parseArgs } from './args.js';
import { runHook } from '../integrations/agent-status.js';

/**
 * `vibebreak hook`: the hot path, run by Claude Code on every lifecycle
 * event (async, in parallel). Kept separate from main.ts so it doesn't load
 * the games and UI. Silent, never throws, always exits 0.
 */
export async function hookMain(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const out = await runHook();
    // Opt-in: open a game next to the agent when it starts a new turn.
    if (args.launch && out.event?.name === 'UserPromptSubmit') {
      const { autoLaunch } = await import('../integrations/launcher.js');
      autoLaunch({ sessionId: out.event.sessionId, ...(args.duration ? { durationSec: args.duration } : {}) });
    }
  } catch {
    /* never break the agent */
  }
  return 0;
}
