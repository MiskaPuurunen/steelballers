import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('CLI parsing', () => {
  it('defaults to the menu', () => {
    expect(parseArgs([]).command).toBe('menu');
  });

  it('parses play with options', () => {
    expect(parseArgs(['play', '--game', 'snake', '--seed', 'AB', '--difficulty', 'hard', '-m', 'chaos'])).toMatchObject({
      command: 'play', game: 'snake', seed: 'AB', difficulty: 'hard', modifier: 'chaos', legacyTimer: false,
    });
  });

  it('accepts --flag=value', () => {
    expect(parseArgs(['play', '--seed=K7', '--game=stack'])).toMatchObject({ seed: 'K7', game: 'stack' });
  });

  it('timer flags from older versions are accepted and ignored (rounds have no clock)', () => {
    for (const argv of [['--duration', '30'], ['--duration=45s'], ['--timer'], ['--timed'], ['--mode', 'sprint']]) {
      const a = parseArgs(['play', '--random', ...argv]);
      expect(a.error, argv.join(' ')).toBeUndefined();
      expect(a).toMatchObject({ command: 'play', random: true, legacyTimer: true, rest: [] });
    }
    // Endless is how every game plays now, so these say nothing new.
    expect(parseArgs(['play', '--mode', 'endless']).legacyTimer).toBe(false);
    const noTimer = parseArgs(['play', '--no-timer']);
    expect(noTimer).toMatchObject({ legacyTimer: false, noTimer: true });
    expect(noTimer.error).toBeUndefined();
    expect(parseArgs(['--duration', '30']).command).toBe('menu');
  });

  it('options without a command imply play', () => {
    expect(parseArgs(['--game', 'snake']).command).toBe('play');
  });

  it('recognises every command', () => {
    for (const c of ['list', 'stats', 'daily', 'reset', 'hook', 'help', 'version']) expect(parseArgs([c]).command).toBe(c);
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['hook', 'install']).rest).toEqual(['install']);
  });

  it('reports invalid input', () => {
    expect(parseArgs(['dance']).error).toMatch(/Unknown command/);
    expect(parseArgs(['--bogus']).error).toMatch(/Unknown option/);
    expect(parseArgs(['play', '--duration']).error).toMatch(/needs a value/);
    expect(parseArgs(['play', '--game', '--seed', 'x']).error).toMatch(/needs a value/);
    expect(parseArgs(['play', '--difficulty', 'insane']).error).toMatch(/Invalid difficulty/);
  });

  it('handles flags', () => {
    expect(parseArgs(['reset', '--yes', '--no-color'])).toMatchObject({ yes: true, noColor: true });
    expect(parseArgs(['stats', '--json']).json).toBe(true);
  });
});
