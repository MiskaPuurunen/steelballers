import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../storage/save.js';

/**
 * Agent status beacon.
 *
 * AI coding agents (via hooks) write a tiny status file; a VibeBreak running
 * in another terminal reads it and shows "AI working" / "AI done" in the HUD.
 * This is a one-way, file-based signal: VibeBreak never talks to the agent,
 * never reads its stdin/stdout and never blocks it.
 */

export type AgentState = 'working' | 'done' | 'attention' | 'idle';

export interface AgentStatus {
  state: AgentState;
  event: string;
  at: string;
  agent: string;
}

/** Statuses older than this are treated as stale and ignored. */
export const STALE_MS = 30 * 60 * 1000;

export function statusPath(dir = configDir()): string {
  return path.join(dir, 'agent-status.json');
}

/** Map a Claude Code hook event name to a beacon state. */
export function stateForEvent(event: string): AgentState | null {
  switch (event) {
    case 'UserPromptSubmit':
      return 'working';
    case 'Stop':
    case 'StopFailure':
      return 'done';
    case 'Notification':
      return 'attention';
    case 'SessionEnd':
      return 'idle';
    default:
      return null;
  }
}

export function writeStatus(status: AgentStatus, file = statusPath()): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function readStatus(file = statusPath(), now = Date.now()): AgentStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentStatus>;
    if (!raw || typeof raw.state !== 'string' || typeof raw.at !== 'string') return null;
    const age = now - Date.parse(raw.at);
    if (!Number.isFinite(age) || age > STALE_MS || raw.state === 'idle') return null;
    return { state: raw.state as AgentState, event: String(raw.event ?? ''), at: raw.at, agent: String(raw.agent ?? 'agent') };
  } catch {
    return null;
  }
}

/** Polls the status file cheaply (mtime check first). */
export class AgentWatcher {
  private mtime = 0;
  current: AgentStatus | null = null;

  constructor(private readonly file = statusPath()) {}

  /** Returns true when the status changed. */
  poll(now = Date.now()): boolean {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      mtime = 0;
    }
    const before = this.current?.state ?? null;
    if (mtime !== this.mtime) {
      this.mtime = mtime;
      this.current = mtime ? readStatus(this.file, now) : null;
    } else if (this.current && now - Date.parse(this.current.at) > STALE_MS) {
      this.current = null;
    }
    return (this.current?.state ?? null) !== before;
  }
}

/**
 * Entry point for `vibebreak hook`. Reads the hook JSON from stdin, records
 * the agent state and exits 0 with no output, no matter what happens.
 * Printing nothing matters: for UserPromptSubmit, stdout would be added to
 * the agent's context.
 */
export async function runHook(
  stdin: NodeJS.ReadableStream = process.stdin,
  file = statusPath(),
  timeoutMs = 1000,
): Promise<AgentState | null> {
  const input = await readAll(stdin, timeoutMs);
  let event = '';
  try {
    const parsed = JSON.parse(input) as { hook_event_name?: unknown };
    if (typeof parsed.hook_event_name === 'string') event = parsed.hook_event_name;
  } catch {
    /* not JSON — ignore */
  }
  const state = stateForEvent(event);
  if (state) writeStatus({ state, event, at: new Date().toISOString(), agent: 'claude-code' }, file);
  return state;
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

export function hookSnippet(command = 'vibebreak hook'): string {
  const handler = { type: 'command', command, async: true, timeout: 5 };
  const group = [{ hooks: [handler] }];
  return JSON.stringify(
    { hooks: { UserPromptSubmit: group, Stop: group, Notification: group, SessionEnd: group } },
    null,
    2,
  );
}
