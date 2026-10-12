/**
 * Tiny dependency-free argument parser. Pure, so it is fully unit-tested.
 */

export type Command = 'menu' | 'play' | 'daily' | 'list' | 'stats' | 'reset' | 'hook' | 'doctor' | 'theme' | 'help' | 'version';

export interface ParsedArgs {
  command: Command;
  game?: string;
  duration?: number;
  seed?: string;
  difficulty?: 'easy' | 'normal' | 'hard';
  modifier?: string;
  random: boolean;
  noColor: boolean;
  yes: boolean;
  json: boolean;
  /** hook: also open VibeBreak in a new pane when the agent starts working. */
  launch: boolean;
  /** play: started by the auto-launcher (shorter countdown). */
  fromHook: boolean;
  /** hook install/uninstall: edit ~/.claude/settings.json directly. */
  write: boolean;
  /** play: the agent session whose status the HUD should follow. */
  agentSession?: string;
  /** Theme for this run (not saved). */
  theme?: string;
  /** Positional args after the command (e.g. `hook install`). */
  rest: string[];
  error?: string;
}

const COMMANDS: Command[] = ['play', 'daily', 'list', 'stats', 'reset', 'hook', 'doctor', 'theme', 'help', 'version'];

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: 'menu', random: false, noColor: false, yes: false, json: false, launch: false, fromHook: false, write: false, rest: [] };
  const args = [...argv];
  let commandSet = false;

  const takeValue = (flag: string, inline: string | undefined): string | undefined => {
    if (inline !== undefined) return inline;
    const v = args.shift();
    if (v === undefined || v.startsWith('-')) {
      out.error ??= `Option ${flag} needs a value`;
      if (v !== undefined) args.unshift(v);
      return undefined;
    }
    return v;
  };

  while (args.length) {
    const raw = args.shift()!;
    if (raw.startsWith('-') && raw !== '-') {
      const eq = raw.indexOf('=');
      const flag = eq >= 0 ? raw.slice(0, eq) : raw;
      const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
      switch (flag) {
        case '-h': case '--help': out.command = 'help'; commandSet = true; break;
        case '-v': case '--version': out.command = 'version'; commandSet = true; break;
        case '-g': case '--game': out.game = takeValue(flag, inline); break;
        case '-s': case '--seed': out.seed = takeValue(flag, inline); break;
        case '-m': case '--modifier': out.modifier = takeValue(flag, inline); break;
        case '-r': case '--random': out.random = true; break;
        case '--no-color': case '--no-colour': out.noColor = true; break;
        case '-y': case '--yes': out.yes = true; break;
        case '--json': out.json = true; break;
        case '--launch': out.launch = true; break;
        case '--from-hook': out.fromHook = true; break;
        case '--write': out.write = true; break;
        case '--agent-session': out.agentSession = takeValue(flag, inline); break;
        case '-t': case '--theme': out.theme = takeValue(flag, inline); break;
        case '-d': case '--duration': {
          const v = takeValue(flag, inline);
          if (v !== undefined) {
            const n = Number(v.replace(/s$/, ''));
            if (!Number.isFinite(n) || n <= 0) out.error ??= `Invalid duration "${v}" (expected seconds, e.g. --duration 30)`;
            else out.duration = n;
          }
          break;
        }
        case '--difficulty': {
          const v = takeValue(flag, inline);
          if (v === 'easy' || v === 'normal' || v === 'hard') out.difficulty = v;
          else if (v !== undefined) out.error ??= `Invalid difficulty "${v}" (easy, normal, hard)`;
          break;
        }
        default:
          out.error ??= `Unknown option: ${flag}`;
      }
      continue;
    }
    if (!commandSet) {
      if ((COMMANDS as string[]).includes(raw)) {
        out.command = raw as Command;
        commandSet = true;
        continue;
      }
      out.error ??= `Unknown command: ${raw}`;
      commandSet = true;
      continue;
    }
    out.rest.push(raw);
  }

  // A specific game implies play.
  if (out.command === 'menu' && (out.game || out.random || out.seed || out.duration !== undefined)) out.command = 'play';
  return out;
}

export const HELP = `VibeBreak — your AI is thinking. You're playing.

Usage:
  vibebreak                      Open the arcade menu
  vibebreak play                 Jump straight into a random minigame
  vibebreak play --game snake    Play a specific game
  vibebreak play --duration 30   Set the round time limit in seconds (15-300)
  vibebreak play --seed K7Q2-M9XA  Replay an exact session
  vibebreak daily                Today's seeded challenge (same for everyone)
  vibebreak list                 List the games
  vibebreak stats                Scores, level and achievements
  vibebreak theme [id]           List themes, or set one (also: [5] THEMES in the menu)
  vibebreak reset [--yes]        Erase local stats
  vibebreak hook install         Show how to connect Claude Code (optional)
  vibebreak hook install --launch  ...and auto-open a game pane when Claude starts working
  vibebreak hook install --launch --write  Do it for you (edits ~/.claude/settings.json, keeps a backup)
  vibebreak doctor [--json]      Is the Claude Code integration installed, and receiving events?
  vibebreak hook debug on|off    Log every status event to the agent folder (no prompt text)

Options:
  -g, --game <id>        bugbash | snake | codesprint | stack | dungeon | crossy | tetris
  -d, --duration <sec>   Round time limit. A round may end sooner (e.g. game over);
                         the HUD warns you during the final 10 seconds.
  -s, --seed <seed>      Reproduce a session (game, modifier, layout, sequence)
  -m, --modifier <id>    standard | overclocked | bug-bounty | low-battery |
                         double-xp | glass-cannon | chaos
      --difficulty <d>   easy | normal | hard
  -t, --theme <id>       classic | christmas | halloween | frutiger-aero | synthwave |
                         matrix | amber | seasonal (this run only; "vibebreak theme" saves it)
  -r, --random           Random game (the default for play)
      --no-color         Disable colours (NO_COLOR is also respected)
  -h, --help             Show this help
  -v, --version          Show version

In game: Esc pauses (resume / restart / quit round). Ctrl+C exits instantly.
`;
