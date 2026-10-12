import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaseGame } from '../src/core/base-game.js';
import { generateSession } from '../src/core/session.js';
import { recordRound } from '../src/core/progression.js';
import { sessionTiming, type GameDefinition, type HudItem } from '../src/core/types.js';
import { GAMES, RETIRED_GAMES, findGame } from '../src/games/index.js';
import { BugBash } from '../src/games/bugbash.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore, defaultSave, normalizeSave } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
import { parseArgs } from '../src/cli/args.js';
import { LanServer } from '../src/net/server.js';
import { LanClient } from '../src/net/client.js';
import { ch, ctx, FakeScheduler } from './helpers.js';

/** A minimal game that counts its ticks, to observe the base clock. */
class Ticker extends BaseGame {
  readonly minSize = { width: 10, height: 3 };
  ticks = 0;
  protected tick(): void { this.ticks++; }
  protected onKey(): void { this.addScore(1); }
  render(): string[] { return ['tick']; }
  hud(): HudItem[] { return []; }
  protected stats() { return {}; }
  protected metrics(): Array<[string, string]> { return []; }
  protected isPerfect() { return false; }
}

describe('untimed rounds (base game clock)', () => {
  it('timed rounds still expire on their deadline', () => {
    const g = new Ticker(ctx('t', { durationMs: 5000 }));
    for (let i = 0; i < 49; i++) g.update(100);
    expect(g.isOver()).toBe(false);
    expect(g.timeLeftMs()).toBe(100);
    g.update(100);
    expect(g.result().endReason).toBe('time');
  });

  it('untimed rounds have no countdown and never time out, but keep ticking', () => {
    const g = new Ticker({ ...ctx('u'), durationMs: null });
    expect(g.timeLeftMs()).toBeNull();
    expect(g.timed).toBe(false);
    for (let i = 0; i < 36_000; i++) g.update(100); // an hour
    expect(g.isOver()).toBe(false);
    expect(g.ticks).toBe(36_000); // animation / physics updates never stop
    expect(g.score).toBe(0); // and time alone is worth nothing
    g.forceEnd('quit');
    expect(g.result().endReason).toBe('quit');
  });

  it('no built-in game ever ends with "time" when untimed', () => {
    for (const def of GAMES.filter((d) => d.untimed)) {
      const g = def.create({ ...ctx(`u-${def.id}`), durationMs: null });
      expect(g.timeLeftMs(), def.id).toBeNull();
      for (let t = 0; t < 10 * 60_000 && !g.isOver(); t += 50) g.update(50);
      if (g.isOver()) expect(g.result().endReason, def.id).not.toBe('time');
      g.dispose();
    }
  });

  it('Bug Bash gets lives instead of a clock when untimed', () => {
    const g = new BugBash({ ...ctx('bb'), durationMs: null });
    const before = (g as unknown as { elapsedMs: number }).elapsedMs;
    for (let i = 0; i < 4; i++) g.handleInput(ch('q')); // misses on an empty board
    expect((g as unknown as { elapsedMs: number }).elapsedMs).toBe(before); // no time to lose
    expect(g.isOver()).toBe(false);
    g.handleInput(ch('q'));
    expect(g.result().endReason).toBe('gameover');
  });
});

describe('untimed sessions', () => {
  it('are reproducible: same seed, same round, only the deadline differs', () => {
    const timed = generateSession(GAMES, { seed: 'SAME', untimed: false });
    const untimed = generateSession(GAMES, { seed: 'SAME', untimed: true });
    expect(untimed.durationMs).toBeNull();
    expect(sessionTiming(untimed)).toBe('untimed');
    expect(sessionTiming(timed)).toBe('timed');
    expect({ ...untimed, durationMs: 0 }).toEqual({ ...timed, durationMs: 0 });
  });

  it('the daily challenge stays timed, with an explanation', () => {
    const s = generateSession(GAMES, { daily: '2026-10-12', untimed: true });
    expect(s.durationMs).toBeGreaterThan(0);
    expect(s.timingNote).toMatch(/daily challenge is always timed/);
  });

  it('games without an untimed mode fall back to timed', () => {
    const timedOnly: GameDefinition = { ...findGame('snake')!, id: 'timed-only', name: 'Timed Only', untimed: false };
    const s = generateSession([timedOnly], { untimed: true });
    expect(s.durationMs).toBe(45_000);
    expect(s.timingNote).toMatch(/Timed Only has no untimed mode/);
  });

  it('modifiers are rolled the same way for timed and untimed rounds', () => {
    for (let i = 0; i < 50; i++) {
      const a = generateSession(GAMES, { seed: `m${i}` });
      const b = generateSession(GAMES, { seed: `m${i}`, untimed: true });
      expect(b.modifierId).toBe(a.modifierId);
    }
  });

  it('untimed rounds keep separate personal bests', () => {
    const save = defaultSave();
    const def = findGame('snake')!;
    const timed = generateSession(GAMES, { gameId: 'snake', seed: 'A' });
    const untimed = generateSession(GAMES, { gameId: 'snake', seed: 'A', untimed: true });
    const result = (score: number) => ({ score, endReason: 'gameover' as const, stats: {}, metrics: [], perfect: false });
    recordRound(save, def, timed, result(100), 1000, ['snake']);
    const s2 = recordRound(save, def, untimed, result(5000), 1000, ['snake']);
    expect(s2.newHighScore).toBe(true);
    expect(save.highScores.snake.score).toBe(100);
    expect(save.untimedScores.snake.score).toBe(5000);
    expect(save.history.at(-1)).toMatchObject({ untimed: true });
  });

  it('old saves load as timed and keep their history (including retired games)', () => {
    const old = normalizeSave({ version: 1, highScores: { codesprint: { score: 900, at: 'x', seed: 'y' } }, achievements: { 'touch-typist': '2026-01-01' } });
    expect(old.settings.timing).toBe('timed');
    expect(old.highScores.codesprint.score).toBe(900);
    expect(old.achievements['touch-typist']).toBe('2026-01-01');
  });
});

describe('Code Sprint is retired', () => {
  it('is not playable or randomly picked, and says what replaced it', () => {
    expect(GAMES.map((g) => g.id)).not.toContain('codesprint');
    expect(GAMES.map((g) => g.id)).toContain('ski');
    expect(findGame('codesprint')).toBeUndefined();
    expect(RETIRED_GAMES.codesprint).toMatch(/Ski Survival/);
    for (let i = 0; i < 200; i++) expect(generateSession(GAMES, { seed: `r${i}` }).gameId).not.toBe('codesprint');
    expect(findGame('skiing')!.id).toBe('ski');
  });
});

describe('timing on the command line', () => {
  it('parses --no-timer, --timer and --mode', () => {
    expect(parseArgs(['play', '--game', 'snake', '--no-timer'])).toMatchObject({ command: 'play', timing: 'untimed' });
    expect(parseArgs(['play', '--game', 'tetris', '--untimed']).timing).toBe('untimed');
    expect(parseArgs(['play', '--game', 'skiing', '--mode', 'endless'])).toMatchObject({ game: 'skiing', timing: 'untimed' });
    expect(parseArgs(['play', '--mode', 'sprint']).timing).toBe('timed');
    expect(parseArgs(['--no-timer']).command).toBe('play');
    expect(parseArgs(['play', '--timer']).timing).toBe('timed');
    expect(parseArgs(['play']).timing).toBeUndefined();
    expect(parseArgs(['play', '--no-timer', '--timer']).error).toMatch(/Conflicting/);
    expect(parseArgs(['play', '--no-timer', '--duration', '30']).error).toMatch(/cannot be combined/);
    expect(parseArgs(['play', '--mode', 'forever']).error).toMatch(/Invalid mode/);
  });
});

describe('timing in the arcade', () => {
  function setup(start: ConstructorParameters<typeof App>[0]['start'] = { mode: 'menu' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-timing-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, start, scheduler: sched });
    void app.run();
    return { app, io, sched, store, text: () => app.frame.map(stripAnsi).join('\n') };
  }

  it('the CLI choice reaches the game (play --game tetris --no-timer)', () => {
    const { app, io, sched, text } = setup({ mode: 'play', session: { gameId: 'tetris', untimed: true } });
    expect(text()).toMatch(/Timer\s+none/);
    io.send('\r');
    expect(app.currentGame!.timeLeftMs()).toBeNull();
    sched.advance(5_000);
    expect(text()).toContain('NO TIMER');
    // Left alone, the stack tops out: the round ends by game over, never by time.
    sched.advance(120_000);
    expect(app.stateKind).toBe('results');
    expect(text()).toContain('GAME OVER');
    expect(text()).not.toContain("TIME'S UP");
  });

  it('the TIMER menu sets the default for Quick Play, saved across runs', () => {
    const { app, io, store, text } = setup();
    expect(text()).toContain('[T] TIMER: ON');
    io.send('t');
    expect(text()).toContain('SESSION MODE');
    io.send('2');
    expect(store.load().data.settings.timing).toBe('untimed');
    expect(text()).toContain('TIMER: OFF (untimed)');
    io.send('1'); // Quick Play
    expect(app.stateKind).toBe('briefing');
    expect(text()).toMatch(/Timer\s+none/);
  });

  it('T in the briefing flips one round; replay keeps that timing', () => {
    const { app, io, sched, text } = setup({ mode: 'play', session: { gameId: 'stack', seed: 'FLIP' } });
    expect(text()).toMatch(/Time limit\s+45s/);
    io.send('t');
    expect(text()).toMatch(/Timer\s+none/);
    expect(text()).toContain('FLIP');
    io.send('t');
    expect(text()).toMatch(/Time limit\s+45s/);
    io.send('t');
    io.send('\r');
    expect(app.currentGame!.timeLeftMs()).toBeNull();
    io.send('\x1b');
    io.send('q'); // end round
    expect(app.stateKind).toBe('results');
    sched.advance(700);
    io.send('\r'); // replay
    expect(text()).toMatch(/Timer\s+none/);
  });

  it('no countdown warning ever appears in an untimed round', () => {
    const { io, sched, text } = setup({ mode: 'play', session: { gameId: 'dungeon', untimed: true, seed: 'D' } });
    io.send('\r');
    sched.advance(70_000);
    expect(text()).not.toMatch(/Round ends in|TIME \d/);
  });
});

describe('gameplay deadlines vs network timeouts', () => {
  it('a LAN game with all gameplay timers off still drops dead connections', async () => {
    const server = new LanServer({ bind: '127.0.0.1', port: 0, tickMs: 25, idleTimeoutMs: 300, pingIntervalMs: 60_000,
      lobby: { gameId: 'battleship', introMs: 0, options: { turnTime: 0, placeTime: 0 } } });
    await server.start();
    try {
      const c = new LanClient({ host: '127.0.0.1', port: server.port, name: 'Quiet', reconnectWindowMs: 0, idleTimeoutMs: 60_000 });
      await c.connect();
      expect(server.lobby.state().options).toMatchObject({ turnTime: 0, placeTime: 0 });
      // The client goes silent (no pongs because the server never pings in this setup).
      const closed = new Promise<string>((r) => c.once('closed', r));
      expect(await closed).toBeTruthy();
      expect(server.lobby.memberCount).toBeLessThanOrEqual(1);
    } finally {
      await server.close();
    }
  });
});
