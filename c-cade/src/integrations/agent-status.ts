import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../storage/save.js';
import {
  applyEvent, deriveView, parseHookPayload, pickPrimary, safeSessionId, timeoutsFromEnv,
  type AgentEvent, type AiStatus, type SessionRecord, type StatusView, type Timeouts,
} from './agent-model.js';


export const HOOK_VERSION = 2;

export function agentDir(dir = configDir()): string {
  return path.join(dir, 'agent');
}
const sessionsDir = (agent: string) => path.join(agent, 'sessions');
const sessionFile = (agent: string, id: string) => path.join(sessionsDir(agent), `${safeSessionId(id)}.json`);
const healthPath = (agent: string) => path.join(agent, 'health.json');
export const debugLogPath = (agent: string) => path.join(agent, 'events.log');
const debugFlagPath = (agent: string) => path.join(agent, 'debug');

const MAX_LOG_BYTES = 256 * 1024;
const LOCK_STALE_MS = 3000;
const LOCK_WAIT_MS = 1500;
/** Session files untouched this long are deleted. */
const SESSION_GC_MS = 7 * 24 * 3600_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Atomic replace. Windows can briefly refuse a rename while a reader has the file open. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepSync(15);
    }
  }
}

/** Exclusive lock via O_EXCL; a lock older than LOCK_STALE_MS is broken. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch { /* raced with the owner */ }
      if (Date.now() > deadline) break; // give up on the lock rather than drop the event
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  }
}

/** Read and validate a session record; null when missing or malformed. */
export function readRecord(file: string): SessionRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionRecord>;
    if (!raw || raw.v !== 2 || typeof raw.sessionId !== 'string' || typeof raw.status !== 'string') return null;
    if (typeof raw.lastEventAt !== 'number' || typeof raw.statusAt !== 'number' && raw.statusAt !== null) return null;
    // JSON has no -Infinity; a fresh record stores it as null.
    raw.statusAt = typeof raw.statusAt === 'number' ? raw.statusAt : -Infinity;
    raw.activeTools ??= {};
    raw.doneTools ??= [];
    raw.recent ??= [];
    raw.counts ??= { events: 0, turns: 0, tools: 0, duplicates: 0, outOfOrder: 0 };
    return raw as SessionRecord;
  } catch {
    return null;
  }
}

export interface Health {
  hookVersion: number;
  lastHookAt: number;
  lastEvent: string;
  lastSession: string;
  received: number;
  malformed: number;
  lastError?: string;
  lastErrorAt?: number;
}

export function readHealth(agent = agentDir()): Health | null {
  try {
    const h = JSON.parse(fs.readFileSync(healthPath(agent), 'utf8')) as Health;
    return typeof h.lastHookAt === 'number' ? h : null;
  } catch {
    return null;
  }
}

function updateHealth(agent: string, change: (h: Health) => void): void {
  try {
    const h: Health = readHealth(agent) ?? { hookVersion: HOOK_VERSION, lastHookAt: 0, lastEvent: '', lastSession: '', received: 0, malformed: 0 };
    h.hookVersion = HOOK_VERSION;
    change(h);
    writeJsonAtomic(healthPath(agent), h);
  } catch { /* diagnostics must never break the hook */ }
}

export function debugEnabled(agent = agentDir()): boolean {
  return fs.existsSync(debugFlagPath(agent));
}

export function setDebug(on: boolean, agent = agentDir()): void {
  fs.mkdirSync(agent, { recursive: true });
  if (on) fs.writeFileSync(debugFlagPath(agent), 'on\n');
  else fs.rmSync(debugFlagPath(agent), { force: true });
}

/** Append one line to the debug log (only when debug is on), rotating at 256 KB. */
function debugLog(agent: string, line: string): void {
  if (!debugEnabled(agent)) return;
  try {
    const file = debugLogPath(agent);
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* ignore */ }
}

const shortId = (id: string) => id.slice(0, 8);

/** Apply one event to its session file under the session's lock. */
export function recordEvent(ev: AgentEvent, agent = agentDir()): { from: AiStatus | null; to: AiStatus; ignored?: string } {
  const file = sessionFile(agent, ev.sessionId);
  const res = withLock(file, () => {
    const r = applyEvent(readRecord(file), ev);
    writeJsonAtomic(file, { ...r.record, statusAt: Number.isFinite(r.record.statusAt) ? r.record.statusAt : null });
    return r;
  });
  updateHealth(agent, (h) => {
    h.lastHookAt = Date.now();
    h.lastEvent = ev.name;
    h.lastSession = shortId(ev.sessionId);
    h.received++;
  });
  debugLog(agent, `${shortId(ev.sessionId)} ${ev.name}${ev.toolName ? ` ${ev.toolName}` : ''}${ev.notificationType ? ` [${ev.notificationType}]` : ''} ` +
    `${res.from ?? '-'} -> ${res.to}${res.ignored ? ` (ignored: ${res.ignored})` : ''} lag=${Date.now() - ev.at}ms`);
  return res;
}

/** Delete session files nobody has touched for a week (cheap; run occasionally). */
export function gcSessions(agent = agentDir(), now = Date.now()): number {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(sessionsDir(agent))) {
      const p = path.join(sessionsDir(agent), f);
      try {
        const st = fs.statSync(p);
        const orphanTmp = (f.endsWith('.tmp') || f.endsWith('.lock')) && now - st.mtimeMs > 60_000;
        if (orphanTmp || now - st.mtimeMs > SESSION_GC_MS) { fs.unlinkSync(p); removed++; }
      } catch { /* raced */ }
    }
  } catch { /* no dir */ }
  return removed;
}

/* ------------------------------------------------------------------ hook */

interface HookOutcome {
  event: AgentEvent | null;
  to: AiStatus | null;
  error?: string;
}

/**
 * Entry point for `c-cade hook`. Reads the hook JSON from stdin, records
 * it and resolves; the caller exits 0 with no output whatever happens.
 * Printing nothing matters: for UserPromptSubmit, stdout would be added to
 * the agent's context. Only event metadata is kept: never the prompt, tool
 * input/output or messages.
 */
export async function runHook(
  stdin: NodeJS.ReadableStream = process.stdin,
  agent = agentDir(),
  timeoutMs = 1000,
  // Spawn time, not finish time: async hooks finish in any order.
  at = Math.round(Date.now() - process.uptime() * 1000),
): Promise<HookOutcome> {
  const input = await readAll(stdin, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = undefined;
  }
  const res = parseHookPayload(parsed, at);
  if ('error' in res) {
    const error = input.trim() ? res.error : 'empty stdin (was the hook run by hand?)';
    updateHealth(agent, (h) => { h.malformed++; h.lastError = error; h.lastErrorAt = Date.now(); });
    debugLog(agent, `malformed payload: ${error}`);
    return { event: null, to: null, error };
  }
  try {
    const r = recordEvent(res.event, agent);
    if (res.event.name === 'SessionStart') gcSessions(agent);
    return { event: res.event, to: r.to };
  } catch (e) {
    const error = `could not record ${res.event.name}: ${(e as Error).message}`;
    updateHealth(agent, (h) => { h.lastError = error; h.lastErrorAt = Date.now(); });
    return { event: res.event, to: null, error };
  }
}

function readAll(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('error', finish);
      resolve(buf);
    };
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      if (buf.length > 1_000_000) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
    if ((stream as NodeJS.ReadStream).isTTY) finish();
  });
}

/* --------------------------------------------------------------- monitor */

export interface AgentSnapshot {
  primary: StatusView | null;
  others: StatusView[];
  /** Malformed session files seen on the last scan. */
  unreadable: number;
}

/**
 * Consumer side: scans the sessions folder (re-reading only files whose
 * mtime changed) and derives the current view. Holds no state that a
 * restart could lose: everything is rebuilt from the files.
 */
export class AgentMonitor {
  private files = new Map<string, { mtime: number; rec: SessionRecord | null }>();
  private transcriptMtime = new Map<string, number>();
  private lastSig = '';
  readonly timeouts: Timeouts;

  constructor(
    private readonly agent = agentDir(),
    private readonly opts: { preferredSession?: string; timeouts?: Timeouts } = {},
  ) {
    this.timeouts = opts.timeouts ?? timeoutsFromEnv();
  }

  /** Re-read changed files. Returns true when what the HUD shows may have changed. */
  poll(now = Date.now()): boolean {
    const seen = new Set<string>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(sessionsDir(this.agent)).filter((f) => f.endsWith('.json'));
    } catch { /* no sessions yet */ }
    for (const f of names) {
      const p = path.join(sessionsDir(this.agent), f);
      seen.add(p);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      const cached = this.files.get(p);
      if (!cached || cached.mtime !== mtime) this.files.set(p, { mtime, rec: readRecord(p) });
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);

    // Transcript mtime is extra proof of life during long model turns.
    const primary = this.snapshot(now).primary;
    if (primary && (primary.status === 'THINKING' || primary.status === 'WORKING' || primary.status === 'UNKNOWN')) {
      const rec = this.records().find((r) => r.sessionId === primary.sessionId);
      if (rec?.transcriptPath) {
        try { this.transcriptMtime.set(rec.sessionId, fs.statSync(rec.transcriptPath).mtimeMs); } catch { /* gone */ }
      }
    }
    const snap = this.snapshot(now);
    const sig = snap.primary ? `${snap.primary.sessionId}|${snap.primary.status}|${snap.primary.detail}|${snap.primary.certainty}|${snap.others.length}` : '';
    const changed = sig !== this.lastSig;
    this.lastSig = sig;
    return changed;
  }

  private records(): SessionRecord[] {
    return [...this.files.values()].map((f) => f.rec).filter((r): r is SessionRecord => r !== null);
  }

  snapshot(now = Date.now()): AgentSnapshot {
    const views = this.records().map((r) => deriveView(r, now, this.timeouts, this.transcriptMtime.get(r.sessionId) ?? r.lastEventAt));
    const { primary, others } = pickPrimary(views, now, this.timeouts, this.opts.preferredSession);
    const unreadable = [...this.files.values()].filter((f) => f.rec === null).length;
    return { primary, others, unreadable };
  }

  /** All sessions with their derived views (for diagnostics). */
  sessions(now = Date.now()): Array<{ record: SessionRecord; view: StatusView }> {
    return this.records().map((record) => ({ record, view: deriveView(record, now, this.timeouts, this.transcriptMtime.get(record.sessionId) ?? record.lastEventAt) }));
  }
}

/* -------------------------------------------------------- settings snippet */

/** Events C-Cade listens to, in lifecycle order. */
export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd',
] as const;

/**
 * Claude Code settings snippet. With `launchCommand`, UserPromptSubmit runs
 * that command instead (it records the event *and* opens a game pane).
 */
export function hookSnippet(command = 'c-cade hook', launchCommand?: string): string {
  const group = (cmd: string) => [{ hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] }];
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = group(ev === 'UserPromptSubmit' && launchCommand ? launchCommand : command);
  return JSON.stringify({ hooks }, null, 2);
}
