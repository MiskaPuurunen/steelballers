import { beforeAll, describe, expect, it } from 'vitest';
import { loadLuaRuntime, type LuaRuntime } from '../src/custom/lua-runtime.js';
import { compileCustomGame, errorLine, parseMeta, renderMarkup, sanitize, type CustomMeta } from '../src/custom/lua-game.js';
import { TEMPLATE_LUA } from '../src/custom/template.js';
import { generateSession } from '../src/core/session.js';
import { Rng } from '../src/core/rng.js';
import { visibleWidth } from '../src/ui/style.js';
import type { GameDefinition, Key } from '../src/core/types.js';
import { ctx } from './helpers.js';

let rt: LuaRuntime;
beforeAll(async () => {
  rt = await loadLuaRuntime();
});

const HEAD = 'game = { id = "t", name = "Test", min_size = { w = 20, h = 4 } }\n';

function compile(src: string): GameDefinition {
  const r = compileCustomGame(src, rt);
  if (!r.ok) throw new Error(r.error);
  return r.def;
}

const KEYS: Key[] = [
  { name: 'left' }, { name: 'right' }, { name: 'up' }, { name: 'down' }, { name: 'space', ch: ' ' }, { name: 'enter' },
  ...'adhlqwe'.split('').map((ch) => ({ name: 'char' as const, ch })),
];

describe('custom Lua games', () => {
  it('the bundled example compiles and plays a full round', () => {
    const def = compile(TEMPLATE_LUA);
    expect(def.id).toBe('custom:packet-catcher');
    expect(def.custom?.source).toBe(TEMPLATE_LUA);
    const game = def.create(ctx('t', { durationMs: 15_000 }));
    const input = new Rng('in');
    let frames = 0;
    while (!game.isOver() && frames < 1000) {
      if (input.chance(0.3)) game.handleInput(input.pick(KEYS));
      game.update(33);
      frames++;
      for (const l of game.render()) expect(visibleWidth(l)).toBeLessThanOrEqual(game.minSize.width);
    }
    expect(game.isOver()).toBe(true);
    const r = game.result();
    expect(r.metrics.map(([l]) => l)).toContain('Packets caught');
    expect(game.hud()[0].label).toBe('LIVES');
    game.dispose();
  });

  it('same seed and input give the same result (no hidden randomness)', () => {
    const def = compile(TEMPLATE_LUA);
    const run = () => {
      const s = generateSession([def], { seed: 'repro', gameId: def.id, durationSec: 15 });
      const g = def.create({ rng: new Rng(s.seed), difficulty: s.difficulty, effects: s.effects, durationMs: s.durationMs });
      const input = new Rng('same');
      while (!g.isOver()) {
        if (input.chance(0.3)) g.handleInput(input.pick(KEYS));
        g.update(33);
      }
      const res = g.result();
      g.dispose();
      return res;
    };
    expect(run()).toEqual(run());
  });

  it('scripts cannot reach io, os, require, load, debug or Math.random', () => {
    const def = compile(HEAD + `
      function render()
        return { tostring(io), tostring(os), tostring(require), tostring(load), tostring(debug),
                 tostring(math.random), tostring(collectgarbage), tostring(getmetatable("")) }
      end`);
    const g = def.create(ctx());
    expect(g.render()).toEqual(['nil', 'nil', 'nil', 'nil']);
    g.dispose();
    const g2 = compile(HEAD.replace('h = 4', 'h = 8') + `
      function render()
        return { tostring(io), tostring(os), tostring(require), tostring(load), tostring(debug),
                 tostring(math.random), tostring(collectgarbage), tostring(getmetatable("")) }
      end`).create(ctx());
    expect(g2.render()).toEqual(['nil', 'nil', 'nil', 'nil', 'nil', 'nil', 'nil', 'false']);
    g2.dispose();
  });

  it('rejects precompiled bytecode', () => {
    const r = compileCustomGame('\x1bLua' + HEAD, rt);
    expect(r.ok).toBe(false);
  });

  it('an infinite loop is cut off and ends the round with a script error', () => {
    const def = compile(HEAD + `
      local frames = 0
      function update() frames = frames + 1 if frames > 200 then while true do pcall(function() while true do end end) end end end
      function render() return { "ok" } end`);
    const g = def.create(ctx());
    const t = Date.now();
    for (let i = 0; i < 300 && !g.isOver(); i++) g.update(33);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
    expect(g.render().join(' ')).toMatch(/Script error/);
    g.dispose();
  });

  it('coroutines cannot escape the time limit either', () => {
    const def = compile(HEAD + `
      local n = 0
      function update() n = n + 1 if n > 100 then coroutine.wrap(function() while true do end end)() end end`);
    const g = def.create(ctx());
    for (let i = 0; i < 200 && !g.isOver(); i++) g.update(33);
    expect(g.isOver()).toBe(true);
    g.dispose();
  });

  it('memory bombs fail instead of taking the machine down', () => {
    const r = compileCustomGame(HEAD + 'local s = "x" for i = 1, 40 do s = s .. s end', rt);
    expect(r.ok).toBe(false);
  });

  it('reports errors with line numbers', () => {
    const r = compileCustomGame(HEAD + '\n\nfunction update( x = 1 end', rt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(4);
    const r2 = compileCustomGame(HEAD + 'function update() local t = nil; t.x = 1 end', rt);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.line).toBe(2);
      expect(r2.error).toMatch(/attempt to index/);
    }
    expect(errorLine('game:12: boom')).toBe(12);
  });

  it('validates the game table', () => {
    expect(compileCustomGame('function render() end', rt)).toMatchObject({ ok: false, error: expect.stringMatching(/global table named 'game'/) });
    expect(compileCustomGame('game = { id = "Bad Id!", min_size = { w = 20, h = 4 } }', rt)).toMatchObject({ ok: false });
    expect(compileCustomGame('game = { id = "x" }', rt)).toMatchObject({ ok: false, error: expect.stringMatching(/min_size/) });
    const meta: CustomMeta = parseMeta('id\tok\nname\tA very long name that keeps going\nwidth\t500\nheight\t500\nduration\t9999\ncontrol\tSpace\thit');
    expect(meta.minSize).toEqual({ width: 78, height: 18 });
    expect(meta.durationSec).toBe(300);
    expect(meta.name.length).toBeLessThanOrEqual(24);
    expect(meta.controls).toEqual([['Space', 'hit']]);
  });

  it('strips terminal escape sequences from everything a script draws', () => {
    expect(sanitize('a\x1b]52;c;ZXZpbA==\x07b\x9bc')).toBe('a]52;c;ZXZpbA==bc');
    const def = compile(HEAD + 'function render() return { "\\27[2J\\27]0;pwned\\7hello" } end function hud() return {{ label = "\\27[31mX", value = "1" }} end');
    const g = def.create(ctx());
    expect(g.render()[0]).not.toContain('\x1b');
    expect(g.render()[0]).toContain('hello');
    expect(g.hud()[0].label).not.toContain('\x1b');
    g.dispose();
  });

  it('colour markup and clipping', () => {
    expect(renderMarkup('{good}OK{/} and {{braces}', 40)).toBe('OK and {braces}');
    expect(renderMarkup('{nope}x', 40)).toBe('{nope}x');
    expect(visibleWidth(renderMarkup('{bad}' + 'x'.repeat(100), 20))).toBe(20);
  });

  it('host API: score, penalize, finish, modifiers and lives', () => {
    const def = compile(HEAD + `
      function init() lives_seen = vb.lives end
      function on_key(k)
        if k.name == "space" then vb.score(10) end
        if k.ch == "p" then vb.penalize(5) end
        if k.ch == "w" then vb.finish("win") end
      end
      function render() return { tostring(lives_seen), tostring(vb.speed), vb.difficulty } end`);
    const g = def.create(ctx('x', { difficulty: 'hard', effects: { scoreMult: 2, lives: 3, speed: 1.3 } }));
    expect(g.render()).toEqual(['3', '1.3', 'hard']);
    g.handleInput({ name: 'space', ch: ' ' });
    expect(g.score).toBe(20);
    g.handleInput({ name: 'char', ch: 'p' });
    expect(g.score).toBe(15);
    g.handleInput({ name: 'char', ch: 'w' });
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('win');
    g.dispose();
  });
});
