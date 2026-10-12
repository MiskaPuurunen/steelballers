import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AgentWatcher, STALE_MS, hookSnippet, readStatus, runHook, stateForEvent, writeStatus } from '../src/integrations/agent-status.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-agent-')), 'agent-status.json');

describe('agent status beacon', () => {
  it('maps hook events to states', () => {
    expect(stateForEvent('UserPromptSubmit')).toBe('working');
    expect(stateForEvent('Stop')).toBe('done');
    expect(stateForEvent('Notification')).toBe('attention');
    expect(stateForEvent('SessionEnd')).toBe('idle');
    expect(stateForEvent('PreToolUse')).toBeNull();
  });

  it('runHook records the state from hook JSON on stdin', async () => {
    const file = tmpFile();
    const stdin = Readable.from([JSON.stringify({ session_id: 'abc', hook_event_name: 'UserPromptSubmit', prompt: 'secret' })]);
    expect(await runHook(stdin, file)).toBe('working');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.state).toBe('working');
    // Never stores prompt contents.
    expect(JSON.stringify(saved)).not.toContain('secret');
  });

  it('runHook tolerates garbage and empty input', async () => {
    const file = tmpFile();
    expect(await runHook(Readable.from(['not json']), file)).toBeNull();
    expect(await runHook(Readable.from([]), file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores stale and idle statuses', () => {
    const file = tmpFile();
    const old = new Date(Date.now() - STALE_MS - 1000).toISOString();
    writeStatus({ state: 'working', event: 'UserPromptSubmit', at: old, agent: 'x' }, file);
    expect(readStatus(file)).toBeNull();
    writeStatus({ state: 'idle', event: 'SessionEnd', at: new Date().toISOString(), agent: 'x' }, file);
    expect(readStatus(file)).toBeNull();
  });

  it('watcher reports changes', () => {
    const file = tmpFile();
    const w = new AgentWatcher(file);
    expect(w.poll()).toBe(false);
    writeStatus({ state: 'done', event: 'Stop', at: new Date().toISOString(), agent: 'claude-code' }, file);
    expect(w.poll()).toBe(true);
    expect(w.current?.state).toBe('done');
  });

  it('hook snippet is valid settings JSON with async handlers', () => {
    const parsed = JSON.parse(hookSnippet());
    for (const ev of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']) {
      expect(parsed.hooks[ev][0].hooks[0]).toMatchObject({ type: 'command', command: 'vibebreak hook', async: true });
    }
  });
});
