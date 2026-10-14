import { parseArgs } from './args.js';
import { runHook } from '../integrations/agent-status.js';


export async function hookMain(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const out = await runHook();
    // Opt-in: open a game next to the agent when it starts a new turn.
    if (args.launch && out.event?.name === 'UserPromptSubmit') {
      const { autoLaunch } = await import('../integrations/launcher.js');
      autoLaunch({ sessionId: out.event.sessionId });
    }
  } catch {
    /* never break the agent */
  }
  return 0;
}
