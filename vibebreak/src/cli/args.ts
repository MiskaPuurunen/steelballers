/**
 * Tiny dependency-free argument parser. Pure, so it is fully unit-tested.
 */

export type Command = 'menu' | 'play' | 'daily' | 'list' | 'stats' | 'reset' | 'hook' | 'doctor' | 'theme' | 'host' | 'join' | 'rooms' | 'help' | 'version';

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
  /** LAN: port to host on / connect to. */
  port?: number;
  /** LAN host: interface to bind (lan, local, all, or an address). */
  bind?: string;
  /** LAN: display name. */
  name?: string;
  /** LAN host: maximum players (2-8). */
  maxPlayers?: number;
  /** LAN host: random party mix. */
  party: boolean;
  /** LAN: join (or host) as a spectator. */
  spectate: boolean;
  /** LAN host: accept connections from non-private addresses. */
  allowPublic: boolean;
  /** LAN host: run a headless server with a text console (no TTY needed). */
  dedicated: boolean;
  /** LAN join: play automatically (for testing and demos). */
  bot: boolean;
  /** LAN host: game options, e.g. --set rounds=3. */
  sets: Record<string, string>;
  /** LAN host: custom prompt pack files. */
  packs: string[];
  /** Dedicated host: start automatically once N players are ready. */
  autoStart?: number;
  /** Dedicated host / bot: exit after N completed matches. */
  matches?: number;
  /** Positional args after the command (e.g. `hook install`). */
  rest: string[];
  error?: string;
}

const COMMANDS: Command[] = ['play', 'daily', 'list', 'stats', 'reset', 'hook', 'doctor', 'theme', 'host', 'join', 'rooms', 'help', 'version'];

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: 'menu', random: false, noColor: false, yes: false, json: false, launch: false, fromHook: false, write: false,
    party: false, spectate: false, allowPublic: false, dedicated: false, bot: false, sets: {}, packs: [], rest: [],
  };
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
        case '-p': case '--port': {
          const v = takeValue(flag, inline);
          if (v !== undefined) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 65535) out.error ??= `Invalid port "${v}" (1-65535)`;
            else out.port = n;
          }
          break;
        }
        case '--bind': out.bind = takeValue(flag, inline); break;
        case '--local': out.bind = 'local'; break;
        case '-n': case '--name': out.name = takeValue(flag, inline); break;
        case '--max-players': case '--max': {
          const v = takeValue(flag, inline);
          if (v !== undefined) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 2 || n > 8) out.error ??= `Invalid player limit "${v}" (2-8)`;
            else out.maxPlayers = n;
          }
          break;
        }
        case '--party': out.party = true; break;
        case '--spectate': out.spectate = true; break;
        case '--allow-public': out.allowPublic = true; break;
        case '--dedicated': out.dedicated = true; break;
        case '--bot': out.bot = true; break;
        case '--set': {
          const v = takeValue(flag, inline);
          if (v !== undefined) {
            const eq = v.indexOf('=');
            if (eq <= 0) out.error ??= `Invalid --set "${v}" (expected key=value, e.g. --set rounds=3)`;
            else out.sets[v.slice(0, eq)] = v.slice(eq + 1);
          }
          break;
        }
        case '--pack': {
          const v = takeValue(flag, inline);
          if (v !== undefined) out.packs.push(v);
          break;
        }
        case '--autostart': case '--matches': {
          const v = takeValue(flag, inline);
          if (v !== undefined) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 99) out.error ??= `Invalid ${flag} "${v}" (1-99)`;
            else if (flag === '--autostart') out.autoStart = n;
            else out.matches = n;
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

LAN multiplayer (same network, no internet or accounts needed):
  vibebreak host                 Host a lobby (pick the game in the lobby)
  vibebreak host --game battleship | prompt-panic | doodle-protocol
  vibebreak host --party         Party mix: a random game each match
  vibebreak join 192.168.1.42    Join a host (also host:port, or --port 7777)
  vibebreak join                 Browse rooms on your network, or type an address
  vibebreak rooms [--json]       List VibeBreak rooms on your network
  In the menu: [H] host, [J] join, [P] party mode.

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

LAN options:
  -p, --port <n>         Port to host on / connect to (default 7777; next free port is used)
      --bind <addr>      Host interface: lan (default: your LAN IP), local (this computer
                         only), all (every interface), or an IP address
      --local            Same as --bind local
  -n, --name <name>      Your display name (remembered)
      --max-players <n>  Player limit, 2-8 (spectators are extra)
      --set key=value    Game option, e.g. --set rounds=3 --set answerTime=45 (see "vibebreak list")
      --pack <file.json> Custom Prompt Panic prompt pack (also auto-loaded from the
                         prompt-packs folder in your VibeBreak config directory)
      --spectate         Watch instead of play
      --allow-public     Accept players from non-private addresses (not recommended)
      --dedicated        Headless host with a text console (start, kick, game, close...)
      --autostart <n>    Dedicated host: start when n players are ready
      --matches <n>      Dedicated host / --bot: exit after n matches
      --bot              Join as an automated player (testing and demos)
  -h, --help             Show this help
  -v, --version          Show version

In game: Esc pauses (resume / restart / quit round). Ctrl+C exits instantly.
`;
