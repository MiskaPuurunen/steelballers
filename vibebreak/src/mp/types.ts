import type { Rng } from '../core/rng.js';

/**
 * The server-authoritative multiplayer game contract.
 *
 * A match is plain, synchronous state: the lobby feeds it actions and clock
 * ticks and asks it for per-player views. Matches never touch sockets,
 * timers or the terminal, so networking, lobbies and reconnection live in
 * one place (src/net) and every game is unit-testable without a network.
 *
 * Adding a game: implement MpGameDefinition (server logic) and a client UI
 * (src/ui/lan), then register both. No networking code changes.
 */

export interface MpPlayer {
  id: string;
  name: string;
}

export type OptionValue = number | string;

/** A host-configurable option, shown in the lobby. `values` are the only legal settings. */
export interface MpOptionSpec {
  key: string;
  label: string;
  values: OptionValue[];
  default: OptionValue;
  /** How to display numbers: seconds (0 = off) or plain. */
  unit?: 's';
}

export type Presence = 'connected' | 'disconnected' | 'gone';

export interface MatchContext {
  players: MpPlayer[];
  rng: Rng;
  options: Record<string, OptionValue>;
  /** Server clock (ms). Deadlines in views use this clock. */
  now: number;
  /** The lobby host's player id, if the host is a member (dedicated hosts have none). */
  hostId?: string;
  /** Per-lobby memory that survives rematches (e.g. prompts already used). */
  memory: Map<string, unknown>;
  /** Extra host-side content (custom prompt packs). */
  content?: { prompts?: CustomPrompt[] };
}

export interface CustomPrompt {
  text: string;
  category: string;
  absurdity: 1 | 2 | 3;
  pack: string;
}

export type ActionResult = { ok: true } | { ok: false; code: string; message: string };

export const ok: ActionResult = { ok: true };
export const reject = (code: string, message: string): ActionResult => ({ ok: false, code, message });

/** A one-off message pushed to some or all viewers (used for small deltas such as canvas strokes). */
export interface MpEvent {
  to: 'all' | string[];
  data: unknown;
}

export interface Standing {
  playerId: string;
  name: string;
  score: number;
  rank: number;
}

export interface MatchOutcome {
  standings: Standing[];
  /** One line for the results banner, e.g. "Ada sank the whole fleet". */
  headline: string;
  /** True when the match did not finish normally (host ended it, everyone left). */
  incomplete?: boolean;
  /** Per-player numeric stats for local persistence. */
  stats?: Record<string, Record<string, number>>;
}

export interface MpMatch {
  /** Apply an untrusted action from `playerId`. Must validate everything. */
  handleAction(playerId: string, action: unknown, now: number): ActionResult;
  /** Advance timers. Called a few times per second. */
  tick(now: number): void;
  /** What `playerId` may see; null = spectator. Must never leak hidden state. */
  viewFor(playerId: string | null): unknown;
  /** Connection changes: 'gone' is final (left, kicked or reconnect grace expired). */
  setPresence(playerId: string, presence: Presence, now: number): void;
  /** Drain queued events. */
  takeEvents(): MpEvent[];
  isOver(): boolean;
  outcome(): MatchOutcome | null;
  /** Force-end (host ended the match). */
  abort(reason: string): void;
}

export interface MpGameDefinition {
  id: string;
  name: string;
  kind: 'versus' | 'party';
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  /** Shown in menus, e.g. "2 players" or "3-8 players". */
  playersLabel: string;
  rules: string[];
  options: MpOptionSpec[];
  /** Action kinds spectators may send (e.g. a canvas re-sync); everything else is players only. */
  spectatorActions?: string[];
  create(ctx: MatchContext): MpMatch;
}

/** Resolve user-supplied option values against the spec (illegal values fall back to defaults). */
export function resolveOptions(def: MpGameDefinition, given: Record<string, unknown> = {}): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  for (const o of def.options) {
    const v = given[o.key];
    out[o.key] = o.values.some((x) => x === v) ? (v as OptionValue) : o.default;
  }
  return out;
}

/** Rank standings by score (ties share a rank). */
export function rankStandings(rows: Array<Omit<Standing, 'rank'>>): Standing[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 0;
  let prev: number | null = null;
  return sorted.map((r, i) => {
    if (r.score !== prev) rank = i + 1;
    prev = r.score;
    return { ...r, rank };
  });
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}
