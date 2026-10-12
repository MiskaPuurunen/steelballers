import fs from 'node:fs';
import readline from 'node:readline';
import { HELP, parseArgs, type ParsedArgs } from './args.js';
import { GAMES, findGame } from '../games/index.js';
import { MODIFIERS } from '../core/modifiers.js';
import { SaveStore, configDir, savePath } from '../storage/save.js';
import { App, type StartMode } from '../ui/app.js';
import { NodeTerminal } from '../ui/terminal.js';
import { detectColor, setColor, theme, c, padRight } from '../ui/style.js';
import { statsLines } from '../ui/stats-view.js';
import { AgentWatcher, hookSnippet, readStatus, runHook, statusPath } from '../integrations/agent-status.js';

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
  if (args.command === 'hook' && args.rest.length === 0) {
    try {
      await runHook();
    } catch {
      /* never break the agent */
    }
    return 0;
  }

  if (args.error) {
    err(`vibebreak: ${args.error}`);
    err('Run "vibebreak --help" for usage.');
    return 2;
  }

  const store = new SaveStore();
  const loaded = store.load();
  const pref = loaded.data.settings.color;
  setColor(!args.noColor && pref !== 'never' && (pref === 'always' || detectColor(process.stdout, process.env)));

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
      return hookCommand(args.rest[0]);
    default:
      return play(args, store, loaded);
  }
}

function list(): number {
  out(theme.title('VIBEBREAK GAMES'));
  out();
  for (const g of GAMES) {
    out(padRight(theme.primary(c.bold(g.id)), 14) + padRight(g.name, 22) + theme.muted(`${g.genre}, ${g.defaultDurationSec}s`));
    out(' '.repeat(14) + theme.muted(g.tagline));
  }
  out();
  out(theme.muted('Modifiers: ' + MODIFIERS.map((m) => m.id).join(', ')));
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

function hookCommand(sub: string | undefined): number {
  if (sub === 'install' || sub === 'uninstall') {
    out(theme.title('Claude Code integration (optional)'));
    out();
    out('VibeBreak can show "AI working / AI done" in its HUD while you play in another');
    out('terminal. It uses Claude Code hooks that only write a tiny status file. They run');
    out('async, print nothing, always exit 0, and never touch prompts, tools or permissions.');
    out();
    if (sub === 'install') {
      out('Add this to ~/.claude/settings.json (merge with any existing "hooks" key),');
      out('or run /hooks inside Claude Code:');
      out();
      out(hookSnippet());
      out();
      out('Then play in a separate terminal: vibebreak');
    } else {
      out('Remove the four "vibebreak hook" entries from the "hooks" section of');
      out('~/.claude/settings.json (or via /hooks in Claude Code). Optionally delete:');
      out(statusPath());
    }
    return 0;
  }
  if (sub === 'status') {
    const st = readStatus();
    out(st ? `${st.agent}: ${st.state} (${st.event} at ${st.at})` : 'No recent agent activity.');
    return 0;
  }
  err(`vibebreak: unknown hook subcommand "${sub}" (install, uninstall, status)`);
  return 2;
}

async function play(args: ParsedArgs, store: SaveStore, loaded: ReturnType<SaveStore['load']>): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    err('vibebreak: the arcade needs an interactive terminal (TTY).');
    err('Try "vibebreak list" or "vibebreak stats" for non-interactive output.');
    return 1;
  }
  if (args.game && !findGame(args.game)) {
    err(`vibebreak: unknown game "${args.game}". Available: ${GAMES.map((g) => g.id).join(', ')}`);
    return 2;
  }
  if (args.modifier && !MODIFIERS.some((m) => m.id === args.modifier)) {
    err(`vibebreak: unknown modifier "${args.modifier}". Available: ${MODIFIERS.map((m) => m.id).join(', ')}`);
    return 2;
  }

  let start: StartMode;
  if (args.command === 'daily') start = { mode: 'daily' };
  else if (args.command === 'play') {
    start = {
      mode: 'play',
      session: {
        ...(args.game ? { gameId: findGame(args.game)!.id } : {}),
        ...(args.seed ? { seed: args.seed } : {}),
        ...(args.duration !== undefined ? { durationSec: args.duration } : {}),
        ...(args.difficulty ? { difficulty: args.difficulty } : {}),
        ...(args.modifier ? { modifierId: args.modifier } : {}),
      },
    };
  } else start = { mode: 'menu' };

  const io = new NodeTerminal();
  const app = new App({
    io,
    store,
    save: loaded.data,
    start,
    agent: new AgentWatcher(),
    ...(loaded.recoveredFrom ? { notice: `Save file was unreadable; started fresh (backup kept).` } : {}),
  });

  const onSignal = () => app.quit();
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);
  const crash = (e: unknown) => {
    io.stop();
    err(`vibebreak crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);

  const info = await app.run();
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  process.off('SIGINT', onSignal);
  process.off('uncaughtException', crash);
  for (const m of info.messages) out(m);
  return 0;
}

export { configDir, savePath };
