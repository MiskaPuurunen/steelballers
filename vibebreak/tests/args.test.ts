import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('CLI parsing', () => {
  it('defaults to the menu', () => {
    expect(parseArgs([]).command).toBe('menu');
  });

  it('parses play with options', () => {
    expect(parseArgs(['play', '--game', 'snake', '--duration', '30', '--seed', 'AB', '--difficulty', 'hard', '-m', 'chaos'])).toMatchObject({
      command: 'play', game: 'snake', duration: 30, seed: 'AB', difficulty: 'hard', modifier: 'chaos',
    });
  });

  it('accepts --flag=value and 30s durations', () => {
    expect(parseArgs(['play', '--duration=45s', '--game=stack'])).toMatchObject({ duration: 45, game: 'stack' });
  });

  it('play --random --duration 30 from the spec', () => {
    expect(parseArgs(['play', '--random', '--duration', '30'])).toMatchObject({ command: 'play', random: true, duration: 30 });
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
    expect(parseArgs(['play', '--duration', 'soon']).error).toMatch(/Invalid duration/);
    expect(parseArgs(['play', '--duration']).error).toMatch(/needs a value/);
    expect(parseArgs(['play', '--game', '--seed', 'x']).error).toMatch(/needs a value/);
    expect(parseArgs(['play', '--difficulty', 'insane']).error).toMatch(/Invalid difficulty/);
  });

  it('handles flags', () => {
    expect(parseArgs(['reset', '--yes', '--no-color'])).toMatchObject({ yes: true, noColor: true });
    expect(parseArgs(['stats', '--json']).json).toBe(true);
  });
});
