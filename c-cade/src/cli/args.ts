/**
 * Tiny dependency-free argument parser. Pure, so it is fully unit-tested.
 */

import { isInterfaceMode, type InterfaceMode } from '../core/interfaces.js';

type Command = 'menu' | 'play' | 'daily' | 'list' | 'stats' | 'reset' | 'hook' | 'doctor' | 'theme' | 'host' | 'join' | 'rooms' | 'interfaces' | 'help' | 'version';

export interface ParsedArgs {
  command: Command;
  game?: string;
  /**
   * A timer flag from older versions (--duration, --timer, --timed, --mode sprint).
   * Rounds have no clock any more, so these are accepted and ignored with a notice.
   */
  legacyTimer: boolean;
  seed?: string;
  difficulty?: 'easy' | 'normal' | 'hard';
  modifier?: string;
  random: boolean;
  noColor: boolean;
  yes: boolean;
  json: boolean;
  /** hook: also open C-Cade in a new pane when the agent starts working. */
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
  /** --no-timer: LAN host turns off optional game timers. A no-op for arcade rounds, which never have a clock. */
  noTimer: boolean;
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
  /** Where the interactive arcade runs (--interface / --standalone). Undefined = saved preference. */
  interface?: InterfaceMode;
  /** Internal: this process was opened in its own window by the standalone launcher. */
  window: boolean;
  /** Positional args after the command (e.g. `hook install`). */
  rest: string[];
  error?: string;
}

const COMMANDS: Command[] = ['play', 'daily', 'list', 'stats', 'reset', 'hook', 'doctor', 'theme', 'host', 'join', 'rooms', 'interfaces', 'help', 'version'];

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: 'menu', random: false, noColor: false, yes: false, json: false, launch: false, fromHook: false, write: false,
    party: false, spectate: false, allowPublic: false, dedicated: false, bot: false, window: false, noTimer: false, legacyTimer: false, sets: {}, packs: [], rest: [],
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
        case '-d': case '--duration':
          // Consume the value so `--duration 30` doesn't read 30 as a command.
          takeValue(flag, inline);
          out.legacyTimer = true;
          break;
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
        case '--no-timer': case '--untimed': out.noTimer = true; break;
        case '--timer': case '--timed': out.legacyTimer = true; break;
        case '--mode': {
          // Endless is how every game plays now; any other mode asked for a clock.
          const v = takeValue(flag, inline)?.toLowerCase();
          if (v !== undefined && !['untimed', 'endless', 'endless-mountain', 'endless-highway'].includes(v)) out.legacyTimer = true;
          break;
        }
        case '-i': case '--interface': {
          const v = takeValue(flag, inline)?.toLowerCase();
          if (isInterfaceMode(v)) out.interface = v;
          else if (v !== undefined) out.error ??= `Invalid interface "${v}" (terminal, standalone or auto; see --list-interfaces)`;
          break;
        }
        case '--standalone': out.interface = 'standalone'; break;
        case '--list-interfaces': out.command = 'interfaces'; commandSet = true; break;
        case '--window': out.window = true; break;
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

  // Choosing a game (or a seed) implies play. Nothing else does: `c-cade --no-timer`
  // or `--duration 30` still opens the menu.
  if (out.command === 'menu' && (out.game || out.random || out.seed)) out.command = 'play';
  return out;
}

export const HELP = `C-Cade — your AI is thinking. You're playing.

Usage:
  c-cade                      Open the arcade menu (always the menu; nothing starts by itself)
  c-cade play                 Jump straight into a random minigame
  c-cade play --game snake    Play a specific game
  c-cade play --seed K7Q2-M9XA  Replay an exact session
  c-cade daily                Today's seeded challenge (same for everyone)
  c-cade list                 List the games
  c-cade stats                Scores, level and achievements
  c-cade theme [id]           List themes, or set one (also: [8] SETTINGS in the menu)
  c-cade reset [--yes]        Erase local stats
  c-cade hook install         Show how to connect Claude Code (optional)
  c-cade hook install --launch  ...and auto-open a game pane when Claude starts working
  c-cade hook install --launch --write  Do it for you (edits ~/.claude/settings.json, keeps a backup)
  c-cade doctor [--json]      Is the Claude Code integration installed, and receiving events?
  c-cade hook debug on|off    Log every status event to the agent folder (no prompt text)

Where it runs (also [8] SETTINGS > Interface in the menu, saved as your default):
  c-cade --interface terminal     In this terminal (VS Code's integrated terminal works)
  c-cade --interface standalone   In a new terminal window (alias: --standalone)
  c-cade --interface auto         This terminal (default); never opens a window by itself
  c-cade --list-interfaces        What each option does, and what was detected here

LAN multiplayer (same network, no internet or accounts needed):
  c-cade host                 Host a lobby (pick the game in the lobby)
  c-cade host --game battleship | prompt-panic | doodle-protocol | racing
  c-cade host --party         Party mix: a random game each match
  c-cade join 192.168.1.42    Join a host (also host:port, or --port 7777)
  c-cade join                 Browse rooms on your network, or type an address
  c-cade rooms [--json]       List C-Cade rooms on your network
  In the menu: [4] MULTIPLAYER (shortcuts H host, J join, P party).

Options:
  -g, --game <id>        blackjack | slots | snake | ski | dungeon | crossy | tetris |
                         racing | timetrial | highway
  -s, --seed <seed>      Reproduce a session (game, modifier, layout, sequence)
  -m, --modifier <id>    standard | overclocked | bug-bounty | low-battery |
                         double-xp | glass-cannon | chaos
      --difficulty <d>   easy | normal | hard
  -t, --theme <id>       classic | christmas | halloween | frutiger-aero | synthwave |
                         matrix | amber | seasonal (this run only; "c-cade theme" saves it)
  -r, --random           Random game (the default for play)
      --no-timer         With "host": turn off optional LAN game timers. Arcade rounds
                         never have a clock: they end when you lose (or win, or quit).
                         --duration, --timer and --mode from older versions are ignored
      --no-color         Disable colours (NO_COLOR is also respected)
  -i, --interface <m>    terminal | standalone | auto (overrides the saved setting)

LAN options:
  -p, --port <n>         Port to host on / connect to (default 7777; next free port is used)
      --bind <addr>      Host interface: lan (default: your LAN IP), local (this computer
                         only), all (every interface), or an IP address
      --local            Same as --bind local
  -n, --name <name>      Your display name (remembered)
      --max-players <n>  Player limit, 2-8 (spectators are extra)
      --set key=value    Game option, e.g. --set rounds=3 --set answerTime=45 (see "c-cade list")
      --pack <file.json> Custom Prompt Panic prompt pack (also auto-loaded from the
                         prompt-packs folder in your C-Cade config directory)
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
