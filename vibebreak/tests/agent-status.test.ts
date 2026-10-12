import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  applyEvent, deriveView, parseHookPayload, pickPrimary, safeSessionId, timeoutsFromEnv, DEFAULT_TIMEOUTS,
  type AgentEvent, type SessionRecord,
} from '../src/integrations/agent-model.js';
import {
  AgentMonitor, HOOK_EVENTS, debugLogPath, gcSessions, hookSnippet, readHealth, readRecord, recordEvent, runHook, setDebug,
} from '../src/integrations/agent-status.js';
import { buildReport } from '../src/cli/doctor.js';
import { mergeVibeBreak } from '../src/integrations/claude-settings.js';

const T0 = 1_700_000_000_000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-agent-'));

let clock = T0;
/** Build an event; times advance 10ms per event unless given. */
function ev(name: string, extra: Partial<AgentEvent> = {}): AgentEvent {
  clock += 10;
  return { name, sessionId: 'S1', at: clock, agent: 'claude-code', ...extra };
}

/** Feed events through the reducer, returning the final record. */
function run(...events: AgentEvent[]): SessionRecord {
  let rec: SessionRecord | null = null;
  for (const e of events) rec = applyEvent(rec, e).record;
  return rec!;
}

describe('status state machine', () => {
  it('1. a new prompt starts a turn: THINKING', () => {
    const r = run(ev('SessionStart', { source: 'startup' }), ev('UserPromptSubmit', { promptId: 'p1' }));
    expect(r.status).toBe('THINKING');
    expect(r.counts.turns).toBe(1);
    expect(r.promptId).toBe('p1');
  });

  it('2-3. tool execution is WORKING, back to THINKING when it finishes', () => {
    const r1 = run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't1' }));
    expect(r1).toMatchObject({ status: 'WORKING', detail: 'running Bash' });
    const r2 = applyEvent(r1, ev('PostToolUse', { toolName: 'Bash', toolUseId: 't1' })).record;
    expect(r2.status).toBe('THINKING');
    expect(r2.activeTools).toEqual({});
  });

  it('parallel tools stay WORKING until the last one finishes', () => {
    let r = run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Read', toolUseId: 'a' }), ev('PreToolUse', { toolName: 'Grep', toolUseId: 'b' }));
    r = applyEvent(r, ev('PostToolUse', { toolName: 'Grep', toolUseId: 'b' })).record;
    expect(r).toMatchObject({ status: 'WORKING', detail: 'running Read' });
    r = applyEvent(r, ev('PostToolUse', { toolName: 'Read', toolUseId: 'a' })).record;
    expect(r.status).toBe('THINKING');
  });

  it('4. Stop completes the turn and clears running tools', () => {
    const r = run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't1' }), ev('Stop'));
    expect(r.status).toBe('COMPLETED');
    expect(r.activeTools).toEqual({});
  });

  it('5. a new prompt right after completion starts a fresh turn', () => {
    const r = run(ev('UserPromptSubmit'), ev('Stop'), ev('UserPromptSubmit'));
    expect(r.status).toBe('THINKING');
    expect(r.counts.turns).toBe(2);
  });

  it('6. permission prompts and questions are WAITING_FOR_INPUT, and clear when work resumes', () => {
    let r = run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't1' }), ev('PermissionRequest', { toolName: 'Bash' }));
    expect(r).toMatchObject({ status: 'WAITING_FOR_INPUT', detail: 'approve Bash?' });
    r = applyEvent(r, ev('Notification', { notificationType: 'permission_prompt' })).record;
    expect(r.status).toBe('WAITING_FOR_INPUT');
    // The old beacon stayed on "needs you" until Stop. Approval -> tool runs -> PostToolUse.
    r = applyEvent(r, ev('PostToolUse', { toolName: 'Bash', toolUseId: 't1' })).record;
    expect(r.status).toBe('THINKING');
    expect(run(ev('UserPromptSubmit'), ev('Notification', { notificationType: 'elicitation_dialog' })).status).toBe('WAITING_FOR_INPUT');
  });

  it('idle_prompt means "ready for your next prompt" only between turns', () => {
    expect(run(ev('UserPromptSubmit'), ev('Stop'), ev('Notification', { notificationType: 'idle_prompt' })))
      .toMatchObject({ status: 'WAITING_FOR_INPUT', detail: 'ready for your next prompt' });
    expect(run(ev('UserPromptSubmit'), ev('Notification', { notificationType: 'idle_prompt' })).status).toBe('THINKING');
    // Informational notifications never change the status.
    expect(run(ev('UserPromptSubmit'), ev('Stop'), ev('Notification', { notificationType: 'auth_success' })).status).toBe('COMPLETED');
  });

  it('7. API errors are ERROR; tool failures are recoverable; interrupts end the turn', () => {
    expect(run(ev('UserPromptSubmit'), ev('StopFailure', { error: 'rate_limit' }))).toMatchObject({ status: 'ERROR', detail: 'API error: rate_limit' });
    expect(run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't' }), ev('PostToolUseFailure', { toolName: 'Bash', toolUseId: 't', error: 'exit 1' })))
      .toMatchObject({ status: 'THINKING', detail: 'Bash failed, continuing' });
    expect(run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't' }), ev('PostToolUseFailure', { toolName: 'Bash', toolUseId: 't', isInterrupt: true })))
      .toMatchObject({ status: 'IDLE', detail: 'interrupted' });
    // Recovery: the next prompt clears the error.
    expect(run(ev('UserPromptSubmit'), ev('StopFailure'), ev('UserPromptSubmit')).status).toBe('THINKING');
  });

  it('8. duplicate deliveries are ignored and do not inflate counters', () => {
    const p = ev('UserPromptSubmit', { promptId: 'p1' });
    const dup = { ...p, at: p.at + 40 }; // same hook installed twice
    // Without ids, two prompts a second apart are both real.
    const q1 = ev('UserPromptSubmit');
    expect(applyEvent(applyEvent(null, q1).record, { ...q1, at: q1.at + 1000 }).record.counts.turns).toBe(2);
    let r = applyEvent(null, p).record;
    const res = applyEvent(r, dup);
    r = res.record;
    expect(res.ignored).toBe('duplicate');
    expect(r.counts).toMatchObject({ turns: 1, events: 1, duplicates: 1 });
    const pre = ev('PreToolUse', { toolName: 'Bash', toolUseId: 't1' });
    r = applyEvent(applyEvent(r, pre).record, { ...pre }).record;
    expect(r.counts.tools).toBe(1);
  });

  it('9. out-of-order delivery: an older event cannot overwrite a newer status', () => {
    const prompt = ev('UserPromptSubmit');
    const post = ev('PostToolUse', { toolName: 'Bash', toolUseId: 't1' });
    const stop = ev('Stop');
    // Stop's hook process finished first; the earlier PostToolUse lands later.
    const res = applyEvent(applyEvent(applyEvent(null, prompt).record, stop).record, post);
    expect(res.record.status).toBe('COMPLETED');
    expect(res.ignored).toBe('older than the current status');
    expect(res.record.counts.outOfOrder).toBe(1);
  });

  it('a late PreToolUse for a finished tool does not resurrect it', () => {
    const pre = ev('PreToolUse', { toolName: 'Bash', toolUseId: 't1' });
    const post = ev('PostToolUse', { toolName: 'Bash', toolUseId: 't1' });
    const r = run(ev('UserPromptSubmit'), post, pre);
    expect(r.activeTools).toEqual({});
    expect(r.status).toBe('THINKING');
  });

  it('10. events from an earlier turn are not applied to the current one', () => {
    const p1 = ev('UserPromptSubmit', { promptId: 'p1' });
    const oldTool = ev('PreToolUse', { toolName: 'Bash', toolUseId: 'old', promptId: 'p1' });
    const stop = ev('Stop');
    const p2 = ev('UserPromptSubmit', { promptId: 'p2' });
    // oldTool's hook process is the slowest and lands after the next prompt.
    const r = run(p1, stop, p2, oldTool);
    expect(r.activeTools).toEqual({});
    expect(r).toMatchObject({ status: 'THINKING', promptId: 'p2' });
    expect(r.counts.turns).toBe(2);
  });

  it('compaction restarts are activity, not a new task; SessionEnd ends the session', () => {
    expect(run(ev('UserPromptSubmit'), ev('SessionStart', { source: 'compact' })).status).toBe('THINKING');
    expect(run(ev('UserPromptSubmit'), ev('SessionEnd', { reason: 'prompt_input_exit' }))).toMatchObject({ status: 'IDLE', ended: true });
  });

  it('12. malformed or incomplete payloads are rejected or tolerated, never stored raw', () => {
    expect(parseHookPayload('nope', T0)).toEqual({ error: 'payload is not a JSON object' });
    expect(parseHookPayload([], T0)).toHaveProperty('error');
    expect(parseHookPayload({ session_id: 'x' }, T0)).toEqual({ error: 'payload has no hook_event_name' });
    const ok = parseHookPayload({ hook_event_name: 'Stop' }, T0);
    expect(ok).toEqual({ event: { name: 'Stop', sessionId: 'unknown', at: T0, agent: 'claude-code' } });
    const full = parseHookPayload({ hook_event_name: 'UserPromptSubmit', session_id: '../../etc', prompt: 'SECRET', cwd: 'C:\\code\\my-app\\', tool_input: { x: 1 } }, T0);
    expect(JSON.stringify(full)).not.toContain('SECRET');
    expect('event' in full && full.event).toMatchObject({ sessionId: 'etc', project: 'my-app' });
    expect(safeSessionId('a/b\\c:d')).toBe('abcd');
    // Unknown events still count as activity.
    expect(applyEvent(null, ev('SomeFutureEvent')).ignored).toBe('activity only');
  });
});

describe('derived view and staleness', () => {
  it('14/17. a long silent turn becomes inferred, then UNKNOWN, never COMPLETED', () => {
    const r = run(ev('UserPromptSubmit'), ev('PreToolUse', { toolName: 'Bash', toolUseId: 't' }));
    const t = DEFAULT_TIMEOUTS;
    expect(deriveView(r, r.lastEventAt + 60_000)).toMatchObject({ status: 'WORKING', certainty: 'reported' });
    expect(deriveView(r, r.lastEventAt + t.quietMs + 1)).toMatchObject({ status: 'WORKING', certainty: 'inferred' });
    const lost = deriveView(r, r.lastEventAt + t.lostMs + 1);
    expect(lost).toMatchObject({ status: 'UNKNOWN', certainty: 'inferred' });
    for (const h of [1, 5, 48]) expect(deriveView(r, r.lastEventAt + h * 3600_000).status).not.toBe('COMPLETED');
  });

  it('transcript activity keeps a long model turn reported', () => {
    const r = run(ev('UserPromptSubmit'));
    const now = r.lastEventAt + DEFAULT_TIMEOUTS.lostMs + 5000;
    expect(deriveView(r, now, DEFAULT_TIMEOUTS, now - 2000)).toMatchObject({ status: 'THINKING', certainty: 'reported' });
  });

  it('completion settles to IDLE after a while', () => {
    const r = run(ev('UserPromptSubmit'), ev('Stop'));
    expect(deriveView(r, r.statusAt + 1000).status).toBe('COMPLETED');
    expect(deriveView(r, r.statusAt + DEFAULT_TIMEOUTS.settleMs + 1)).toMatchObject({ status: 'IDLE', certainty: 'inferred' });
  });

  it('timeouts are configurable through the environment', () => {
    expect(timeoutsFromEnv({ VIBEBREAK_AGENT_LOST_SEC: '60' }).lostMs).toBe(60_000);
    expect(timeoutsFromEnv({ VIBEBREAK_AGENT_LOST_SEC: 'x' }).lostMs).toBe(DEFAULT_TIMEOUTS.lostMs);
  });

  it('11. multiple sessions: the one that needs you wins; a preferred session wins while alive', () => {
    const a = deriveView(run(ev('UserPromptSubmit', { sessionId: 'A' })), clock);
    const b = deriveView(run(ev('UserPromptSubmit', { sessionId: 'B' }), ev('PermissionRequest', { sessionId: 'B', toolName: 'Edit' })), clock);
    const c = deriveView(run(ev('UserPromptSubmit', { sessionId: 'C' }), ev('Stop', { sessionId: 'C' })), clock);
    expect(pickPrimary([a, b, c], clock).primary?.sessionId).toBe('B');
    expect(pickPrimary([a, b, c], clock, DEFAULT_TIMEOUTS, 'C').primary?.sessionId).toBe('C');
    const { others } = pickPrimary([a, b, c], clock);
    expect(others.map((o) => o.sessionId)).toEqual(['A', 'C']);
    // Old ended sessions disappear.
    const ended = deriveView(run(ev('SessionEnd', { sessionId: 'D' })), clock);
    expect(pickPrimary([ended], clock + 10 * 60_000).primary).toBeNull();
  });
});

describe('transport: hook -> session files -> monitor', () => {
  const payload = (o: object) => Readable.from([JSON.stringify(o)]);

  it('the hook records per-session state, health and nothing sensitive', async () => {
    const dir = tmpDir();
    await runHook(payload({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'TOP SECRET', cwd: '/x/proj' }), dir, 1000, T0);
    await runHook(payload({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'cat .env' } }), dir, 1000, T0 + 5);
    const rec = readRecord(path.join(dir, 'sessions', 's1.json'))!;
    expect(rec).toMatchObject({ status: 'WORKING', project: 'proj' });
    const all = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, String(f))).isFile()).map((f) => fs.readFileSync(path.join(dir, String(f))).toString()).join('');
    expect(all).not.toContain('TOP SECRET');
    expect(all).not.toContain('.env');
    expect(readHealth(dir)).toMatchObject({ received: 2, malformed: 0, lastEvent: 'PreToolUse' });
  });

  it('12-13. malformed payloads and missing sources are reported, not fatal', async () => {
    const dir = tmpDir();
    expect((await runHook(payload({ nope: 1 }), dir)).error).toBe('payload has no hook_event_name');
    expect((await runHook(Readable.from([]), dir)).error).toContain('empty stdin');
    expect(readHealth(dir)).toMatchObject({ malformed: 2 });
    // A monitor pointed at a folder that doesn't exist just has nothing to show.
    const m = new AgentMonitor(path.join(dir, 'missing'));
    expect(m.poll(T0)).toBe(false);
    expect(m.snapshot(T0)).toEqual({ primary: null, others: [], unreadable: 0 });
  });

  it('separate sessions never overwrite each other', () => {
    const dir = tmpDir();
    recordEvent(ev('UserPromptSubmit', { sessionId: 'A' }), dir);
    recordEvent(ev('UserPromptSubmit', { sessionId: 'B' }), dir);
    recordEvent(ev('Stop', { sessionId: 'A' }), dir);
    const m = new AgentMonitor(dir);
    m.poll(clock);
    const byId = Object.fromEntries(m.sessions(clock).map((s) => [s.record.sessionId, s.view.status]));
    expect(byId).toEqual({ A: 'COMPLETED', B: 'THINKING' });
  });

  it('concurrent hook processes for one session lose no events', async () => {
    const dir = tmpDir();
    const { spawn } = await import('node:child_process');
    const script = path.resolve('src/integrations/agent-status.ts');
    const code = `import { recordEvent } from ${JSON.stringify('file:///' + script.replace(/\\/g, '/'))};
      const i = Number(process.argv[1]);
      recordEvent({ name: 'PreToolUse', sessionId: 'race', at: ${T0} + i, agent: 'x', toolName: 'T' + i, toolUseId: 'id' + i }, ${JSON.stringify(dir)});`;
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<void>((res, rej) => {
      const p = spawn(process.execPath, [tsx, '-e', code, String(i)], { stdio: 'ignore' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`))));
    })));
    const rec = readRecord(path.join(dir, 'sessions', 'race.json'))!;
    expect(Object.keys(rec.activeTools).sort()).toEqual(['id0', 'id1', 'id2', 'id3', 'id4', 'id5']);
    expect(fs.readdirSync(path.join(dir, 'sessions')).filter((f) => !f.endsWith('.json'))).toEqual([]);
  }, 30_000);

  it('15. a restarted consumer rebuilds the same picture from disk', () => {
    const dir = tmpDir();
    recordEvent(ev('UserPromptSubmit', { sessionId: 'R' }), dir);
    recordEvent(ev('PreToolUse', { sessionId: 'R', toolName: 'Bash', toolUseId: 't' }), dir);
    const a = new AgentMonitor(dir);
    a.poll(clock);
    const b = new AgentMonitor(dir);
    b.poll(clock);
    expect(b.snapshot(clock)).toEqual(a.snapshot(clock));
    expect(b.snapshot(clock).primary).toMatchObject({ status: 'WORKING', sessionId: 'R' });
  });

  it('poll reports changes only when something changed; corrupt files are skipped', () => {
    const dir = tmpDir();
    const m = new AgentMonitor(dir);
    recordEvent(ev('UserPromptSubmit', { sessionId: 'P' }), dir);
    expect(m.poll(clock)).toBe(true);
    expect(m.poll(clock)).toBe(false);
    fs.writeFileSync(path.join(dir, 'sessions', 'junk.json'), '{"half":');
    m.poll(clock);
    expect(m.snapshot(clock)).toMatchObject({ unreadable: 1, primary: { sessionId: 'P' } });
  });

  it('debug log records transitions without payload text, and old files are collected', async () => {
    const dir = tmpDir();
    setDebug(true, dir);
    await runHook(payload({ hook_event_name: 'UserPromptSubmit', session_id: 'dbg12345', prompt: 'SECRET' }), dir);
    const log = fs.readFileSync(debugLogPath(dir), 'utf8');
    expect(log).toMatch(/dbg12345 UserPromptSubmit - -> THINKING/);
    expect(log).not.toContain('SECRET');
    setDebug(false, dir);
    const f = path.join(dir, 'sessions', 'dbg12345.json');
    const old = (Date.now() - 8 * 24 * 3600_000) / 1000;
    fs.utimesSync(f, old, old);
    expect(gcSessions(dir)).toBe(1);
  });
});

describe('doctor and install', () => {
  it('distinguishes configured from receiving, and flags old installs', async () => {
    const dir = tmpDir();
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'vibebreak hook' }] }] } }));
    let r = buildReport({ agent: path.join(dir, 'agent'), settingsFile: settings, legacyFile: path.join(dir, 'none.json') });
    expect(r.install.installed).toEqual(['Stop']);
    expect(r.receiving).toBe(false);
    expect(r.problems.join('\n')).toMatch(/Older install/);
    expect(r.problems.join('\n')).toMatch(/no event has ever arrived/);
    // Only the pre-upgrade beacon has seen events: the hooks do fire.
    fs.writeFileSync(path.join(dir, 'legacy.json'), '{}');
    const r2 = buildReport({ agent: path.join(dir, 'agent'), settingsFile: settings, legacyFile: path.join(dir, 'legacy.json') });
    expect(r2.problems.join('\n')).toMatch(/pre-upgrade beacon saw one/);

    fs.writeFileSync(settings, JSON.stringify(mergeVibeBreak({}, 'vibebreak hook')));
    await runHook(Readable.from([JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'z' })]), path.join(dir, 'agent'));
    r = buildReport({ agent: path.join(dir, 'agent'), settingsFile: settings, legacyFile: path.join(dir, 'none.json') });
    expect(r.install.missing).toEqual([]);
    expect(r.receiving).toBe(true);
    expect(r.sessions[0]).toMatchObject({ session: 'z', status: 'THINKING' });
  });

  it('snippet and installer cover every listened event with async handlers', () => {
    const parsed = JSON.parse(hookSnippet());
    expect(Object.keys(parsed.hooks)).toEqual([...HOOK_EVENTS]);
    for (const e of HOOK_EVENTS) expect(parsed.hooks[e][0].hooks[0]).toMatchObject({ type: 'command', command: 'vibebreak hook', async: true });
  });
});
