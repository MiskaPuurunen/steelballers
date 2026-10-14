import { envSetting } from '../storage/save.js';
/**
 * Agent status model: a pure, typed state machine fed by agent lifecycle
 * events (Claude Code hooks), plus the rules that turn a stored session
 * record into what the HUD shows at a given moment.
 *
 * No I/O here, so every transition is unit-tested with fake clocks.
 *
 * What the statuses mean (and what they don't):
 *  - THINKING  the agent is processing a turn and no tool is running right
 *              now. Hooks can't tell "reasoning" from "writing a reply", so
 *              both show as THINKING.
 *  - WORKING   at least one tool call has started (PreToolUse) and not yet
 *              finished (PostToolUse / PostToolUseFailure).
 *  - WAITING_FOR_INPUT  a permission prompt, a question for you, or Claude
 *              finished and is idle waiting for your next prompt.
 *  - COMPLETED the turn ended (Stop).
 *  - ERROR     the turn ended because of an API error (StopFailure).
 *  - IDLE      no active task: session just started, ended, was
 *              interrupted, or finished long ago.
 *  - UNKNOWN   we lost visibility: a turn was active but no event has
 *              arrived for a long time (e.g. Esc interrupt, which fires no
 *              hook, or a crashed agent). Never shown as COMPLETED.
 */

export type AiStatus =
  | 'IDLE' | 'THINKING' | 'WORKING' | 'WAITING_FOR_INPUT' | 'COMPLETED' | 'ERROR' | 'UNKNOWN';

/** reported = set by an event; inferred = derived from silence/time. */
type Certainty = 'reported' | 'inferred';

/** One normalised lifecycle event. Never carries prompt text or tool input. */
export interface AgentEvent {
  name: string;
  sessionId: string;
  /** Event time (ms). For hooks: when the hook process was spawned. */
  at: number;
  agent: string;
  promptId?: string;
  toolName?: string;
  toolUseId?: string;
  notificationType?: string;
  source?: string;
  reason?: string;
  error?: string;
  isInterrupt?: boolean;
  /** Project folder name (basename of cwd only). */
  project?: string;
  transcriptPath?: string;
}

export interface SessionRecord {
  v: 2;
  sessionId: string;
  agent: string;
  project: string;
  transcriptPath?: string;
  status: AiStatus;
  detail: string;
  /** Event time of the event that set the current status. */
  statusAt: number;
  /** Newest event time seen (any event, including heartbeats). */
  lastEventAt: number;
  lastEvent: string;
  promptId?: string;
  turnStartedAt: number | null;
  /** Tool calls started and not yet finished, by tool_use_id. */
  activeTools: Record<string, { tool: string; at: number }>;
  /** Recently finished tool_use_ids, so a late PreToolUse can't resurrect them. */
  doneTools: string[];
  /** Recent event fingerprints for duplicate suppression. */
  recent: Array<{ k: string; at: number }>;
  ended: boolean;
  endReason?: string;
  counts: { events: number; turns: number; tools: number; duplicates: number; outOfOrder: number };
}

export interface ApplyResult {
  record: SessionRecord;
  from: AiStatus | null;
  to: AiStatus;
  /** Why the event did not change the status, when it didn't. */
  ignored?: string;
}

/** Copies of an id-less event closer than this are one delivery (e.g. hook installed twice). */
const DEDUPE_MS = 250;
const MAX_RECENT = 24;
const MAX_DONE = 64;
const MAX_STR = 120;

function newRecord(ev: AgentEvent): SessionRecord {
  return {
    v: 2,
    sessionId: ev.sessionId,
    agent: ev.agent,
    project: ev.project ?? '',
    status: 'IDLE',
    detail: 'no events yet',
    statusAt: -Infinity,
    lastEventAt: ev.at,
    lastEvent: ev.name,
    turnStartedAt: null,
    activeTools: {},
    doneTools: [],
    recent: [],
    ended: false,
    counts: { events: 0, turns: 0, tools: 0, duplicates: 0, outOfOrder: 0 },
  };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_STR) : undefined;

/** Session ids become file names: keep them boring. */
export function safeSessionId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return clean || 'unknown';
}

/**
 * Normalise a raw hook payload. Unknown events are accepted (they still
 * count as activity); missing optional fields are fine. Only a missing
 * hook_event_name is an error.
 */
export function parseHookPayload(raw: unknown, at: number, agent = 'claude-code'): { event: AgentEvent } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'payload is not a JSON object' };
  const p = raw as Record<string, unknown>;
  const name = str(p.hook_event_name);
  if (!name) return { error: 'payload has no hook_event_name' };
  const cwd = str(p.cwd);
  const project = cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined;
  const event: AgentEvent = {
    name,
    sessionId: safeSessionId(str(p.session_id) ?? 'unknown'),
    at,
    agent,
    promptId: str(p.prompt_id),
    toolName: str(p.tool_name),
    toolUseId: str(p.tool_use_id),
    notificationType: str(p.notification_type),
    source: str(p.source),
    reason: str(p.reason),
    error: str(p.error),
    isInterrupt: p.is_interrupt === true ? true : undefined,
    project,
    transcriptPath: typeof p.transcript_path === 'string' ? p.transcript_path : undefined,
  };
  for (const k of Object.keys(event) as Array<keyof AgentEvent>) if (event[k] === undefined) delete event[k];
  return { event };
}

const fingerprint = (ev: AgentEvent) =>
  [ev.name, ev.toolUseId ?? '', ev.notificationType ?? '', ev.promptId ?? ''].join('|');

const toolKey = (ev: AgentEvent) => ev.toolUseId ?? `anon:${ev.toolName ?? '?'}`;

/**
 * Apply one event to a session record (mutates and returns it).
 *
 * Ordering: async hooks run as parallel processes with no delivery-order
 * guarantee, so each event carries its own spawn time. Only an event at
 * least as new as the one that set the current status may change the
 * status; older events still update tool bookkeeping and counters.
 */
export function applyEvent(prev: SessionRecord | null, ev: AgentEvent): ApplyResult {
  const rec = prev ?? newRecord(ev);
  const from = prev ? prev.status : null;

  // Duplicate delivery (e.g. the hook installed in two settings files).
  // With a unique id (prompt_id / tool_use_id) the id decides; otherwise only
  // near-simultaneous copies count, so two real quick prompts stay two.
  const k = fingerprint(ev);
  const unique = ev.toolUseId !== undefined || ev.promptId !== undefined;
  const between = (a: number, b: number) => rec.recent.some((r) => r.k !== k && r.at > Math.min(a, b) && r.at < Math.max(a, b));
  if (rec.recent.some((r) => r.k === k && (unique || (Math.abs(r.at - ev.at) < DEDUPE_MS && !between(r.at, ev.at))))) {
    rec.counts.duplicates++;
    return { record: rec, from, to: rec.status, ignored: 'duplicate' };
  }
  rec.recent.push({ k, at: ev.at });
  if (rec.recent.length > MAX_RECENT) rec.recent.splice(0, rec.recent.length - MAX_RECENT);

  rec.counts.events++;
  if (ev.at >= rec.lastEventAt) {
    rec.lastEventAt = ev.at;
    rec.lastEvent = ev.name;
  }
  if (ev.project) rec.project = ev.project;
  if (ev.transcriptPath) rec.transcriptPath = ev.transcriptPath;

  const newer = ev.at >= rec.statusAt;
  let ignored: string | undefined;
  const set = (status: AiStatus, detail: string): void => {
    if (!newer) {
      ignored = 'older than the current status';
      rec.counts.outOfOrder++;
      return;
    }
    rec.status = status;
    rec.detail = detail.slice(0, MAX_STR);
    rec.statusAt = ev.at;
  };
  const afterTool = (what: string): void => {
    const running = Object.values(rec.activeTools).sort((a, b) => b.at - a.at)[0];
    if (running) set('WORKING', `running ${running.tool}`);
    else set('THINKING', what);
  };

  switch (ev.name) {
    case 'SessionStart':
      rec.ended = false;
      delete rec.endReason;
      // Auto-compaction restarts mid-turn: it is not a new task.
      if (ev.source === 'compact') ignored = 'compaction (activity only)';
      else set('IDLE', ev.source === 'resume' ? 'session resumed' : 'session started');
      break;

    case 'UserPromptSubmit':
      set('THINKING', 'working on your prompt');
      if (newer) {
        // A new turn clears stale completion, errors and orphaned tools.
        rec.counts.turns++;
        rec.turnStartedAt = ev.at;
        rec.activeTools = {};
        if (ev.promptId) rec.promptId = ev.promptId;
        rec.ended = false;
      }
      break;

    case 'PreToolUse': {
      const key = toolKey(ev);
      rec.counts.tools++;
      // A late PreToolUse for a call that already finished must not restart it.
      if (!rec.doneTools.includes(key) && (rec.turnStartedAt === null || ev.at >= rec.turnStartedAt)) {
        rec.activeTools[key] = { tool: ev.toolName ?? 'a tool', at: ev.at };
      }
      if (rec.activeTools[key]) set('WORKING', `running ${ev.toolName ?? 'a tool'}`);
      else ignored = 'tool already finished';
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const key = toolKey(ev);
      delete rec.activeTools[key];
      if (!ev.toolUseId) {
        // Without ids, drop the oldest matching anonymous call.
        for (const [id, t] of Object.entries(rec.activeTools)) if (t.tool === ev.toolName) { delete rec.activeTools[id]; break; }
      }
      rec.doneTools.push(key);
      if (rec.doneTools.length > MAX_DONE) rec.doneTools.splice(0, rec.doneTools.length - MAX_DONE);
      if (ev.isInterrupt) {
        set('IDLE', 'interrupted');
        if (newer) rec.activeTools = {};
      } else if (ev.name === 'PostToolUseFailure') afterTool(`${ev.toolName ?? 'tool'} failed, continuing`);
      else afterTool('thinking');
      break;
    }

    case 'PermissionRequest':
      set('WAITING_FOR_INPUT', `approve ${ev.toolName ?? 'a tool'}?`);
      break;

    case 'PermissionDenied':
      afterTool('tool call denied, continuing');
      break;

    case 'Elicitation':
      set('WAITING_FOR_INPUT', 'has a question for you');
      break;

    case 'ElicitationResult':
      afterTool('thinking');
      break;

    case 'Notification':
      switch (ev.notificationType) {
        case 'permission_prompt':
          set('WAITING_FOR_INPUT', 'needs permission');
          break;
        case 'elicitation_dialog':
        case 'elicitation_url_dialog':
        case 'agent_needs_input':
          set('WAITING_FOR_INPUT', 'has a question for you');
          break;
        case 'idle_prompt':
          // "Finished ~60s ago and you haven't typed": only meaningful between turns.
          if (rec.status === 'THINKING' || rec.status === 'WORKING') ignored = 'idle notice during an active turn';
          else set('WAITING_FOR_INPUT', 'ready for your next prompt');
          break;
        case undefined:
          // Older Claude Code versions send no type; all of them asked for attention.
          set('WAITING_FOR_INPUT', 'needs your attention');
          break;
        default:
          ignored = `notification "${ev.notificationType}" (activity only)`;
      }
      break;

    case 'Stop':
      set('COMPLETED', 'turn finished');
      if (newer) rec.activeTools = {};
      break;

    case 'StopFailure':
      set('ERROR', `API error${ev.error ? `: ${ev.error}` : ''}`);
      if (newer) rec.activeTools = {};
      break;

    case 'SessionEnd':
      set('IDLE', `session ended${ev.reason ? ` (${ev.reason})` : ''}`);
      if (newer) {
        rec.ended = true;
        rec.endReason = ev.reason ?? 'other';
        rec.activeTools = {};
      }
      break;

    default:
      // SubagentStart/Stop, PreCompact, PostToolBatch...: proof of life only.
      ignored = 'activity only';
  }

  return { record: rec, from, to: rec.status, ...(ignored ? { ignored } : {}) };
}

/* ------------------------------------------------------------ the view */

export interface Timeouts {
  /** Active turn with no activity this long: still shown, but marked inferred. */
  quietMs: number;
  /** Active turn with no activity this long: UNKNOWN (visibility lost). */
  lostMs: number;
  /** COMPLETED / ERROR / WAITING older than this settle to IDLE / UNKNOWN. */
  settleMs: number;
  /** Sessions with no events for this long are not shown at all. */
  forgetMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  quietMs: 3 * 60_000,
  lostMs: 20 * 60_000,
  settleMs: 30 * 60_000,
  forgetMs: 12 * 3600_000,
};

/** Timeouts can be tuned with C_CADE_AGENT_QUIET_SEC / _LOST_SEC / _SETTLE_SEC. */
export function timeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): Timeouts {
  const sec = (k: string, d: number) => {
    const n = Number(envSetting(env, k));
    return Number.isFinite(n) && n > 0 ? n * 1000 : d;
  };
  return {
    quietMs: sec('AGENT_QUIET_SEC', DEFAULT_TIMEOUTS.quietMs),
    lostMs: sec('AGENT_LOST_SEC', DEFAULT_TIMEOUTS.lostMs),
    settleMs: sec('AGENT_SETTLE_SEC', DEFAULT_TIMEOUTS.settleMs),
    forgetMs: DEFAULT_TIMEOUTS.forgetMs,
  };
}

export interface StatusView {
  status: AiStatus;
  detail: string;
  certainty: Certainty;
  sessionId: string;
  agent: string;
  project: string;
  /** Last authoritative event time. */
  lastEventAt: number;
  /** Last sign of life (event or transcript write). */
  activityAt: number;
  ended: boolean;
  turnStartedAt: number | null;
}

const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;

/**
 * What to show for a session right now. `activityAt` may include extra
 * liveness evidence (the transcript file's mtime). Silence can make a
 * status *less* certain, never "completed".
 */
export function deriveView(rec: SessionRecord, now: number, t: Timeouts = DEFAULT_TIMEOUTS, activityAt = rec.lastEventAt): StatusView {
  const activity = Math.max(activityAt, rec.lastEventAt);
  const base: StatusView = {
    status: rec.status,
    detail: rec.detail,
    certainty: 'reported',
    sessionId: rec.sessionId,
    agent: rec.agent,
    project: rec.project,
    lastEventAt: rec.lastEventAt,
    activityAt: activity,
    ended: rec.ended,
    turnStartedAt: rec.turnStartedAt,
  };
  const quiet = now - activity;
  const age = now - rec.statusAt;
  switch (rec.status) {
    case 'THINKING':
    case 'WORKING':
      if (quiet >= t.lostMs) {
        return { ...base, status: 'UNKNOWN', certainty: 'inferred', detail: `no activity for ${mins(quiet)} (interrupted or closed?)` };
      }
      if (quiet >= t.quietMs) return { ...base, certainty: 'inferred', detail: `${rec.detail}, quiet for ${mins(quiet)}` };
      return base;
    case 'WAITING_FOR_INPUT':
      if (quiet >= t.settleMs) return { ...base, status: 'UNKNOWN', certainty: 'inferred', detail: `was waiting for you ${mins(quiet)} ago` };
      return base;
    case 'COMPLETED':
    case 'ERROR':
      if (age >= t.settleMs) return { ...base, status: 'IDLE', certainty: 'inferred', detail: `last turn ${rec.status === 'ERROR' ? 'failed' : 'finished'} ${mins(age)} ago` };
      return base;
    default:
      return base;
  }
}

const RANK: Record<AiStatus, number> = {
  WAITING_FOR_INPUT: 0, ERROR: 1, WORKING: 2, THINKING: 2, COMPLETED: 3, UNKNOWN: 4, IDLE: 5,
};


/**
 * Choose the session the HUD should talk about. A preferred session (the
 * one that auto-launched this arcade) wins while it is alive; otherwise the
 * one that most needs you, then the busiest, then the most recent.
 */
export function pickPrimary(views: StatusView[], now: number, t: Timeouts = DEFAULT_TIMEOUTS, preferred?: string): { primary: StatusView | null; others: StatusView[] } {
  const visible = views.filter((v) => now - v.activityAt < t.forgetMs && !(v.ended && now - v.lastEventAt > 5 * 60_000));
  if (visible.length === 0) return { primary: null, others: [] };
  const pref = preferred ? visible.find((v) => v.sessionId === preferred && !v.ended) : undefined;
  const sorted = [...visible].sort((a, b) => RANK[a.status] - RANK[b.status] || b.activityAt - a.activityAt);
  const primary = pref ?? sorted[0];
  return { primary, others: sorted.filter((v) => v !== primary) };
}
