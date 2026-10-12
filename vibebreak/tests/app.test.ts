import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
import { FakeScheduler } from './helpers.js';
import { GAMES } from '../src/games/index.js';
import { AgentMonitor, recordEvent } from '../src/integrations/agent-status.js';
import { DEFAULT_TIMEOUTS } from '../src/integrations/agent-model.js';

function setup(start: ConstructorParameters<typeof App>[0]['start'] = { mode: 'menu' }, cols = 100, rows = 34) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-app-'));
  const store = new SaveStore(path.join(dir, 'save.json'));
  const io = new FakeTerminal(cols, rows);
  const sched = new FakeScheduler();
  const app = new App({ io, store, save: store.load().data, start, scheduler: sched });
  const done = app.run();
  const text = () => app.frame.map(stripAnsi).join('\n');
  return { app, io, sched, store, done, text };
}

describe('App flow', () => {
  it('menu -> quick play -> round ends on time -> results -> quit', async () => {
    const { app, io, sched, store, done, text } = setup();
    expect(io.started).toBe(true);
    expect(text()).toContain('QUICK PLAY');
    io.send('1');
    expect(app.stateKind).toBe('briefing');
    expect(text()).toMatch(/Seed\s+\S+/);
    sched.advance(4100); // countdown auto-starts the round
    expect(app.stateKind).toBe('playing');
    expect(text()).toContain('SCORE');
    sched.advance(Math.max(...GAMES.map((g) => g.defaultDurationSec)) * 1000 + 1000);
    expect(app.stateKind).toBe('results');
    expect(text()).toMatch(/TIME'S UP|GAME OVER|OBJECTIVE COMPLETE/);
    sched.advance(700); // input lock expires
    io.send('q');
    const info = await done;
    expect(io.stopped).toBe(true);
    expect(app.timerActive).toBe(false);
    expect(store.load().data.rounds).toBe(1);
    expect(info.messages.join('\n')).toContain('Back to Work');
  });

  it('Ctrl+C exits immediately from any state and clears the loop', async () => {
    const { app, io, done } = setup({ mode: 'play', session: { gameId: 'snake', seed: 'X' } });
    io.send('\r');
    expect(app.stateKind).toBe('playing');
    io.send('\x03');
    await done;
    expect(io.stopped).toBe(true);
    expect(app.timerActive).toBe(false);
  });

  it('Esc pauses and freezes the game clock; end round goes to results', () => {
    const { app, io, sched, text } = setup({ mode: 'play', session: { gameId: 'stack', seed: 'P' } });
    io.send('\r');
    sched.advance(1000);
    io.send('\x1b');
    expect(text()).toContain('PAUSED');
    const left = app.currentGame!.timeLeftMs();
    sched.advance(5000);
    expect(app.currentGame!.timeLeftMs()).toBe(left);
    io.send('q');
    expect(app.stateKind).toBe('results');
    expect(text()).toContain('ROUND ENDED EARLY');
  });

  it('restart from pause starts a fresh instance with the same seed', () => {
    const { app, io, sched } = setup({ mode: 'play', session: { gameId: 'bugbash', seed: 'R' } });
    io.send('\r');
    sched.advance(3000);
    const first = app.currentGame;
    io.send('\x1b');
    io.send('r');
    expect(app.currentGame).not.toBe(first);
    expect(app.currentGame!.timeLeftMs()).toBe(30_000);
  });

  it('results ignore mashed keys for a moment, then replay', () => {
    const { app, io, sched } = setup({ mode: 'play', session: { gameId: 'stack', seed: 'M', durationSec: 15 } });
    io.send('\r');
    sched.advance(15_100);
    expect(app.stateKind).toBe('results');
    io.send('\r');
    expect(app.stateKind).toBe('results');
    sched.advance(700);
    io.send('\r');
    expect(app.stateKind).toBe('briefing');
  });

  it('reroll offers a different game', () => {
    const { app, io, text } = setup({ mode: 'play', session: { gameId: 'snake', seed: 'RR' } });
    expect(text()).toContain('TERMINAL SNAKE');
    io.send('r');
    expect(app.stateKind).toBe('briefing');
    expect(text()).not.toContain('TERMINAL SNAKE');
  });

  it('pauses the game when the terminal is too small, resumes after resize', () => {
    const { app, io, sched, text } = setup({ mode: 'play', session: { gameId: 'snake', seed: 'S' } });
    io.send('\r');
    io.resize(50, 20);
    sched.advance(100);
    expect(text().toLowerCase()).toContain('too small');
    const left = app.currentGame!.timeLeftMs();
    sched.advance(2000);
    expect(app.currentGame!.timeLeftMs()).toBe(left);
    io.resize(100, 34);
    sched.advance(500);
    expect(app.currentGame!.timeLeftMs()).toBeLessThan(left!);
  });

  it('arcade, stats and daily screens render', () => {
    const { app, io, text } = setup();
    io.send('2');
    expect(text()).toContain('ARCADE');
    expect(text()).toContain('Dependency Dungeon');
    io.send('\x1b');
    io.send('4');
    expect(text()).toContain('ACHIEVEMENTS');
    io.send('\x1b');
    io.send('3');
    expect(text()).toContain('DAILY CHALLENGE');
    expect(text()).not.toContain('[R] reroll');
    expect(app.stateKind).toBe('briefing');
  });

  it('stats reset needs a double confirmation', () => {
    const { io, store, sched } = setup({ mode: 'play', session: { gameId: 'stack', seed: 'Z', durationSec: 15 } });
    io.send('\r');
    sched.advance(16_000);
    sched.advance(700);
    io.send('m');
    io.send('4');
    io.send('x');
    expect(store.load().data.rounds).toBe(1);
    io.send('x');
    expect(store.load().data.rounds).toBe(0);
  });

  it('only redraws changed lines (no full-screen flicker per frame)', () => {
    // A turn-based game: nothing moves between key presses.
    const { io, sched } = setup({ mode: 'play', session: { gameId: 'dungeon', seed: 'F' } });
    io.send('\r');
    sched.advance(200);
    const before = io.output.length;
    sched.advance(33);
    const perFrame = io.output.length - before;
    expect(perFrame).toBeLessThan(400); // just the timer/HUD row at most
  });
});

describe('App at 80x24', () => {
  it('every screen fits without truncating the key hints', () => {
    const { io, sched, text } = setup({ mode: 'menu' }, 80, 24);
    expect(text()).toContain('[Q] quit');
    io.send('4');
    expect(text()).toContain('[Esc] back');
    io.send('\x1b');
    io.send('2');
    expect(text()).toContain('[Esc] back');
    io.send('5'); // Dependency Dungeon, the tallest game
    expect(text()).toContain('[R] reroll');
    io.send('\r');
    sched.advance(100);
    expect(text()).toContain('[Esc] pause');
    expect(text().toLowerCase()).not.toContain('too small');
  });
});

describe('AI status in the arcade', () => {
  function withAgent(start: ConstructorParameters<typeof App>[0]['start']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-app-agent-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    const io = new FakeTerminal(100, 34);
    const sched = new FakeScheduler();
    let wall = 1_700_000_000_000;
    const agentDir = path.join(dir, 'agent');
    const app = new App({ io, store, save: store.load().data, start, scheduler: sched, agent: new AgentMonitor(agentDir, { timeouts: DEFAULT_TIMEOUTS }), wallNow: () => wall });
    void app.run();
    const text = () => app.frame.map(stripAnsi).join('\n');
    const event = (name: string, extra: object = {}) => recordEvent({ name, sessionId: 'sess-1', at: wall, agent: 'claude-code', project: 'myapp', ...extra }, agentDir);
    const advance = (ms: number) => { wall += ms; sched.advance(ms); };
    return { app, io, text, event, advance };
  }

  it('16. status updates reach the screen with no key pressed', () => {
    const { app, io, text, event, advance } = withAgent({ mode: 'play', session: { gameId: 'snake', seed: 'AI-1' } });
    advance(4100);
    expect(app.stateKind).toBe('playing');
    expect(text()).toContain('no agent activity seen');
    event('UserPromptSubmit');
    const writesBefore = io.output.length;
    advance(600);
    expect(text()).toMatch(/AI THINKING/);
    expect(text()).toContain('myapp');
    event('PreToolUse', { toolName: 'Bash', toolUseId: 't1' });
    advance(600);
    expect(text()).toMatch(/AI WORKING\s.*running Bash/);
    event('PermissionRequest', { toolName: 'Edit' });
    advance(600);
    expect(text()).toMatch(/NEEDS YOU/);
    event('Stop');
    advance(600);
    expect(text()).toMatch(/AI DONE/);
    expect(io.output.length).toBeGreaterThan(writesBefore);
    expect(app.agentView).toMatchObject({ status: 'COMPLETED', certainty: 'reported' });
  });

  it('a silent turn is shown as inferred, then unknown, never done', () => {
    const { app, text, event, advance } = withAgent({ mode: 'menu' });
    event('UserPromptSubmit');
    advance(600);
    expect(text()).toMatch(/AI THINKING/);
    advance(DEFAULT_TIMEOUTS.quietMs);
    expect(text()).toMatch(/AI THINKING\?/);
    advance(DEFAULT_TIMEOUTS.lostMs);
    expect(app.agentView).toMatchObject({ status: 'UNKNOWN', certainty: 'inferred' });
    expect(text()).not.toMatch(/AI DONE/);
  });

  it('the status line never displaces the game board', () => {
    const { app, text, event, advance } = withAgent({ mode: 'play', session: { gameId: 'tetris', seed: 'AI-2' } });
    advance(4100);
    const before = app.frame.length;
    const boardTop = app.frame.findIndex((l) => stripAnsi(l).includes('NEXT'));
    event('PreToolUse', { toolName: 'A-really-long-tool-name-that-goes-on-and-on-and-on-mcp__server__tool', toolUseId: 'x' });
    advance(600);
    expect(app.frame.length).toBe(before);
    expect(app.frame.findIndex((l) => stripAnsi(l).includes('NEXT'))).toBe(boardTop);
    for (const l of app.frame) expect(stripAnsi(l).length).toBeLessThanOrEqual(100);
    expect(text()).toMatch(/AI WORKING/);
  });
});

describe('per-game arcade keys (Tetris)', () => {
  it('P pauses and resumes, R restarts, Q ends the round', () => {
    const { app, io, sched } = setup({ mode: 'play', session: { gameId: 'tetris', seed: 'TET-1' } });
    sched.advance(4100);
    const first = app.currentGame!;
    io.send('p');
    expect(app.frame.map(stripAnsi).join('\n')).toContain('PAUSED');
    const t = first.timeLeftMs();
    sched.advance(2000);
    expect(first.timeLeftMs()).toBe(t);
    io.send('p');
    sched.advance(100);
    expect(first.timeLeftMs()).toBeLessThan(t!);
    io.send('r');
    expect(app.currentGame).not.toBe(first);
    io.send('q');
    expect(app.stateKind).toBe('results');
  });

  it('games without arcade shortcuts keep those letters (Q is a Bug Bash hit key)', () => {
    const { app, io, sched } = setup({ mode: 'play', session: { gameId: 'bugbash', seed: 'BB-1' } });
    sched.advance(4100);
    io.send('q');
    expect(app.stateKind).toBe('playing');
  });
});
