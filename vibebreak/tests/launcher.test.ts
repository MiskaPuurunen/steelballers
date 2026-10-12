import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { acquireArcadeLock, arcadeRunning, autoLaunch, lockPath, planLaunch, shq, type LaunchPlan } from '../src/integrations/launcher.js';
import { hookSnippet, runHook } from '../src/integrations/agent-status.js';
import { parseArgs } from '../src/cli/args.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-launch-'));
const CMD = ['/usr/bin/node', '/opt/vibe break/dist/cli/index.js', 'play', '--from-hook'];

describe('planLaunch', () => {
  it('splits Windows Terminal when running inside it', () => {
    const p = planLaunch(CMD, { WT_SESSION: 'x' }, 'win32')!;
    expect(p.cmd).toBe('wt.exe');
    expect(p.args.slice(0, 4)).toEqual(['-w', '0', 'split-pane', '-V']);
    expect(p.args.slice(-4)).toEqual(CMD);
  });

  it('falls back to a new console window on plain Windows', () => {
    const p = planLaunch(CMD, {}, 'win32')!;
    expect(p.cmd).toBe('cmd.exe');
    expect(p.verbatim).toBe(true);
    expect(p.args.at(-1)).toBe('start "VibeBreak" "/usr/bin/node" "/opt/vibe break/dist/cli/index.js" "play" "--from-hook"');
  });

  it('uses a tmux split when inside tmux', () => {
    const p = planLaunch(CMD, { TMUX: '/tmp/tmux-1/default,1,0' }, 'linux')!;
    expect(p.cmd).toBe('tmux');
    expect(p.args.at(-1)).toBe("'/usr/bin/node' '/opt/vibe break/dist/cli/index.js' 'play' '--from-hook'");
  });

  it('uses iTerm2 or Terminal.app on macOS', () => {
    expect(planLaunch(CMD, { TERM_PROGRAM: 'iTerm.app' }, 'darwin')!.target).toContain('iTerm2');
    const t = planLaunch(CMD, {}, 'darwin')!;
    expect(t.cmd).toBe('osascript');
    expect(t.args[1]).toContain('do script');
  });

  it('uses $TERMINAL or x-terminal-emulator on Linux desktops, nothing headless', () => {
    expect(planLaunch(CMD, { TERMINAL: 'kitty' }, 'linux')).toMatchObject({ cmd: 'kitty', args: ['-e', ...CMD] });
    expect(planLaunch(CMD, { DISPLAY: ':0' }, 'linux')!.cmd).toBe('x-terminal-emulator');
    expect(planLaunch(CMD, {}, 'linux')).toBeNull();
  });

  it('shell-quotes safely', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe('autoLaunch', () => {
  const env = { TMUX: 'x' };

  it('launches once, then waits out the minimum gap', () => {
    const dir = tmp();
    const runs: LaunchPlan[] = [];
    const run = (p: LaunchPlan) => { runs.push(p); };
    expect(autoLaunch({ dir, env, platform: 'linux', now: 1_000_000, run })).toBe('launched');
    expect(autoLaunch({ dir, env, platform: 'linux', now: 1_030_000, run })).toBe('too-soon');
    expect(autoLaunch({ dir, env, platform: 'linux', now: 1_061_000, run })).toBe('launched');
    expect(runs).toHaveLength(2);
    expect(runs[0].args.at(-1)).toContain("'play' '--from-hook'");
  });

  it('passes the duration through', () => {
    const runs: LaunchPlan[] = [];
    autoLaunch({ dir: tmp(), env, platform: 'linux', durationSec: 20, run: (p) => { runs.push(p); } });
    expect(runs[0].args.at(-1)).toContain("'--duration' '20'");
  });

  it('never opens a second copy while one is running', () => {
    const dir = tmp();
    const release = acquireArcadeLock(lockPath(dir));
    expect(arcadeRunning(lockPath(dir))).toBe(true);
    expect(autoLaunch({ dir, env, platform: 'linux', run: () => {} })).toBe('already-running');
    release();
    expect(arcadeRunning(lockPath(dir))).toBe(false);
  });

  it('ignores a stale lock from a dead process', () => {
    const dir = tmp();
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    expect(arcadeRunning(lockPath(dir))).toBe(false);
  });

  it('reports when no terminal is available, and swallows spawn failures', () => {
    expect(autoLaunch({ dir: tmp(), env: {}, platform: 'linux', run: () => {} })).toBe('no-terminal');
    expect(autoLaunch({ dir: tmp(), env, platform: 'linux', run: () => { throw new Error('nope'); } })).toBe('failed');
  });

  it('hook outcomes identify the new-turn event that triggers a launch', async () => {
    const dir = tmp();
    expect((await runHook(Readable.from([JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' })]), dir, 1000, 1000)).event?.name).toBe('Stop');
    const out = await runHook(Readable.from([JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' })]), dir, 1000, 2000);
    expect(out).toMatchObject({ event: { name: 'UserPromptSubmit', sessionId: 's1' }, to: 'THINKING' });
  });

  it('passes the triggering agent session to the launched arcade', () => {
    const runs: LaunchPlan[] = [];
    autoLaunch({ dir: tmp(), env, platform: 'linux', sessionId: 'abc-123', run: (p) => { runs.push(p); } });
    expect(runs[0].args.at(-1)).toContain("'--agent-session' 'abc-123'");
    const bad: LaunchPlan[] = [];
    autoLaunch({ dir: tmp(), env, platform: 'linux', sessionId: 'x; rm -rf /', run: (p) => { bad.push(p); } });
    expect(bad[0].args.at(-1)).not.toContain('--agent-session');
  });
});

describe('launch configuration', () => {
  it('snippet puts --launch only on UserPromptSubmit', () => {
    const s = JSON.parse(hookSnippet('vb hook', 'vb hook --launch'));
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe('vb hook --launch');
    expect(s.hooks.Stop[0].hooks[0].command).toBe('vb hook');
    expect(s.hooks.UserPromptSubmit[0].hooks[0].async).toBe(true);
  });

  it('parses --launch and --from-hook', () => {
    expect(parseArgs(['hook', '--launch', '--duration', '20'])).toMatchObject({ command: 'hook', launch: true, duration: 20, rest: [] });
    expect(parseArgs(['play', '--from-hook']).fromHook).toBe(true);
    expect(parseArgs(['play', '--agent-session', 'abc']).agentSession).toBe('abc');
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor', json: true });
  });
});
