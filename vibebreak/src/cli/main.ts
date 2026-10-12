import fs from 'node:fs';
import readline from 'node:readline';
import { HELP, parseArgs, type ParsedArgs } from './args.js';
import { GAMES, RETIRED_GAMES, findGame } from '../games/index.js';
import { MODIFIERS } from '../core/modifiers.js';
import { SaveStore, configDir, savePath } from '../storage/save.js';
import { App, type StartMode } from '../ui/app.js';
import { NodeTerminal } from '../ui/terminal.js';
import { detectColor, detectColorDepth, setColor, setColorDepth, theme, c, padRight } from '../ui/style.js';
import { THEMES, SEASONAL, applyTheme, isThemeId, resolveTheme, seasonalTheme, themedRule } from '../ui/themes.js';
import { statsLines } from '../ui/stats-view.js';
import { AgentMonitor, agentDir, debugLogPath, gcSessions, hookSnippet, setDebug } from '../integrations/agent-status.js';
import { acquireArcadeLock, cliEntry } from '../integrations/launcher.js';
import { hookMain } from './hook.js';
import { buildReport, reportLines } from './doctor.js';
import { mergeVibeBreak, stripVibeBreak, updateClaudeSettings } from '../integrations/claude-settings.js';
import path from 'node:path';
import { MP_GAMES, RANDOM_GAME, findMpGame, resolveMpGameId } from '../mp/registry.js';
import { resolveOptions, type CustomPrompt } from '../mp/types.js';
import { runBot, runDedicatedHost } from '../mp/headless.js';
import { scanRooms } from '../net/discovery.js';
import { DEFAULT_PORT } from '../net/protocol.js';
import { parseHostPort, resolveBind } from '../net/address.js';
import { cleanName } from '../net/sanitize.js';
import { loadPackDir, loadPackFile } from '../games/multiplayer/prompts.js';
import type { LanStart } from '../ui/lan/lan-screen.js';

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // The hook path must be fast, silent and never fail.
  if (args.command === 'hook' && args.rest.length === 0) return hookMain(argv);

  if (args.error) {
    err(`vibebreak: ${args.error}`);
    err('Run "vibebreak --help" for usage.');
    return 2;
  }

  const store = new SaveStore();
  const loaded = store.load();
  const pref = loaded.data.settings.color;
  setColor(!args.noColor && pref !== 'never' && (pref === 'always' || detectColor(process.stdout, process.env)));
  setColorDepth(detectColorDepth(process.stdout, process.env));
  if (args.theme !== undefined && !isThemeId(args.theme)) {
    err(`vibebreak: unknown theme "${args.theme}". Available: ${[...THEMES.map((t) => t.id), SEASONAL].join(', ')}`);
    return 2;
  }
  applyTheme(resolveTheme(args.theme ?? loaded.data.settings.theme));

  switch (args.command) {
    case 'help':
      out(HELP);
      return 0;
    case 'version':
      out(`vibebreak ${version()}`);
      return 0;
    case 'list':
      return list();
    case 'stats':
      if (args.json) out(JSON.stringify(loaded.data, null, 2));
      else {
        out(statsLines(loaded.data, GAMES, process.stdout.columns || 80).join('\n'));
        out(theme.muted(`\nSave file: ${store.file}`));
      }
      return 0;
    case 'reset':
      return reset(store, args);
    case 'hook':
      return hookCommand(args.rest[0], args.launch, args.write, args.rest[1]);
    case 'doctor':
      return doctor(args.json);
    case 'theme':
      return themeCommand(store, loaded.data, args.rest[0]);
    case 'rooms':
      return rooms(args);
    case 'host': {
      const lan = hostStart(args, loaded.data.settings.lanName);
      if (typeof lan === 'number') return lan;
      if (args.dedicated) {
        if (lan.mode !== 'host') return 2;
        return runDedicatedHost({
          bind: resolveBind(lan.bind),
          ...(lan.port ? { port: lan.port } : {}),
          ...(lan.gameId ? { gameId: lan.gameId } : {}),
          party: !!lan.party,
          ...(lan.maxPlayers ? { maxPlayers: lan.maxPlayers } : {}),
          ...(lan.options ? { options: lan.options } : {}),
          ...(lan.prompts ? { prompts: lan.prompts } : {}),
          allowPublic: !!lan.allowPublic,
          ...(args.autoStart ? { autoStart: args.autoStart } : {}),
          ...(args.matches ? { matches: args.matches } : {}),
          console: true,
        });
      }
      return play(args, store, loaded, lan);
    }
    case 'join': {
      let target: { host: string; port: number } | undefined;
      if (args.rest[0]) {
        const t = parseHostPort(args.rest[0], args.port ?? DEFAULT_PORT);
        if ('error' in t) {
          err(`vibebreak: ${t.error}`);
          return 2;
        }
        target = t;
      }
      if (args.bot) {
        if (!target) {
          err('vibebreak: --bot needs an address, e.g. vibebreak join 192.168.1.42 --bot');
          return 2;
        }
        return runBot({ ...target, name: cleanName(args.name, 'Bot'), spectate: args.spectate, ...(args.matches ? { matches: args.matches } : {}) });
      }
      const lan: LanStart = {
        mode: 'join',
        ...(target ? { host: target.host, port: target.port, immediate: true } : {}),
        ...(args.name ? { name: cleanName(args.name) } : {}),
        spectate: args.spectate,
      };
      return play(args, store, loaded, lan);
    }
    default:
      return play(args, store, loaded);
  }
}

function list(): number {
  out(theme.title('VIBEBREAK GAMES'));
  out();
  for (const g of GAMES) {
    out(padRight(theme.primary(c.bold(g.id)), 14) + padRight(g.name, 22) + theme.muted(`${g.genre}, ${g.defaultDurationSec}s${g.untimed ? ' or untimed' : ''}`) + (g.modeNames ? theme.muted(` (${g.modeNames.timed} / ${g.modeNames.untimed})`) : ''));
    out(' '.repeat(14) + theme.muted(g.tagline));
  }
  out();
  out(theme.title('LAN MULTIPLAYER') + theme.muted('  vibebreak host --game <id>  /  vibebreak join <address>'));
  out();
  for (const g of MP_GAMES) {
    out(padRight(theme.primary(c.bold(g.id)), 18) + padRight(g.name, 18) + theme.muted(`${g.kind}, ${g.playersLabel}`));
    out(' '.repeat(18) + theme.muted(g.tagline));
    out(' '.repeat(18) + theme.muted('options: ' + g.options.map((o) => `${o.key}=${o.values.join('|')}`).join('  ')));
  }
  out(padRight(theme.primary(c.bold('random')), 18) + padRight('Party Mix', 18) + theme.muted('a random game each match (vibebreak host --party)'));
  out();
  out(theme.muted('Modifiers: ' + MODIFIERS.map((m) => m.id).join(', ')));
  out(theme.muted('Themes: ' + [...THEMES.map((t) => t.id), SEASONAL].join(', ')));
  out(theme.muted('Play one: vibebreak play --game <id>'));
  return 0;
}

async function reset(store: SaveStore, args: ParsedArgs): Promise<number> {
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      err('vibebreak: refusing to reset without confirmation. Use --yes.');
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => rl.question('Erase all VibeBreak stats and achievements? Type "yes": ', res));
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      out('Nothing changed.');
      return 0;
    }
  }
  if (!store.reset()) {
    err(`vibebreak: could not write ${store.file}`);
    return 1;
  }
  out('Stats reset.');
  return 0;
}

function themeCommand(store: SaveStore, save: ReturnType<SaveStore['load']>['data'], id: string | undefined): number {
  if (id === undefined) {
    out(theme.title('THEMES') + theme.muted('  (vibebreak theme <id> to set; [5] in the menu previews them live)'));
    out();
    for (const t of THEMES) {
      const mark = save.settings.theme === t.id ? theme.gold('*') : ' ';
      out(`${mark} ${padRight(theme.primary(c.bold(t.id)), 16)}${padRight(t.name, 16)}${themedRule(12, 0, t)}  ${theme.muted(t.description)}`);
    }
    const mark = save.settings.theme === SEASONAL ? theme.gold('*') : ' ';
    out(`${mark} ${padRight(theme.primary(c.bold(SEASONAL)), 16)}${padRight('Seasonal', 16)}${theme.muted(`Christmas in December, Halloween from Oct 15, else Classic (today: ${seasonalTheme()})`)}`);
    return 0;
  }
  if (!isThemeId(id)) {
    err(`vibebreak: unknown theme "${id}". Run "vibebreak theme" to list them.`);
    return 2;
  }
  save.settings.theme = id;
  if (!store.save(save)) {
    err(`vibebreak: could not write ${store.file}`);
    return 1;
  }
  applyTheme(resolveTheme(id));
  out(theme.good(`Theme set: ${resolveTheme(id).name}${id === SEASONAL ? ' (seasonal)' : ''}`) + '  ' + themedRule(20));
  return 0;
}

function doctor(json: boolean): number {
  const report = buildReport();
  if (json) out(JSON.stringify(report, null, 2));
  else out(reportLines(report).join('\n'));
  return 0;
}

function hookCommand(sub: string | undefined, launch = false, write = false, arg?: string): number {
  const fwd = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const base = `${fwd(process.execPath)} ${fwd(cliEntry())} hook`;
  if (write && (sub === 'install' || sub === 'uninstall')) {
    const res = updateClaudeSettings((s) => (sub === 'install' ? mergeVibeBreak(s, base, launch ? `${base} --launch` : undefined) : stripVibeBreak(s)));
    if (!res.ok) {
      err(`vibebreak: could not update ${res.file}: ${res.reason}.`);
      err('Run the same command without --write to get the snippet and add it by hand.');
      return 1;
    }
    out(theme.good(sub === 'install' ? 'VibeBreak hooks added to Claude Code.' : 'VibeBreak hooks removed from Claude Code.'));
    out(theme.muted(`Settings: ${res.file}`));
    if (res.backup) out(theme.muted(`Backup:   ${res.backup}`));
    if (sub === 'install') {
      out(launch
        ? 'Restart Claude Code. Each prompt you send will open a VibeBreak game next to it.'
        : 'Restart Claude Code, then run vibebreak in a second terminal while Claude works.');
    } else out('Restart Claude Code to apply.');
    return 0;
  }
  if (sub === 'install' || sub === 'uninstall') {
    out(theme.title('Claude Code integration (optional)'));
    out();
    out('VibeBreak can show what Claude is doing (thinking, running a tool, waiting for you,');
    out('done) in its HUD while you play in another terminal. It uses Claude Code hooks that');
    out('only record event metadata in a small per-session file. They run async, print');
    out('nothing, always exit 0, and never touch prompts, tools or permissions.');
    out();
    if (sub === 'install') {
      out('Add this to ~/.claude/settings.json (merge with any existing "hooks" key),');
      out('or run /hooks inside Claude Code:');
      out();
      // Absolute paths with forward slashes work from cmd, PowerShell and bash alike.
      out(launch ? hookSnippet(base, `${base} --launch`) : hookSnippet(base));
      out();
      if (launch) {
        out('Every time you send Claude a prompt, VibeBreak opens next to it with a random');
        out('game (Windows Terminal split pane, tmux pane, iTerm2 split, or a new window).');
        out('It will not open a second copy, nor relaunch within 60s of the last launch.');
        out('Quit with Q at any time; the pane closes and you are back with Claude.');
      } else {
        out('Or let VibeBreak add it for you: vibebreak hook install --write  (add --launch for auto-open)');
      out('Then play in a separate terminal: vibebreak');
        out('Tip: "vibebreak hook install --launch" auto-opens a game when Claude starts working.');
      }
    } else {
      out('Remove the VibeBreak hook entries from the "hooks" section of');
      out('~/.claude/settings.json (or via /hooks in Claude Code), or run:');
      out('  vibebreak hook uninstall --write');
      out('Optionally delete the event folder:');
      out(agentDir());
    }
    return 0;
  }
  if (sub === 'status') {
    const mon = new AgentMonitor();
    mon.poll();
    const v = mon.snapshot().primary;
    out(v ? `${v.agent}: ${v.status} (${v.certainty}) - ${v.detail} [${v.project || '?'} ${v.sessionId.slice(0, 8)}]` : 'No recent agent activity.');
    out(theme.muted('Full diagnostics: vibebreak doctor'));
    return 0;
  }
  if (sub === 'debug') {
    if (arg !== 'on' && arg !== 'off') {
      err('vibebreak: usage: vibebreak hook debug on|off');
      return 2;
    }
    setDebug(arg === 'on');
    out(arg === 'on'
      ? `Status event logging on. Log: ${debugLogPath(agentDir())} (event names, tools and transitions only; capped at 256 KB).`
      : 'Status event logging off.');
    return 0;
  }
  err(`vibebreak: unknown hook subcommand "${sub}" (install, uninstall, status, debug)`);
  return 2;
}

/** Turn host flags into a LanStart (or an exit code on bad input). */
function hostStart(args: ParsedArgs, savedName: string | undefined): LanStart | number {
  let gameId: string | undefined;
  if (args.game) {
    gameId = resolveMpGameId(args.game);
    if (!gameId) {
      err(`vibebreak: unknown LAN game "${args.game}". Available: ${MP_GAMES.map((g) => g.id).join(', ')}, random`);
      return 2;
    }
  }
  const party = args.party || gameId === RANDOM_GAME;
  let options: Record<string, unknown> | undefined;
  if (Object.keys(args.sets).length) {
    const def = gameId && gameId !== RANDOM_GAME ? findMpGame(gameId) : undefined;
    if (!def) {
      err('vibebreak: --set needs a specific --game (options differ per game).');
      return 2;
    }
    options = {};
    for (const [k, raw] of Object.entries(args.sets)) {
      const spec = def.options.find((o) => o.key === k);
      const value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      if (!spec || !spec.values.some((v) => v === value)) {
        err(`vibebreak: invalid option ${k}=${raw} for ${def.name}. Valid: ${def.options.map((o) => `${o.key}=${o.values.join('|')}`).join('  ')}`);
        return 2;
      }
      options[k] = value;
    }
    options = resolveOptions(def, options);
  }
  if (args.timing === 'untimed') {
    // Only optional gameplay timers are switched off. Network heartbeats,
    // connection timeouts and reconnect windows are not gameplay and stay on.
    const def = gameId && gameId !== RANDOM_GAME ? findMpGame(gameId) : undefined;
    const optional = def ? def.options.filter((o) => o.unit === 's' && o.values.includes(0)) : [];
    if (def && optional.length) {
      options = resolveOptions(def, { ...(options ?? {}), ...Object.fromEntries(optional.map((o) => [o.key, 0])) });
      err(`vibebreak: --no-timer: ${optional.map((o) => o.label.toLowerCase()).join(' and ')} off.`);
    } else {
      err(`vibebreak: --no-timer: ${def ? `${def.name}'s` : "party games'"} timers are part of the game rules and stay on.` +
        ' (Network timeouts are never affected.)');
    }
  }
  const prompts: CustomPrompt[] = [];
  const dirPacks = loadPackDir(path.join(configDir(), 'prompt-packs'));
  const filePacks = args.packs.map((f) => loadPackFile(f));
  for (const p of [...dirPacks, ...filePacks]) {
    for (const e of p.errors) err(`vibebreak: prompt pack "${p.name}": ${e}`);
    if (p.warnings.length) err(`vibebreak: prompt pack "${p.name}": skipped ${p.warnings.length} (${p.warnings.slice(0, 3).join(' ')})`);
    prompts.push(...p.prompts);
  }
  if (filePacks.length && filePacks.every((p) => p.prompts.length === 0)) return 2;
  return {
    mode: 'host',
    immediate: true,
    ...(gameId && gameId !== RANDOM_GAME ? { gameId } : {}),
    party,
    ...(args.name || savedName ? { name: cleanName(args.name ?? savedName) } : {}),
    ...(args.port ? { port: args.port } : {}),
    ...(args.bind ? { bind: args.bind } : {}),
    ...(args.maxPlayers ? { maxPlayers: args.maxPlayers } : {}),
    allowPublic: args.allowPublic,
    ...(options ? { options } : {}),
    ...(prompts.length ? { prompts } : {}),
    spectate: args.spectate,
  };
}

async function rooms(args: ParsedArgs): Promise<number> {
  if (!args.json) out(theme.muted('Looking for VibeBreak rooms on your network...'));
  const found = await scanRooms({ timeoutMs: 1500, targets: ['127.0.0.1'] });
  if (args.json) {
    out(JSON.stringify(found, null, 2));
    return 0;
  }
  if (!found.length) {
    out('No rooms found.');
    out(theme.muted('Discovery uses UDP broadcast, which guest/office Wi-Fi and some firewalls block.'));
    out(theme.muted('Ask the host for the address on their lobby screen: vibebreak join <address>'));
    return 0;
  }
  out(theme.title('ROOMS ON YOUR NETWORK'));
  out();
  out(theme.muted(padRight('ROOM', 22) + padRight('HOST', 18) + padRight('GAME', 18) + padRight('PLAYERS', 9) + 'JOIN WITH'));
  for (const r of found) {
    const where = `${r.connectTo}${r.port !== DEFAULT_PORT ? ` --port ${r.port}` : ''}`;
    const status = r.protocol !== 1 ? theme.bad(' (different version)') : r.joinable ? '' : theme.muted(' (full)');
    out(padRight(c.bold(r.name), 22) + padRight(r.host, 18) + padRight(r.game, 18) + padRight(`${r.players}/${r.max}`, 9) + theme.primary(`vibebreak join ${where}`) + status);
  }
  return 0;
}

async function play(args: ParsedArgs, store: SaveStore, loaded: ReturnType<SaveStore['load']>, lan?: LanStart): Promise<number> {
  if (!lan && args.game && !findGame(args.game)) {
    const retired = RETIRED_GAMES[args.game.toLowerCase()];
    err(`vibebreak: ${retired ?? `unknown game "${args.game}".`} Available: ${GAMES.map((g) => g.id).join(', ')}`);
    return 2;
  }
  if (!lan && args.timing === 'untimed') {
    if (args.command === 'daily') {
      err('vibebreak: the daily challenge is always timed so everyone plays the same round. Drop --no-timer.');
      return 2;
    }
    const def = args.game ? findGame(args.game) : undefined;
    if (def && !def.untimed) {
      err(`vibebreak: ${def.name} has no untimed mode. Untimed games: ${GAMES.filter((g) => g.untimed).map((g) => g.id).join(', ')}`);
      return 2;
    }
  }
  if (!lan && args.modifier && !MODIFIERS.some((m) => m.id === args.modifier)) {
    err(`vibebreak: unknown modifier "${args.modifier}". Available: ${MODIFIERS.map((m) => m.id).join(', ')}`);
    return 2;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    err('vibebreak: the arcade needs an interactive terminal (TTY).');
    if (lan?.mode === 'host') err('For a headless server use: vibebreak host --dedicated');
    else if (lan?.mode === 'join') err('For an automated player use: vibebreak join <address> --bot');
    else err('Try "vibebreak list" or "vibebreak stats" for non-interactive output.');
    return 1;
  }
  let start: StartMode;
  if (lan) start = { mode: 'lan', lan };
  else if (args.command === 'daily') start = { mode: 'daily' };
  else if (args.command === 'play') {
    start = {
      mode: 'play',
      session: {
        ...(args.game ? { gameId: findGame(args.game)!.id } : {}),
        ...(args.seed ? { seed: args.seed } : {}),
        ...(args.duration !== undefined ? { durationSec: args.duration } : {}),
        ...(args.difficulty ? { difficulty: args.difficulty } : {}),
        ...(args.modifier ? { modifierId: args.modifier } : {}),
        ...(args.timing ? { untimed: args.timing === 'untimed' } : {}),
      },
    };
  } else start = { mode: 'menu' };

  gcSessions();
  const io = new NodeTerminal();
  const releaseLock = acquireArcadeLock();
  const app = new App({
    io,
    store,
    save: loaded.data,
    start,
    ...(args.fromHook ? { countdownMs: 2000 } : {}),
    ...(args.theme ? { themeOverride: args.theme } : {}),
    agent: new AgentMonitor(agentDir(), args.agentSession ? { preferredSession: args.agentSession } : {}),
    ...(loaded.recoveredFrom ? { notice: `Save file was unreadable; started fresh (backup kept).` } : {}),
  });

  const onSignal = () => app.quit();
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);
  const crash = (e: unknown) => {
    io.stop();
    releaseLock();
    err(`vibebreak crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);

  const info = await app.run();
  releaseLock();
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  process.off('SIGINT', onSignal);
  process.off('uncaughtException', crash);
  for (const m of info.messages) out(m);
  return 0;
}

export { configDir, savePath };
