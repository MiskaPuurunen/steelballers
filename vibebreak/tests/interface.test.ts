import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CHILD_ENV, chooseInterface, childCommand, openStandalone } from '../src/cli/interface.js';
import { INTERFACES, describeTerminal, isInterfaceMode } from '../src/core/interfaces.js';
import { planLaunch, type LaunchPlan } from '../src/integrations/launcher.js';
import { parseArgs } from '../src/cli/args.js';
import { normalizeSave, SaveStore } from '../src/storage/save.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { stripAnsi } from '../src/ui/style.js';
import { MENU_ITEMS } from '../src/ui/menu-screens.js';
import { AgentMonitor, recordEvent } from '../src/integrations/agent-status.js';
import { DEFAULT_TIMEOUTS } from '../src/integrations/agent-model.js';
import { FakeScheduler } from './helpers.js';

const tty = { env: {}, platform: 'win32' as const, interactive: true };
const piped = { ...tty, interactive: false };

describe('interfaces: choosing where to run', () => {
  it('the command line beats the saved setting, which beats auto', () => {
    expect(chooseInterface(undefined, undefined, tty)).toMatchObject({ run: 'inline', reason: /auto/ });
    expect(chooseInterface(undefined, 'standalone', tty)).toMatchObject({ run: 'window', reason: /saved setting/ });
    expect(chooseInterface('terminal', 'standalone', tty)).toMatchObject({ run: 'inline', reason: /--interface/ });
    expect(chooseInterface('standalone', 'terminal', tty)).toMatchObject({ run: 'window', reason: /--interface/ });
  });

  it('auto never opens a window by itself, even without a terminal', () => {
    expect(chooseInterface('auto', undefined, piped)).toMatchObject({ run: 'inline', reason: /--standalone/ });
    expect(chooseInterface(undefined, 'auto', piped).run).toBe('inline');
  });

  it('a window we opened never opens another (recursion guard)', () => {
    const child = { ...tty, env: { [CHILD_ENV]: '1' } };
    expect(chooseInterface('standalone', 'standalone', child).run).toBe('inline');
    // The guard doesn't depend on the environment: the command line forces the terminal.
    const cmd = childCommand(['play', '--game', 'snake', '--interface', 'standalone'], 'node', '/x/dist/cli/index.js');
    expect(cmd).toEqual(['node', '/x/dist/cli/index.js', 'play', '--game', 'snake', '--interface', 'terminal', '--window']);
    expect(parseArgs(cmd.slice(2))).toMatchObject({ interface: 'terminal', window: true, command: 'play' });
    for (const flag of [['--standalone'], ['--interface=standalone'], ['-i', 'auto']]) {
      const c = childCommand(flag, 'node', '/x/cli/index.js');
      expect(c.filter((a) => a === '--interface')).toHaveLength(1);
      expect(c.at(-2)).toBe('terminal');
    }
    expect(childCommand([], 'node', '/x/src/cli/index.ts').slice(0, 4)).toEqual(['node', '--import', 'tsx', '/x/src/cli/index.ts']);
  });

  it('names the terminal it runs in, VS Code included', () => {
    expect(describeTerminal({ TERM_PROGRAM: 'vscode' }, 'win32')).toMatch(/VS Code/);
    expect(describeTerminal({ WT_SESSION: 'x' }, 'win32')).toBe('Windows Terminal');
    expect(describeTerminal({}, 'win32')).toMatch(/Windows console/);
    expect(describeTerminal({ TMUX: '1' }, 'linux')).toBe('tmux');
    expect(INTERFACES.map((i) => i.id)).toEqual(['auto', 'terminal', 'standalone']);
    expect(isInterfaceMode('window')).toBe(false);
  });
});

describe('interfaces: opening a standalone window (mocked, nothing really opens)', () => {
  const started: Array<{ plan: LaunchPlan; env: NodeJS.ProcessEnv }> = [];
  const start = async (plan: LaunchPlan, env: NodeJS.ProcessEnv) => { started.push({ plan, env }); };

  it('opens a new window on Windows and marks the child', async () => {
    started.length = 0;
    const r = await openStandalone(['play'], { env: {}, platform: 'win32', start, running: () => false });
    expect(r).toEqual({ ok: true, target: 'new console window' });
    expect(started[0].plan.cmd).toBe('cmd.exe');
    expect(started[0].plan.args.at(-1)).toMatch(/^start "VibeBreak" .*"--interface" "terminal" "--window"$/);
    expect(started[0].env[CHILD_ENV]).toBe('1');
    const wt = await openStandalone([], { env: { WT_SESSION: 'x' }, platform: 'win32', start, running: () => false });
    expect(wt).toEqual({ ok: true, target: 'new Windows Terminal window' });
    expect(started[1].plan.args.slice(0, 2)).toEqual(['-w', 'new']);
  });

  it('never opens a second arcade', async () => {
    started.length = 0;
    const r = await openStandalone([], { env: {}, platform: 'win32', start, running: () => true });
    expect(r).toMatchObject({ ok: false, why: 'already-running' });
    expect(started).toHaveLength(0);
  });

  it('explains when there is no desktop to open a window on', async () => {
    const r = await openStandalone([], { env: {}, platform: 'linux', start, running: () => false });
    expect(r).toMatchObject({ ok: false, why: 'no-terminal', message: /VIBEBREAK_TERMINAL/ });
  });

  it('reports a terminal that fails to start instead of throwing', async () => {
    const r = await openStandalone([], { env: {}, platform: 'win32', start: async () => { throw new Error('spawn cmd.exe ENOENT'); }, running: () => false });
    expect(r).toMatchObject({ ok: false, why: 'failed', message: /ENOENT/ });
  });

  it('window plans per platform; the agent hook still prefers a split pane', () => {
    const cmd = ['node', 'cli.js'];
    expect(planLaunch(cmd, { TMUX: '1' }, 'linux', 'window')?.args[0]).toBe('new-window');
    expect(planLaunch(cmd, { TMUX: '1' }, 'linux')?.args[0]).toBe('split-window');
    expect(planLaunch(cmd, { WT_SESSION: '1' }, 'win32')?.args).toContain('split-pane');
    expect(planLaunch(cmd, { TERM_PROGRAM: 'iTerm.app' }, 'darwin', 'window')?.target).toBe('new Terminal.app window');
    expect(planLaunch(cmd, { DISPLAY: ':0' }, 'linux', 'window')?.cmd).toBe('x-terminal-emulator');
  });
});

describe('interfaces: command line and saved preference', () => {
  it('parses --interface, -i, --standalone and --list-interfaces', () => {
    expect(parseArgs(['--interface', 'standalone'])).toMatchObject({ command: 'menu', interface: 'standalone' });
    expect(parseArgs(['-i', 'TERMINAL']).interface).toBe('terminal');
    expect(parseArgs(['--interface=auto']).interface).toBe('auto');
    expect(parseArgs(['--standalone']).interface).toBe('standalone');
    expect(parseArgs(['--list-interfaces']).command).toBe('interfaces');
    expect(parseArgs(['interfaces']).command).toBe('interfaces');
    expect(parseArgs(['--interface', 'browser']).error).toMatch(/Invalid interface "browser"/);
    expect(parseArgs(['play', '--game', 'snake', '--interface', 'standalone'])).toMatchObject({ command: 'play', interface: 'standalone' });
  });

  it('the saved preference defaults to auto and rejects junk', () => {
    const base = { version: 1, settings: {} };
    expect(normalizeSave(base).settings.interface).toBe('auto');
    expect(normalizeSave({ ...base, settings: { interface: 'standalone' } }).settings.interface).toBe('standalone');
    expect(normalizeSave({ ...base, settings: { interface: 'electron' } }).settings.interface).toBe('auto');
    expect(normalizeSave({ ...base, settings: { interface: 42 } }).settings.interface).toBe('auto');
  });
});

describe('every standard launch opens the main menu', () => {
  it('no flag combination short of choosing a game starts one', () => {
    for (const argv of [[], ['--interface', 'terminal'], ['--interface', 'standalone'], ['--interface', 'auto'], ['--no-timer'], ['--timer'],
      ['--duration', '30'], ['--interface', 'terminal', '--from-hook', '--duration', '45', '--agent-session', 'abc'], ['--theme', 'matrix']]) {
      expect(parseArgs(argv).command, argv.join(' ')).toBe('menu');
    }
    // Explicit direct launches keep working.
    expect(parseArgs(['play', '--game', 'snake']).command).toBe('play');
    expect(parseArgs(['--game', 'snake']).command).toBe('play');
    expect(parseArgs(['daily']).command).toBe('daily');
  });

  function arcade(extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-iface-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    let wall = 1_700_000_000_000;
    const agentDir = path.join(dir, 'agent');
    const app = new App({
      io, store, save: store.load().data, start: { mode: 'menu' }, scheduler: sched, wallNow: () => wall,
      agent: new AgentMonitor(agentDir, { timeouts: DEFAULT_TIMEOUTS }),
      agentInfo: () => ({ install: null, health: null }),
      version: '9.9.9',
      ...extra,
    });
    const done = app.run();
    const text = () => app.frame.map(stripAnsi).join('\n');
    const event = (name: string, more: object = {}) => recordEvent({ name, sessionId: 'sess-9', at: wall, agent: 'claude-code', project: 'proj', ...more }, agentDir);
    const advance = (ms: number) => { wall += ms; sched.advance(ms); };
    return { app, io, store, sched, text, event, advance, done };
  }

  it('shows the menu and waits, even with a busy agent and a saved untimed preference', () => {
    const { app, text, event, advance, store } = arcade();
    const save = store.load().data;
    save.settings.timing = 'untimed';
    store.save(save);
    event('UserPromptSubmit');
    event('PreToolUse', { toolName: 'Bash', toolUseId: 't' });
    advance(30_000);
    expect(app.stateKind).toBe('menu');
    expect(app.currentGame).toBeNull();
    for (const item of MENU_ITEMS) expect(text()).toContain(`[${item.key}] ${item.label}`);
    expect(text()).toMatch(/AI WORKING/);
    expect(app.frame.length).toBeLessThanOrEqual(24);
  });

  it('every menu entry opens its screen and Esc comes back to the menu', () => {
    const { app, io, text, sched } = arcade();
    const expected: Record<string, [string, RegExp]> = {
      '2': ['arcade', /ARCADE/], '4': ['multiplayer', /MULTIPLAYER/], '6': ['stats', /STATS & ACHIEVEMENTS/],
      '7': ['agent', /AGENT STATUS/], '8': ['settings', /SETTINGS/], '9': ['help', /HELP & ABOUT.*9\.9\.9/s],
    };
    for (const [key, [kind, title]] of Object.entries(expected)) {
      io.send(key);
      expect(app.stateKind, key).toBe(kind);
      expect(text()).toMatch(title);
      for (const l of app.frame) expect(stripAnsi(l).length, `${kind} fits 80 columns`).toBeLessThanOrEqual(80);
      io.send('\x1b');
      sched.advance(200);
      expect(app.stateKind, `back from ${kind}`).toBe('menu');
      // The menu comes back with that entry highlighted.
      expect(text()).toMatch(new RegExp(`> +\\[${key}\\]`));
    }
    io.send('1'); // Quick Play: the existing random pick, via the briefing
    expect(app.stateKind).toBe('briefing');
  });

  it('the agent screen reads the same state as the HUD line', () => {
    const { io, text, event, advance } = arcade();
    event('UserPromptSubmit');
    event('PreToolUse', { toolName: 'Bash', toolUseId: 't' });
    advance(600);
    const hud = /AI WORKING[^\n]*/.exec(text())![0].trim().split(/\s{2,}/)[0];
    io.send('7');
    expect(text()).toContain(hud);
    expect(text()).toMatch(/Status\s+WORKING/);
    expect(text()).toMatch(/Session\s+proj/);
    expect(text()).toMatch(/never answers\s+prompts,\s+approves\s+tools/);
    event('Stop');
    advance(600);
    io.send('r');
    expect(text()).toMatch(/Status\s+COMPLETED/);
  });

  it('settings change and persist; nothing is written when nothing changes', () => {
    const { app, io, store, text } = arcade();
    io.send('8');
    const file = store.file;
    const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    io.send('\x1b[B'); // moving around writes nothing
    io.send('\x1b[A');
    expect(fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0).toBe(before);
    io.send('\x1b[C'); // Interface: auto -> terminal
    expect(store.load().data.settings.interface).toBe('terminal');
    io.send('\x1b[C');
    expect(store.load().data.settings.interface).toBe('standalone');
    expect(text()).toMatch(/Interface\s+< standalone >/);
    io.send('\x1b[D');
    expect(store.load().data.settings.interface).toBe('terminal');
    expect(app.stateKind).toBe('settings');
  });

  it('--duration from the agent hook sets menu rounds; returning from a game lands in the menu; quitting leaks nothing', async () => {
    const { app, io, sched, done, store } = arcade({ durationSec: 20, countdownMs: 100 });
    io.send('2');
    io.send('5'); // Stack Overflow from the games list
    expect(app.stateKind).toBe('briefing');
    sched.advance(200);
    expect(app.currentGame!.timeLeftMs()).toBeLessThanOrEqual(20_000);
    sched.advance(21_000);
    expect(app.stateKind).toBe('results');
    sched.advance(700);
    io.send('m');
    expect(app.stateKind).toBe('menu');
    expect(store.load().data.rounds).toBe(1);
    io.send('q');
    await done;
    expect(app.timerActive).toBe(false);
    expect(io.stopped).toBe(true);
  });
});

describe('the real CLI process', () => {
  const ROOT = path.resolve(__dirname, '..');
  function cli(args: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-iface-cli-'));
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: ROOT, env: { ...process.env, VIBEBREAK_HOME: home, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    return new Promise<{ code: number; out: string }>((resolve) => p.on('exit', (code) => resolve({ code: code ?? -1, out })));
  }

  it('without a terminal, auto explains instead of opening a window; --list-interfaces reports', async () => {
    const [auto, list] = await Promise.all([cli([]), cli(['--list-interfaces'])]);
    expect(auto.code).toBe(1);
    expect(auto.out).toMatch(/needs an interactive terminal/);
    expect(auto.out).toMatch(/--standalone/);
    expect(auto.out).not.toMatch(/opened in a/);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/auto\s+the current terminal/);
    expect(list.out).toMatch(/standalone\s+a new terminal window/);
    expect(list.out).toMatch(/would stop and explain/);
  }, 30_000);
});
