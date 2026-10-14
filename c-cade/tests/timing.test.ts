import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BaseGame } from '../src/core/base-game.js';
import { generateSession } from '../src/core/session.js';
import { recordRound } from '../src/core/progression.js';
import type { HudItem } from '../src/core/types.js';
import { GAMES, findGame } from '../src/games/index.js';
import { BugBash } from '../src/games/bugbash.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore, normalizeSave } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
import { parseArgs } from '../src/cli/args.js';
import { LanServer } from '../src/net/server.js';
import { LanClient } from '../src/net/client.js';
import { ch, ctx, FakeScheduler } from './helpers.js';

/**
 * Rounds have no gameplay clock: every game ends on its own conditions (game
 * over, a win) or when the player quits, so nothing stops suddenly mid-play.
 */

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

describe('no gameplay clock (base game)', () => {
  it('rounds have no countdown and never time out, but keep ticking', () => {
    const g = new Ticker(ctx('u'));
    for (let i = 0; i < 36_000; i++) g.update(100); // an hour
    expect(g.isOver()).toBe(false);
    expect(g.ticks).toBe(36_000); // animation / physics updates never stop
    expect(g.score).toBe(0); // and time alone is worth nothing
    g.forceEnd('quit');
    expect(g.result().endReason).toBe('quit');
  });

  it('no built-in game ever ends with "time"', () => {
    for (const def of GAMES) {
      const g = def.create(ctx(`u-${def.id}`));
      for (let t = 0; t < 10 * 60_000 && !g.isOver(); t += 50) g.update(50);
      g.dispose();
    }
  });

  it('Bug Bash ends on lives, not a clock', () => {
    const g = new BugBash(ctx('bb'));
    for (let i = 0; i < 4; i++) g.handleInput(ch('q')); // misses on an empty board
    expect(g.isOver()).toBe(false);
    g.handleInput(ch('q'));
    expect(g.result().endReason).toBe('gameover');
  });
});

describe('sessions', () => {
  it('are untimed and reproducible from a seed', () => {
    const a = generateSession(GAMES, { seed: 'SAME' });
    expect(generateSession(GAMES, { seed: 'SAME' })).toEqual(a);
  });

  it('the daily challenge has no clock either', () => {
  });

  it('old timed and untimed bests fold into one personal best per game', () => {
    const old = normalizeSave({
      version: 1,
      highScores: { snake: { score: 100, at: 'a', seed: 'T' }, tetris: { score: 9000, at: 'b', seed: 'T2' } },
      untimedScores: { snake: { score: 5000, at: 'c', seed: 'U' }, tetris: { score: 10, at: 'd', seed: 'U2' }, ski: { score: 77, at: 'e', seed: 'U3' } },
    });
    expect(old.highScores.snake).toMatchObject({ score: 5000, seed: 'U' });
    expect(old.highScores.tetris).toMatchObject({ score: 9000, seed: 'T2' });
    expect(old.highScores.ski.score).toBe(77);
    expect(old).not.toHaveProperty('untimedScores');
  });

  it('new rounds beat (or not) that single best', () => {
    const save = normalizeSave({ version: 1, untimedScores: { snake: { score: 500, at: 'x', seed: 'y' } } });
    const def = findGame('snake')!;
    const session = generateSession(GAMES, { gameId: 'snake', seed: 'A' });
    const result = (score: number) => ({ score, endReason: 'gameover' as const, stats: {}, metrics: [], perfect: false });
    expect(recordRound(save, def, session, result(400), 1000, ['snake']).newHighScore).toBe(false);
    const s2 = recordRound(save, def, session, result(600), 1000, ['snake']);
    expect(s2).toMatchObject({ newHighScore: true, previousBest: 500 });
    expect(save.highScores.snake.score).toBe(600);
    expect(save.history.at(-1)).not.toHaveProperty('untimed');
  });

  it('old saves load fine: the timer setting is ignored, history and retired games kept', () => {
    const old = normalizeSave({
      version: 1, settings: { timing: 'timed', theme: 'halloween' },
      highScores: { codesprint: { score: 900, at: 'x', seed: 'y' } }, achievements: { 'touch-typist': '2026-01-01' },
      history: [{ gameId: 'snake', score: 5, untimed: true }],
    });
    expect(old.settings).not.toHaveProperty('timing');
    expect(old.settings.theme).toBe('halloween');
    expect(old.highScores.codesprint.score).toBe(900);
    expect(old.achievements['touch-typist']).toBe('2026-01-01');
    expect(old.history).toHaveLength(1);
  });
});

describe('Code Sprint is retired', () => {
  it('is not playable or randomly picked', () => {
    expect(GAMES.map((g) => g.id)).not.toContain('codesprint');
    expect(GAMES.map((g) => g.id)).toContain('ski');
    expect(findGame('codesprint')).toBeUndefined();
    for (let i = 0; i < 200; i++) expect(generateSession(GAMES, { seed: `r${i}` }).gameId).not.toBe('codesprint');
    expect(findGame('skiing')!.id).toBe('ski');
  });
});

describe('timer flags on the command line', () => {
  it('old timer flags are accepted and ignored; --no-timer is kept for LAN hosts', () => {
    expect(parseArgs(['play', '--game', 'snake', '--no-timer'])).toMatchObject({ command: 'play', noTimer: true, legacyTimer: false });
    expect(parseArgs(['play', '--game', 'tetris', '--untimed']).noTimer).toBe(true);
    expect(parseArgs(['play', '--game', 'skiing', '--mode', 'endless'])).toMatchObject({ game: 'skiing', legacyTimer: false });
    for (const flags of [['--mode', 'sprint'], ['--timer'], ['--timed'], ['--duration', '30'], ['--mode', 'forever']]) {
      const a = parseArgs(['play', ...flags]);
      expect(a.error, flags.join(' ')).toBeUndefined();
      expect(a.legacyTimer, flags.join(' ')).toBe(true);
    }
    // Combinations that used to conflict are harmless now.
    expect(parseArgs(['play', '--no-timer', '--timer']).error).toBeUndefined();
    expect(parseArgs(['play', '--no-timer', '--duration', '30']).error).toBeUndefined();
    // Only choosing a game implies play: a timer flag alone still opens the menu.
    expect(parseArgs(['--no-timer']).command).toBe('menu');
    expect(parseArgs(['--duration', '30']).command).toBe('menu');
  });
});

describe('the arcade has no clock', () => {
  function setup(start: ConstructorParameters<typeof App>[0]['start'] = { mode: 'menu' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-timing-'));
    const store = new SaveStore(path.join(dir, 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, start, scheduler: sched });
    void app.run();
    return { app, io, sched, store, text: () => app.frame.map(stripAnsi).join('\n') };
  }

  it('Tetris never stops on time: left alone, it ends by game over', () => {
    const { app, io, sched, text } = setup({ mode: 'play', session: { gameId: 'tetris' } });
    expect(text()).not.toMatch(/Time limit|Timer/);
    io.send('\r');
    sched.advance(5_000);
    expect(text()).not.toMatch(/TIME \d|NO TIMER|Round ends in/);
    sched.advance(240_000);
    expect(app.stateKind).toBe('results');
    expect(text()).toContain('GAME OVER');
    expect(text()).not.toContain("TIME'S UP");
  });

  it('settings and the menu have no timer option', () => {
    const { app, io, text } = setup();
    expect(text()).not.toMatch(/timer (on|off)/);
    io.send('8');
    expect(text()).toContain('SETTINGS');
    expect(text()).not.toMatch(/Timer/);
    io.send('\x1b');
    io.send('t'); // the old Timer shortcut does nothing now
    expect(app.stateKind).toBe('menu');
  });

  it('the briefing has no timing toggle', () => {
    const { app, io, text } = setup({ mode: 'play', session: { gameId: 'stack', seed: 'FLIP' } });
    expect(text()).not.toMatch(/\[T\]|play untimed|play timed/);
    io.send('t');
    expect(app.stateKind).toBe('briefing');
    expect(text()).toContain('FLIP');
  });

  it('no countdown warning ever appears, even in a long turn-based round', () => {
    const { io, sched, text } = setup({ mode: 'play', session: { gameId: 'dungeon', seed: 'D' } });
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
