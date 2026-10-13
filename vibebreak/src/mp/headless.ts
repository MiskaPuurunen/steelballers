import readline from 'node:readline';
import { LanServer } from '../net/server.js';
import { LanClient } from '../net/client.js';
import { DEFAULT_PORT, type HostCommand, type LobbyState } from '../net/protocol.js';
import { lanInterfaces } from '../net/address.js';
import { MP_GAMES, RANDOM_GAME, findMpGame } from './registry.js';
import { Bot } from './bot.js';
import type { CustomPrompt } from './types.js';

/**
 * Terminal-free LAN modes: a dedicated host with a line-based console, and
 * an automated bot player. Both print plain log lines (and machine-readable
 * "RESULT {...}" lines) so they work in scripts, CI and over SSH.
 */

type Out = (line: string) => void;

const stamp = () => new Date().toTimeString().slice(0, 8);

export interface DedicatedOptions {
  bind: string;
  port?: number;
  gameId?: string;
  party?: boolean;
  maxPlayers?: number;
  options?: Record<string, unknown>;
  prompts?: CustomPrompt[];
  allowPublic?: boolean;
  autoStart?: number;
  matches?: number;
  /** Read console commands from stdin. */
  console?: boolean;
  out?: Out;
}

export const CONSOLE_HELP = [
  'Commands:',
  '  status                 players, game and phase',
  '  start [force]          start the match (force = even if not everyone is ready)',
  '  game <id>              battleship | prompt-panic | doodle-protocol | racing | random',
  '  set <key> <value>      change a game option (see "vibebreak list")',
  '  max <n>                player limit',
  '  kick <name>            remove a player',
  '  end | lobby | rematch | next',
  '  close                  close the lobby and exit',
].join('\n');

export async function runDedicatedHost(o: DedicatedOptions): Promise<number> {
  const out: Out = o.out ?? ((l) => process.stdout.write(l + '\n'));
  const log = (l: string) => out(`[${stamp()}] ${l}`);
  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((r) => { closedResolve = r; });
  const server = new LanServer({
    bind: o.bind,
    port: o.port ?? DEFAULT_PORT,
    allowPublic: !!o.allowPublic,
    discovery: true,
    log,
    onClosed: () => closedResolve(),
    lobby: {
      gameId: o.party ? RANDOM_GAME : o.gameId ?? MP_GAMES[0].id,
      party: !!o.party,
      roomName: 'Dedicated room',
      ...(o.maxPlayers ? { maxPlayers: o.maxPlayers } : {}),
      ...(o.options ? { options: o.options } : {}),
      ...(o.prompts?.length ? { content: { prompts: o.prompts } } : {}),
      ...(o.autoStart ? { autoStart: o.autoStart } : {}),
    },
  });
  try {
    await server.start();
  } catch (e) {
    out(`vibebreak: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const addrs = server.address === '0.0.0.0' ? lanInterfaces().map((i) => i.address) : [server.address];
  const portFlag = server.port !== DEFAULT_PORT ? ` --port ${server.port}` : '';
  log(`Room ${server.lobby.code} is open. Players join with:`);
  for (const a of addrs) out(`    vibebreak join ${a}${portFlag}`);
  if (!server.discoverable) log('(LAN discovery is off; share the address above.)');
  if (o.console) log('Type "help" for host commands.');

  // Report results and stop after --matches.
  const seen = new Set<string>();
  const watch = setInterval(() => {
    const st = server.lobby.state();
    if (st.phase === 'results' && st.results && !seen.has(st.results.matchId)) {
      seen.add(st.results.matchId);
      out('RESULT ' + JSON.stringify({ gameId: st.results.gameId, headline: st.results.headline, standings: st.results.standings, incomplete: !!st.results.incomplete }));
      if (o.matches && seen.size >= o.matches) void server.close('The host finished the session.');
      else if (o.autoStart) setTimeout(() => server.lobby.hostCommand({ cmd: 'rematch' }), 2000).unref();
    }
  }, 200);

  let rl: readline.Interface | null = null;
  if (o.console) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      const res = consoleCommand(server, line.trim());
      if (res) out(res);
    });
    rl.on('close', () => { /* stdin ended: keep serving until signalled */ });
  }
  const onSignal = () => void server.close('The host stopped the server.');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await closed;
  clearInterval(watch);
  rl?.close();
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  return 0;
}

/** Execute one console line; returns text to print. Exported for tests. */
export function consoleCommand(server: LanServer, line: string): string {
  if (!line) return '';
  const [cmd, ...args] = line.split(/\s+/);
  const lobby = server.lobby;
  const run = (c: HostCommand) => {
    const r = lobby.hostCommand(c, null);
    return r.ok ? 'ok' : `error: ${r.message}`;
  };
  switch (cmd.toLowerCase()) {
    case 'help': case '?':
      return CONSOLE_HELP;
    case 'status': {
      const s = lobby.state();
      const game = s.gameId === RANDOM_GAME ? 'random' : s.gameId;
      const ms = s.members.map((m) => `${m.name}${m.spectator ? ' (spectator)' : ''}${m.ready ? ' ready' : ''}${m.connected ? '' : ' [away]'}`);
      return `room ${s.code} · ${game} · ${s.phase} · ${ms.length} connected: ${ms.join(', ') || 'nobody yet'}`;
    }
    case 'start': return run({ cmd: 'start', force: args[0] === 'force' });
    case 'game': {
      const id = args[0] === 'random' ? RANDOM_GAME : findMpGame(args[0] ?? '')?.id;
      return id ? run({ cmd: 'select-game', gameId: id }) : `error: unknown game "${args[0] ?? ''}"`;
    }
    case 'set': {
      if (args.length < 2) return 'usage: set <key> <value>';
      const v = args[1];
      return run({ cmd: 'set-option', key: args[0], value: /^-?\d+$/.test(v) ? Number(v) : v });
    }
    case 'max': return run({ cmd: 'set-max', max: Number(args[0]) });
    case 'kick': {
      const name = args.join(' ').toLowerCase();
      const m = lobby.state().members.find((x) => x.name.toLowerCase() === name);
      return m ? run({ cmd: 'kick', playerId: m.id }) : `error: no player named "${args.join(' ')}"`;
    }
    case 'end': case 'lobby': case 'rematch': case 'next':
      return run({ cmd: cmd.toLowerCase() as 'end' });
    case 'close': case 'quit': case 'exit':
      void server.close('The host closed the lobby.');
      return 'closing...';
    default:
      return `unknown command "${cmd}" (type "help")`;
  }
}

export interface BotRunOptions {
  host: string;
  port: number;
  name: string;
  spectate?: boolean;
  matches?: number;
  out?: Out;
}

export async function runBot(o: BotRunOptions): Promise<number> {
  const out: Out = o.out ?? ((l) => process.stdout.write(l + '\n'));
  const log = (l: string) => out(`[${stamp()}] ${o.name}: ${l}`);
  const client = new LanClient({ host: o.host, port: o.port, name: o.name, ...(o.spectate ? { spectate: true } : {}) });
  try {
    await client.connect();
  } catch (e) {
    out(`vibebreak: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  log(`joined as ${client.playerId}`);
  // VIBEBREAK_BOT_THINK_MS="min-max" speeds bots up for tests and demos.
  const think = /^(\d+)-(\d+)$/.exec(process.env.VIBEBREAK_BOT_THINK_MS ?? '');
  const bot = new Bot(client, { log: (l) => log(l), ...(think ? { thinkMs: [Number(think[1]), Number(think[2])] as [number, number] } : {}) });
  bot.start();
  const seen = new Set<string>();
  let lastPhase = '';
  client.on('lobby', (s: LobbyState) => {
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      log(`room ${s.code} phase: ${s.phase}${s.activeGameId ? ` (${s.activeGameId})` : ''}`);
    }
    if (s.phase === 'results' && s.results && !seen.has(s.results.matchId)) {
      seen.add(s.results.matchId);
      const me = s.results.standings.find((x) => x.playerId === client.playerId);
      out('RESULT ' + JSON.stringify({ player: o.name, gameId: s.results.gameId, rank: me?.rank ?? null, score: me?.score ?? null, headline: s.results.headline }));
      if (o.matches && seen.size >= o.matches) client.leave();
    }
  });
  client.on('status', (st: string) => log(`connection: ${st}`));
  const reason = await new Promise<string>((r) => client.once('closed', r));
  bot.stop();
  log(`disconnected: ${reason}`);
  return 0;
}
