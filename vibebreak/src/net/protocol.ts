import { isInt, isObj, type MatchOutcome, type OptionValue } from '../mp/types.js';

/**
 * VibeBreak LAN protocol, version 1.
 *
 * Transport: TCP, one JSON object per line (UTF-8, '\n' terminated), at
 * most MAX_MESSAGE_BYTES per line. Every message is an envelope:
 *
 *   { "v": 1, "type": "action", "seq": 12, "matchId": "m3", "payload": {...} }
 *
 * - v        protocol version; a mismatch is rejected with a clear error.
 * - type     message type (below).
 * - seq      client request id for action/host messages; the server acks it
 *            and ignores repeats, so resending after a reconnect is safe.
 *            Server messages carry their own increasing seq so a client can
 *            drop anything stale or out of order.
 * - matchId  which match an action or view belongs to; actions for an old
 *            match are rejected instead of leaking into the next one.
 * - playerId set by the server on its messages. Identity is the connection,
 *            never a client claim.
 * - payload  type-specific body (always an object).
 *
 * The server is authoritative: clients send intentions (fire at B4, vote
 * for C), the server validates them and decides every outcome.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7777;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_PLAYERS_CAP = 8;
export const MAX_SPECTATORS = 8;
export const CHAT_MAX = 120;

/* ------------------------------------------------------------ envelopes */

export interface Envelope<T extends string = string, P = Record<string, unknown>> {
  v: number;
  type: T;
  seq?: number;
  matchId?: string;
  playerId?: string;
  payload: P;
}

/* ---------------------------------------------------- client -> server */

export type HostCommand =
  | { cmd: 'select-game'; gameId: string }
  | { cmd: 'set-option'; key: string; value: OptionValue }
  | { cmd: 'set-max'; max: number }
  | { cmd: 'start'; force?: boolean }
  | { cmd: 'end' }
  | { cmd: 'kick'; playerId: string }
  | { cmd: 'lobby' }
  | { cmd: 'rematch' }
  | { cmd: 'next' }
  | { cmd: 'close' };

export type ClientMessage =
  | { type: 'hello'; name: string; token?: string; hostKey?: string; spectate?: boolean; client?: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'spectate'; spectate: boolean }
  | { type: 'action'; seq: number; matchId: string; action: Record<string, unknown> }
  | { type: 'host'; seq: number; command: HostCommand }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'leave' };

/* ---------------------------------------------------- server -> client */

export type Phase = 'lobby' | 'intro' | 'match' | 'results';

export interface LobbyMember {
  id: string;
  name: string;
  host: boolean;
  ready: boolean;
  spectator: boolean;
  connected: boolean;
  /** Server time after which a disconnected member is dropped. */
  dropAt: number | null;
  /** Taking part in the current match. */
  playing: boolean;
}

export interface GameInfo {
  id: string;
  name: string;
  kind: 'versus' | 'party';
  minPlayers: number;
  maxPlayers: number;
  playersLabel: string;
  tagline: string;
  rules: string[];
  options: Array<{ key: string; label: string; values: OptionValue[]; default: OptionValue; unit?: 's' }>;
}

export interface LobbyState {
  code: string;
  roomName: string;
  address: string;
  port: number;
  phase: Phase;
  /** Selected game id, or 'random' in party mode. */
  gameId: string;
  /** The game actually being played (resolved from 'random'). */
  activeGameId: string | null;
  party: boolean;
  options: Record<string, OptionValue>;
  maxPlayers: number;
  members: LobbyMember[];
  games: GameInfo[];
  matchId: string | null;
  introEndsAt: number | null;
  results: (MatchOutcome & { gameId: string; matchId: string }) | null;
  /** Party mode: cumulative points across matches (1st place = most). */
  partyScores: Array<{ id: string; name: string; points: number; wins: number }>;
  notice: string | null;
}

export interface ChatLine {
  from: string;
  name: string;
  text: string;
  at: number;
  system?: boolean;
}

export type ServerMessage =
  | { type: 'welcome'; playerId: string; token: string; host: boolean; resumed: boolean; serverNow: number; protocol: number }
  | { type: 'lobby'; state: LobbyState }
  | { type: 'view'; matchId: string; gameId: string; view: unknown }
  | { type: 'event'; matchId: string; data: unknown }
  | { type: 'ack'; seq: number; ok: boolean; code?: string; message?: string; duplicate?: boolean }
  | { type: 'chat'; line: ChatLine }
  | { type: 'error'; code: string; message: string; fatal?: boolean }
  | { type: 'bye'; reason: string; code: ByeCode }
  | { type: 'ping'; t: number; serverNow: number }
  | { type: 'pong'; t: number; serverNow: number };

export type ByeCode = 'closed' | 'kicked' | 'left' | 'replaced' | 'timeout' | 'full' | 'version' | 'invalid' | 'banned' | 'flood';

/* ------------------------------------------------------------- encoding */

let serverSeq = 0;

/** Wrap a server message in an envelope. */
export function encodeServer(msg: ServerMessage, playerId?: string): string {
  const { type, ...rest } = msg;
  const env: Envelope = { v: PROTOCOL_VERSION, type, seq: ++serverSeq, payload: rest as Record<string, unknown> };
  if (playerId) env.playerId = playerId;
  if ('matchId' in msg) env.matchId = msg.matchId;
  return JSON.stringify(env) + '\n';
}

export function encodeClient(msg: ClientMessage): string {
  const { type, ...rest } = msg as ClientMessage & Record<string, unknown>;
  const env: Envelope = { v: PROTOCOL_VERSION, type, payload: {} };
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'seq') env.seq = v as number;
    else if (k === 'matchId') env.matchId = v as string;
    else payload[k] = v;
  }
  env.payload = payload;
  return JSON.stringify(env) + '\n';
}

/* ------------------------------------------------------------ decoding */

export type Decoded<T> = { ok: true; msg: T; seq?: number } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });

function parseEnvelope(line: string): Decoded<Envelope> {
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return fail('TOO_LARGE', 'Message too large');
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail('BAD_JSON', 'Message is not valid JSON');
  }
  if (!isObj(raw)) return fail('BAD_MESSAGE', 'Message must be a JSON object');
  if (raw.v !== PROTOCOL_VERSION) return fail('VERSION', `Protocol version ${String(raw.v)} is not supported (this build speaks v${PROTOCOL_VERSION})`);
  if (typeof raw.type !== 'string' || raw.type.length > 24) return fail('BAD_MESSAGE', 'Missing message type');
  if (!isObj(raw.payload)) return fail('BAD_MESSAGE', 'Missing payload object');
  if (raw.seq !== undefined && !isInt(raw.seq, 0, Number.MAX_SAFE_INTEGER)) return fail('BAD_MESSAGE', 'Invalid seq');
  if (raw.matchId !== undefined && (typeof raw.matchId !== 'string' || raw.matchId.length > 32)) return fail('BAD_MESSAGE', 'Invalid matchId');
  return { ok: true, msg: raw as unknown as Envelope };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function parseHostCommand(p: Record<string, unknown>): HostCommand | null {
  switch (p.cmd) {
    case 'select-game':
      return str(p.gameId, 32) && ID_RE.test(p.gameId) ? { cmd: 'select-game', gameId: p.gameId } : null;
    case 'set-option':
      return str(p.key, 32) && ((typeof p.value === 'number' && Number.isFinite(p.value)) || str(p.value, 32))
        ? { cmd: 'set-option', key: p.key, value: p.value as OptionValue } : null;
    case 'set-max':
      return isInt(p.max, 1, 64) ? { cmd: 'set-max', max: p.max } : null;
    case 'start':
      return { cmd: 'start', force: p.force === true };
    case 'kick':
      return str(p.playerId, 32) ? { cmd: 'kick', playerId: p.playerId } : null;
    case 'end': case 'lobby': case 'rematch': case 'next': case 'close':
      return { cmd: p.cmd };
    default:
      return null;
  }
}

/** Validate one line from a client. Never throws. */
export function decodeClient(line: string): Decoded<ClientMessage> {
  const env = parseEnvelope(line);
  if (!env.ok) return env;
  const { type, payload: p, seq, matchId } = env.msg;
  const bad = (what: string) => fail('BAD_MESSAGE', `Invalid ${type} message: ${what}`);
  switch (type) {
    case 'hello': {
      if (!str(p.name, 200)) return bad('name');
      if (p.token !== undefined && !(typeof p.token === 'string' && /^[a-z0-9]{8,64}$/.test(p.token))) return bad('token');
      if (p.hostKey !== undefined && !str(p.hostKey, 64)) return bad('hostKey');
      return {
        ok: true,
        msg: {
          type, name: p.name,
          ...(p.token !== undefined ? { token: p.token as string } : {}),
          ...(p.hostKey !== undefined ? { hostKey: p.hostKey as string } : {}),
          ...(p.spectate === true ? { spectate: true } : {}),
          ...(str(p.client, 40) ? { client: p.client } : {}),
        },
      };
    }
    case 'ready':
      return typeof p.ready === 'boolean' ? { ok: true, msg: { type, ready: p.ready } } : bad('ready');
    case 'spectate':
      return typeof p.spectate === 'boolean' ? { ok: true, msg: { type, spectate: p.spectate } } : bad('spectate');
    case 'action':
      if (seq === undefined) return bad('seq');
      if (!matchId) return bad('matchId');
      if (!isObj(p.action) || typeof p.action.kind !== 'string') return bad('action');
      return { ok: true, msg: { type, seq, matchId, action: p.action }, seq };
    case 'host': {
      if (seq === undefined) return bad('seq');
      const command = isObj(p.command) ? parseHostCommand(p.command) : null;
      return command ? { ok: true, msg: { type, seq, command }, seq } : bad('command');
    }
    case 'chat':
      return str(p.text, 1000) ? { ok: true, msg: { type, text: p.text } } : bad('text');
    case 'ping': case 'pong':
      return typeof p.t === 'number' && Number.isFinite(p.t) ? { ok: true, msg: { type, t: p.t } } : bad('t');
    case 'leave':
      return { ok: true, msg: { type } };
    default:
      return fail('UNKNOWN_TYPE', `Unknown message type "${type}"`);
  }
}

const SERVER_TYPES = new Set(['welcome', 'lobby', 'view', 'event', 'ack', 'chat', 'error', 'bye', 'ping', 'pong']);

/** Validate one line from the server (shape only; strings are scrubbed by the client). */
export function decodeServer(line: string): Decoded<ServerMessage> {
  const env = parseEnvelope(line.length > MAX_MESSAGE_BYTES * 4 ? line.slice(0, MAX_MESSAGE_BYTES * 4) : line);
  if (!env.ok) return env;
  const { type, payload } = env.msg;
  if (!SERVER_TYPES.has(type)) return fail('UNKNOWN_TYPE', `Unknown message type "${type}"`);
  const msg = { type, ...payload } as Record<string, unknown>;
  if ((type === 'view' || type === 'event') && typeof env.msg.matchId === 'string') msg.matchId = env.msg.matchId;
  const need = (k: string, t: string) => typeof msg[k] === t;
  const valid =
    type === 'welcome' ? need('playerId', 'string') && need('token', 'string') && need('serverNow', 'number') :
    type === 'lobby' ? isObj(msg.state) && Array.isArray((msg.state as Record<string, unknown>).members) :
    type === 'view' ? need('matchId', 'string') && need('gameId', 'string') :
    type === 'event' ? need('matchId', 'string') :
    type === 'ack' ? need('seq', 'number') && need('ok', 'boolean') :
    type === 'chat' ? isObj(msg.line) :
    type === 'error' || type === 'bye' ? (need('message', 'string') || need('reason', 'string')) :
    need('t', 'number');
  if (!valid) return fail('BAD_MESSAGE', `Malformed ${type} message from server`);
  return { ok: true, msg: msg as unknown as ServerMessage, ...(env.msg.seq !== undefined ? { seq: env.msg.seq } : {}) };
}

/* ------------------------------------------------------- line framing */

/**
 * Splits a byte stream into lines, refusing to buffer more than `max`
 * bytes without a newline (a peer that never sends '\n' cannot exhaust
 * memory).
 */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);
  overflowed = false;

  constructor(private readonly max = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): string[] {
    if (this.overflowed) return [];
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.pending.indexOf(0x0a, start);
      if (nl < 0) break;
      if (nl - start > this.max) {
        this.overflowed = true;
        return lines;
      }
      const line = this.pending.subarray(start, nl).toString('utf8').replace(/\r$/, '');
      if (line.trim()) lines.push(line);
      start = nl + 1;
    }
    this.pending = start ? this.pending.subarray(start) : this.pending;
    if (this.pending.length > this.max) {
      this.overflowed = true;
      this.pending = Buffer.alloc(0);
    }
    return lines;
  }
}

/* --------------------------------------------------------- rate limits */

/** Classic token bucket. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly capacity: number, private readonly perSec: number, now: number) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Short random id from a URL-safe alphabet (crypto-strength). */
export function randomId(len: number, alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Four-letter room code, easy to read aloud. */
export function roomCode(): string {
  return randomId(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ');
}
