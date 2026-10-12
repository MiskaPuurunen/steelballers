import { timingSafeEqual } from 'node:crypto';
import { Rng, makeSeed } from '../core/rng.js';
import { MP_GAMES, RANDOM_GAME, findMpGame } from '../mp/registry.js';
import {
  ok, reject, resolveOptions,
  type ActionResult, type CustomPrompt, type MatchOutcome, type MpGameDefinition, type MpMatch, type OptionValue,
} from '../mp/types.js';
import {
  CHAT_MAX, MAX_PLAYERS_CAP, MAX_SPECTATORS, TokenBucket, randomId, roomCode,
  type ByeCode, type ChatLine, type ClientMessage, type GameInfo, type HostCommand, type LobbyMember, type LobbyState, type Phase, type ServerMessage,
} from './protocol.js';
import { cleanName, cleanText, NAME_MAX } from './sanitize.js';
import { isLoopback } from './address.js';

/**
 * The lobby: membership, host controls, match lifecycle, reconnection and
 * per-player views. Transport-agnostic: the server hands it a ConnHandle per
 * socket, tests hand it fakes. All game outcomes are decided here or in the
 * match; nothing a client sends is trusted beyond "this connection wants X".
 */

export interface ConnHandle {
  readonly remote: string;
  send(msg: ServerMessage): void;
  close(code: ByeCode, reason: string): void;
}

export interface LobbyOptions {
  address: string;
  port: number;
  hostKey: string;
  gameId?: string;
  party?: boolean;
  maxPlayers?: number;
  roomName?: string;
  code?: string;
  /** Initial option values for the selected game. */
  options?: Record<string, unknown>;
  /** How long a disconnected player keeps their seat during a match. */
  graceMs?: number;
  /** How long a disconnected player keeps their seat in the lobby. */
  lobbyGraceMs?: number;
  /** "Get ready" screen before each match. */
  introMs?: number;
  seed?: string;
  now?: () => number;
  content?: { prompts?: CustomPrompt[] };
  log?: (line: string) => void;
  /** The host asked to close the lobby. */
  onCloseRequest?: () => void;
  /** Lets a headless host start automatically. */
  autoStart?: number;
}

interface Member {
  id: string;
  name: string;
  token: string;
  host: boolean;
  ready: boolean;
  spectator: boolean;
  conn: ConnHandle | null;
  order: number;
  dropAt: number | null;
  lastSeq: number;
  address: string;
  chat: TokenBucket;
  lastView: string;
}

interface Running {
  id: string;
  def: MpGameDefinition;
  match: MpMatch;
  participants: string[];
  startedAt: number;
}

const BAN_MS = 5 * 60_000;
const PARTY_POINTS = [3, 2, 1];

export class Lobby {
  readonly code: string;
  readonly roomName: string;
  private readonly members = new Map<string, Member>();
  private readonly byToken = new Map<string, string>();
  private readonly banned = new Map<string, number>();
  private readonly bannedTokens = new Set<string>();
  private readonly optionsByGame = new Map<string, Record<string, OptionValue>>();
  private readonly memory = new Map<string, unknown>();
  private readonly chatLog: ChatLine[] = [];
  private readonly partyScores = new Map<string, { name: string; points: number; wins: number }>();
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly lobbyGraceMs: number;
  private readonly introMs: number;
  private readonly games: GameInfo[];
  private gameId: string;
  private party: boolean;
  private maxPlayers: number;
  private phase: Phase = 'lobby';
  private running: Running | null = null;
  private pending: { def: MpGameDefinition; participants: string[]; at: number } | null = null;
  private results: LobbyState['results'] = null;
  private lastGameId: string | null = null;
  private notice: string | null = null;
  private orderCounter = 0;
  private matchCounter = 0;
  private lastStateJson = '';
  private closed = false;

  constructor(private readonly opts: LobbyOptions) {
    this.now = opts.now ?? Date.now;
    this.code = opts.code ?? roomCode();
    this.roomName = cleanText(opts.roomName, 24) || `Room ${this.code}`;
    this.rng = new Rng(opts.seed ?? makeSeed());
    this.graceMs = opts.graceMs ?? 60_000;
    this.lobbyGraceMs = opts.lobbyGraceMs ?? 30_000;
    this.introMs = opts.introMs ?? 3000;
    this.party = !!opts.party;
    this.gameId = opts.gameId ?? (this.party ? RANDOM_GAME : MP_GAMES[0].id);
    if (this.gameId !== RANDOM_GAME && !findMpGame(this.gameId)) throw new Error(`Unknown game: ${this.gameId}`);
    if (this.gameId === RANDOM_GAME) this.party = true;
    this.maxPlayers = Math.max(2, Math.min(MAX_PLAYERS_CAP, opts.maxPlayers ?? MAX_PLAYERS_CAP));
    for (const g of MP_GAMES) this.optionsByGame.set(g.id, resolveOptions(g, g.id === this.gameId ? opts.options : {}));
    this.games = MP_GAMES.map((g) => ({
      id: g.id, name: g.name, kind: g.kind, minPlayers: g.minPlayers, maxPlayers: g.maxPlayers, playersLabel: g.playersLabel,
      tagline: g.tagline, rules: g.rules, options: g.options.map((o) => ({ ...o })),
    }));
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  /* ---------------------------------------------------------- queries */

  get currentPhase(): Phase {
    return this.phase;
  }

  get matchId(): string | null {
    return this.running?.id ?? null;
  }

  /** The live match (tests and the headless host). */
  get match(): MpMatch | null {
    return this.running?.match ?? null;
  }

  get memberCount(): number {
    return this.members.size;
  }

  playerCount(): number {
    return [...this.members.values()].filter((m) => !m.spectator).length;
  }

  isBanned(address: string): boolean {
    const until = this.banned.get(address);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.banned.delete(address);
      return false;
    }
    return true;
  }

  /** Compact room summary for LAN discovery. */
  info(): { code: string; name: string; host: string; game: string; players: number; max: number; phase: Phase; joinable: boolean } {
    const host = [...this.members.values()].find((m) => m.host);
    const game = this.gameId === RANDOM_GAME ? 'Party (random)' : findMpGame(this.gameId)!.name;
    return {
      code: this.code,
      name: this.roomName,
      host: host?.name ?? 'dedicated host',
      game,
      players: this.playerCount(),
      max: this.maxPlayers,
      phase: this.phase,
      joinable: !this.closed && this.members.size < this.maxPlayers + MAX_SPECTATORS,
    };
  }

  state(): LobbyState {
    const playing = new Set(this.running?.participants ?? this.pending?.participants ?? []);
    const members: LobbyMember[] = [...this.members.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        id: m.id, name: m.name, host: m.host, ready: m.ready, spectator: m.spectator,
        connected: m.conn !== null, dropAt: m.dropAt, playing: playing.has(m.id),
      }));
    return {
      code: this.code,
      roomName: this.roomName,
      address: this.opts.address,
      port: this.opts.port,
      phase: this.phase,
      gameId: this.gameId,
      activeGameId: this.running?.def.id ?? this.pending?.def.id ?? null,
      party: this.party,
      options: this.gameId === RANDOM_GAME ? {} : { ...this.optionsByGame.get(this.gameId)! },
      maxPlayers: this.maxPlayers,
      members,
      games: this.games,
      matchId: this.running?.id ?? null,
      introEndsAt: this.pending?.at ?? null,
      results: this.results,
      partyScores: [...this.partyScores].map(([id, s]) => ({ id, ...s })).sort((a, b) => b.points - a.points || b.wins - a.wins),
      notice: this.notice,
    };
  }

  /* -------------------------------------------------------- joining */

  /** Handle a validated hello. Returns the member id, or null (the connection has been told why). */
  hello(conn: ConnHandle, msg: Extract<ClientMessage, { type: 'hello' }>): string | null {
    const now = this.now();
    if (this.closed) {
      conn.close('closed', 'The lobby is closed.');
      return null;
    }
    // Resume an existing seat.
    if (msg.token) {
      const id = this.byToken.get(msg.token);
      const m = id ? this.members.get(id) : undefined;
      if (!m) {
        if (this.bannedTokens.has(msg.token)) {
          conn.close('banned', 'You were removed from this lobby by the host.');
          return null;
        }
        conn.send({ type: 'error', code: 'UNKNOWN_SESSION', message: 'Your previous seat has expired; joining as a new player.' });
      } else {
        if (m.conn && m.conn !== conn) m.conn.close('replaced', 'Connected from another session.');
        m.conn = conn;
        m.dropAt = null;
        m.address = conn.remote;
        m.lastView = '';
        conn.send({ type: 'welcome', playerId: m.id, token: m.token, host: m.host, resumed: true, serverNow: now, protocol: 1 });
        for (const line of this.chatLog.slice(-10)) conn.send({ type: 'chat', line });
        if (this.running?.participants.includes(m.id)) this.running.match.setPresence(m.id, 'connected', now);
        this.system(`${m.name} reconnected.`);
        this.log(`${m.name} reconnected from ${conn.remote}`);
        this.flush();
        return m.id;
      }
    }

    const wantsHost = msg.hostKey !== undefined && keyMatches(msg.hostKey, this.opts.hostKey) && ![...this.members.values()].some((m) => m.host);
    const spectator = !!msg.spectate;
    if (this.members.size >= this.maxPlayers + MAX_SPECTATORS) {
      conn.close('full', `The lobby is full (${this.members.size} people connected).`);
      return null;
    }
    if (!spectator && this.playerCount() >= this.maxPlayers) {
      conn.close('full', `The lobby is full (${this.playerCount()}/${this.maxPlayers} players). You can join as a spectator.`);
      return null;
    }
    if (spectator && [...this.members.values()].filter((m) => m.spectator).length >= MAX_SPECTATORS) {
      conn.close('full', 'There are too many spectators.');
      return null;
    }

    const id = `p${randomId(6)}`;
    const token = randomId(24);
    const m: Member = {
      id,
      name: this.uniqueName(cleanName(msg.name)),
      token,
      host: wantsHost,
      ready: wantsHost,
      spectator,
      conn,
      order: this.orderCounter++,
      dropAt: null,
      lastSeq: 0,
      address: conn.remote,
      chat: new TokenBucket(3, 0.7, now),
      lastView: '',
    };
    this.members.set(id, m);
    this.byToken.set(token, id);
    conn.send({ type: 'welcome', playerId: id, token, host: m.host, resumed: false, serverNow: now, protocol: 1 });
    for (const line of this.chatLog.slice(-10)) conn.send({ type: 'chat', line });
    this.system(`${m.name} joined${spectator ? ' as a spectator' : ''}.`);
    this.log(`${m.name} joined from ${conn.remote}${m.host ? ' (host)' : ''}`);
    this.maybeAutoStart();
    this.flush();
    return id;
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const cand = [...base].slice(0, NAME_MAX - suffix.length).join('') + suffix;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
  }

  /** The socket for `memberId` dropped (not a deliberate leave). */
  disconnected(memberId: string, conn: ConnHandle): void {
    const m = this.members.get(memberId);
    if (!m || m.conn !== conn) return;
    m.conn = null;
    const now = this.now();
    const inMatch = !!this.running?.participants.includes(m.id) && (this.phase === 'match' || this.phase === 'intro');
    m.dropAt = now + (inMatch ? this.graceMs : this.lobbyGraceMs);
    if (this.running?.participants.includes(m.id)) this.running.match.setPresence(m.id, 'disconnected', now);
    this.system(`${m.name} disconnected.`);
    this.log(`${m.name} disconnected (seat held ${Math.round((m.dropAt - now) / 1000)}s)`);
    this.flush();
  }

  private remove(m: Member, why: string): void {
    this.members.delete(m.id);
    this.byToken.delete(m.token);
    const now = this.now();
    if (this.running?.participants.includes(m.id)) {
      this.running.match.setPresence(m.id, 'gone', now);
      this.checkMatchOver();
    }
    if (this.pending) {
      this.pending.participants = this.pending.participants.filter((p) => p !== m.id);
      if (this.pending.participants.length < this.pending.def.minPlayers) {
        this.pending = null;
        this.phase = 'lobby';
        this.notice = 'Not enough players to start.';
      }
    }
    this.system(`${m.name} ${why}.`);
    this.log(`${m.name} ${why}`);
  }

  /* --------------------------------------------------------- messages */

  handle(memberId: string, msg: ClientMessage): void {
    const m = this.members.get(memberId);
    if (!m || !m.conn) return;
    const conn = m.conn;
    switch (msg.type) {
      case 'ready':
        m.ready = msg.ready;
        this.maybeAutoStart();
        break;
      case 'spectate':
        if (this.phase === 'match' || this.phase === 'intro') {
          conn.send({ type: 'error', code: 'PHASE', message: 'You can switch to spectator between matches.' });
        } else if (!msg.spectate && m.spectator && this.playerCount() >= this.maxPlayers) {
          conn.send({ type: 'error', code: 'FULL', message: 'All player seats are taken.' });
        } else {
          m.spectator = msg.spectate;
        }
        break;
      case 'chat': {
        const text = cleanText(msg.text, CHAT_MAX);
        if (!text) break;
        if (!m.chat.take(this.now())) {
          conn.send({ type: 'error', code: 'RATE_LIMITED', message: 'You are chatting too fast.' });
          break;
        }
        this.pushChat({ from: m.id, name: m.name, text, at: this.now() });
        break;
      }
      case 'action': {
        if (msg.seq <= m.lastSeq) { conn.send({ type: 'ack', seq: msg.seq, ok: true, duplicate: true }); return; }
        m.lastSeq = msg.seq;
        const res = this.action(m, msg.matchId, msg.action);
        conn.send(res.ok ? { type: 'ack', seq: msg.seq, ok: true } : { type: 'ack', seq: msg.seq, ok: false, code: res.code, message: res.message });
        break;
      }
      case 'host': {
        if (msg.seq <= m.lastSeq) { conn.send({ type: 'ack', seq: msg.seq, ok: true, duplicate: true }); return; }
        m.lastSeq = msg.seq;
        const res = m.host ? this.hostCommand(msg.command, m.id) : reject('NOT_HOST', 'Only the host can do that');
        conn.send(res.ok ? { type: 'ack', seq: msg.seq, ok: true } : { type: 'ack', seq: msg.seq, ok: false, code: res.code, message: res.message });
        break;
      }
      case 'leave':
        conn.close('left', 'You left the lobby.');
        m.conn = null;
        this.remove(m, 'left');
        break;
      case 'hello':
        conn.send({ type: 'error', code: 'BAD_MESSAGE', message: 'Already joined' });
        break;
      case 'ping': case 'pong':
        break;
    }
    this.flush();
  }

  private action(m: Member, matchId: string, action: Record<string, unknown>): ActionResult {
    if (!this.running || this.phase !== 'match') return reject('PHASE', 'No match is running');
    if (matchId !== this.running.id) return reject('STALE_MATCH', 'That action was for a previous match');
    const spectatorOk = this.running.def.spectatorActions?.includes(String(action.kind)) ?? false;
    if (!this.running.participants.includes(m.id) && !m.host && !spectatorOk) return reject('NOT_PLAYING', 'You are spectating this match');
    const res = this.running.match.handleAction(m.id, action, this.now());
    this.checkMatchOver();
    return res;
  }

  /* ----------------------------------------------------- host controls */

  /** A host command, from the host player (`actorId`) or the dedicated console (null). */
  hostCommand(cmd: HostCommand, actorId: string | null = null): ActionResult {
    const res = this.applyHostCommand(cmd, actorId);
    this.flush();
    return res;
  }

  private applyHostCommand(cmd: HostCommand, actorId: string | null): ActionResult {
    const between = this.phase === 'lobby' || this.phase === 'results';
    switch (cmd.cmd) {
      case 'select-game': {
        if (!between) return reject('PHASE', 'Change the game between matches');
        if (cmd.gameId !== RANDOM_GAME && !findMpGame(cmd.gameId)) return reject('INVALID', 'Unknown game');
        this.gameId = cmd.gameId === RANDOM_GAME ? RANDOM_GAME : findMpGame(cmd.gameId)!.id;
        if (this.gameId === RANDOM_GAME) this.party = true;
        return ok;
      }
      case 'set-option': {
        if (!between) return reject('PHASE', 'Change options between matches');
        const def = findMpGame(this.gameId);
        if (!def) return reject('INVALID', 'Pick a specific game to configure it');
        const spec = def.options.find((o) => o.key === cmd.key);
        if (!spec || !spec.values.some((v) => v === cmd.value)) return reject('INVALID', 'Invalid option');
        this.optionsByGame.get(def.id)![cmd.key] = cmd.value;
        return ok;
      }
      case 'set-max': {
        if (cmd.max < 2 || cmd.max > MAX_PLAYERS_CAP) return reject('INVALID', `Max players is 2-${MAX_PLAYERS_CAP}`);
        if (cmd.max < this.playerCount()) return reject('INVALID', `${this.playerCount()} players are already here`);
        this.maxPlayers = cmd.max;
        return ok;
      }
      case 'start':
        if (!between) return reject('PHASE', 'A match is already running');
        return this.start(this.gameId, !!cmd.force);
      case 'rematch': {
        if (this.phase !== 'results' || !this.results) return reject('PHASE', 'Nothing to rematch yet');
        return this.start(this.results.gameId, true);
      }
      case 'next': {
        if (!between) return reject('PHASE', 'A match is already running');
        return this.start(RANDOM_GAME, true);
      }
      case 'end': {
        if (this.phase === 'intro') {
          this.pending = null;
          this.phase = 'lobby';
          this.system('The host cancelled the match.');
          return ok;
        }
        if (this.phase !== 'match' || !this.running) return reject('PHASE', 'No match is running');
        this.running.match.abort('The host ended the match.');
        this.checkMatchOver();
        return ok;
      }
      case 'lobby': {
        if (this.phase === 'match' && this.running) this.running.match.abort('The host returned to the lobby.');
        this.running = null;
        this.pending = null;
        this.phase = 'lobby';
        this.results = null;
        return ok;
      }
      case 'kick': {
        const t = this.members.get(cmd.playerId);
        if (!t) return reject('INVALID', 'No such player');
        if (t.host || t.id === actorId) return reject('INVALID', "The host can't kick themselves");
        this.bannedTokens.add(t.token);
        if (!isLoopback(t.address)) this.banned.set(t.address, this.now() + BAN_MS);
        t.conn?.close('kicked', 'You were removed from the lobby by the host.');
        t.conn = null;
        this.remove(t, 'was removed by the host');
        return ok;
      }
      case 'close':
        this.opts.onCloseRequest?.();
        return ok;
    }
  }

  private start(gameId: string, force: boolean): ActionResult {
    const candidates = [...this.members.values()].filter((m) => !m.spectator && m.conn).sort((a, b) => a.order - b.order);
    let def: MpGameDefinition | undefined;
    if (gameId === RANDOM_GAME) {
      const n = candidates.length;
      const fits = MP_GAMES.filter((g) => g.minPlayers <= n);
      if (!fits.length) return reject('NOT_ENOUGH_PLAYERS', 'Need at least 2 connected players');
      // Prefer games everyone can play, and not the same game twice in a row.
      const everyone = fits.filter((g) => g.maxPlayers >= n);
      let pool = everyone.length ? everyone : fits;
      if (pool.length > 1 && this.lastGameId) pool = pool.filter((g) => g.id !== this.lastGameId);
      def = this.rng.pick(pool);
    } else {
      def = findMpGame(gameId);
    }
    if (!def) return reject('INVALID', 'Unknown game');
    if (candidates.length < def.minPlayers) return reject('NOT_ENOUGH_PLAYERS', `${def.name} needs at least ${def.minPlayers} connected players (have ${candidates.length})`);
    const unready = candidates.filter((m) => !m.ready);
    if (unready.length && !force) {
      return reject('NOT_READY', `${unready.map((m) => m.name).join(', ')} ${unready.length === 1 ? 'is' : 'are'} not ready. Start again to start anyway.`);
    }
    const participants = candidates.slice(0, def.maxPlayers).map((m) => m.id);
    const benched = candidates.slice(def.maxPlayers).map((m) => m.name);
    this.notice = benched.length ? `${def.name} is ${def.playersLabel}: ${benched.join(', ')} will spectate this one.` : null;
    this.running = null;
    this.results = null;
    // A random pick gets a longer reveal ("the wheel has spoken").
    const intro = gameId === RANDOM_GAME && this.introMs > 0 ? Math.max(this.introMs, 5000) : this.introMs;
    this.pending = { def, participants, at: this.now() + intro };
    this.phase = 'intro';
    this.log(`Starting ${def.name} with ${participants.length} players`);
    if (this.pending.at <= this.now()) this.launch();
    return ok;
  }

  private launch(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const now = this.now();
    const players = p.participants.map((id) => this.members.get(id)).filter((m): m is Member => !!m).map((m) => ({ id: m.id, name: m.name }));
    if (players.length < p.def.minPlayers) {
      this.phase = 'lobby';
      this.notice = 'Not enough players to start.';
      return;
    }
    const id = `m${++this.matchCounter}-${randomId(4)}`;
    const host = [...this.members.values()].find((m) => m.host);
    const match = p.def.create({
      players,
      rng: this.rng.fork(id),
      options: { ...this.optionsByGame.get(p.def.id)! },
      now,
      ...(host ? { hostId: host.id } : {}),
      memory: this.memory,
      ...(this.opts.content ? { content: this.opts.content } : {}),
    });
    this.running = { id, def: p.def, match, participants: players.map((x) => x.id), startedAt: now };
    this.lastGameId = p.def.id;
    this.phase = 'match';
    for (const m of this.members.values()) m.lastView = '';
    // Players who dropped during the intro start out disconnected.
    for (const pid of this.running.participants) if (!this.members.get(pid)?.conn) match.setPresence(pid, 'disconnected', now);
    this.system(`${p.def.name} started!`);
  }

  private checkMatchOver(): void {
    const r = this.running;
    if (!r || this.phase !== 'match' || !r.match.isOver()) return;
    const outcome: MatchOutcome = r.match.outcome() ?? { standings: [], headline: 'Match over', incomplete: true };
    this.results = { ...outcome, gameId: r.def.id, matchId: r.id };
    this.phase = 'results';
    if (!outcome.incomplete) {
      for (const s of outcome.standings) {
        const ps = this.partyScores.get(s.playerId) ?? { name: s.name, points: 0, wins: 0 };
        ps.name = s.name;
        ps.points += PARTY_POINTS[s.rank - 1] ?? 0;
        if (s.rank === 1) ps.wins++;
        this.partyScores.set(s.playerId, ps);
      }
    }
    this.system(outcome.headline);
    this.log(`Match over: ${outcome.headline}`);
  }

  private maybeAutoStart(): void {
    const n = this.opts.autoStart;
    if (!n || this.phase !== 'lobby') return;
    const ready = [...this.members.values()].filter((m) => !m.spectator && m.conn && m.ready);
    if (ready.length >= n) this.applyHostCommand({ cmd: 'start', force: false }, null);
  }

  /* -------------------------------------------------------------- time */

  tick(): void {
    if (this.closed) return;
    const now = this.now();
    if (this.phase === 'intro' && this.pending && now >= this.pending.at) this.launch();
    if (this.running && this.phase === 'match') {
      this.running.match.tick(now);
      this.checkMatchOver();
    }
    for (const m of [...this.members.values()]) {
      if (m.conn === null && m.dropAt !== null && now >= m.dropAt) this.remove(m, 'timed out');
    }
    for (const [addr, until] of this.banned) if (until <= now) this.banned.delete(addr);
    this.flush();
  }

  /* ------------------------------------------------------------ output */

  private system(text: string): void {
    this.pushChat({ from: '', name: '', text, at: this.now(), system: true });
  }

  private pushChat(line: ChatLine): void {
    this.chatLog.push(line);
    if (this.chatLog.length > 50) this.chatLog.shift();
    for (const m of this.members.values()) m.conn?.send({ type: 'chat', line });
  }

  /** Send whatever changed: events, then lobby state, then per-player views. */
  flush(): void {
    if (this.closed) return;
    const r = this.running;
    if (r) {
      for (const ev of r.match.takeEvents()) {
        const targets = ev.to === 'all' ? [...this.members.values()] : ev.to.map((id) => this.members.get(id)).filter((m): m is Member => !!m);
        for (const m of targets) m.conn?.send({ type: 'event', matchId: r.id, data: ev.data });
      }
    }
    const state = this.state();
    const json = JSON.stringify(state);
    if (json !== this.lastStateJson) {
      this.lastStateJson = json;
      for (const m of this.members.values()) m.conn?.send({ type: 'lobby', state });
    }
    if (r && (this.phase === 'match' || this.phase === 'results')) {
      for (const m of this.members.values()) {
        if (!m.conn) continue;
        const view = r.match.viewFor(r.participants.includes(m.id) ? m.id : null);
        const vj = JSON.stringify(view);
        if (vj === m.lastView) continue;
        m.lastView = vj;
        m.conn.send({ type: 'view', matchId: r.id, gameId: r.def.id, view });
      }
    }
  }

  /** Close the lobby: tell everyone and drop all seats. Idempotent. */
  close(reason = 'The host closed the lobby.'): void {
    if (this.closed) return;
    if (this.running && this.phase === 'match') this.running.match.abort(reason);
    this.closed = true;
    for (const m of this.members.values()) {
      m.conn?.close('closed', reason);
      m.conn = null;
    }
    this.members.clear();
    this.byToken.clear();
    this.running = null;
    this.pending = null;
  }
}

function keyMatches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
