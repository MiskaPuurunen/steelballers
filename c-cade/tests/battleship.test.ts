import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import {
  BattleshipMatch, FLEET, battleshipDef, parseCoord, placementError, randomFleet, shipCells, validateFleet,
  type Placement,
} from '../src/games/multiplayer/battleship.js';
import { resolveOptions } from '../src/mp/types.js';

const players = [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }];

/** Ships stacked in rows 0..4, all horizontal from column 0. */
const ROWS: Placement[] = FLEET.map((s, i) => ({ id: s.id, x: 0, y: i, dir: 'h' }));

function match(over: Record<string, unknown> = {}, seed = 'bs') {
  const m = new BattleshipMatch({
    players,
    rng: new Rng(seed),
    options: resolveOptions(battleshipDef, over),
    now: 0,
    memory: new Map(),
  });
  return m;
}

function started(seed = 'bs') {
  const m = match({}, seed);
  expect(m.handleAction('a', { kind: 'place', fleet: ROWS }, 0)).toEqual({ ok: true });
  expect(m.handleAction('b', { kind: 'place', fleet: ROWS }, 0)).toEqual({ ok: true });
  const first = m.viewFor('a').turn === 0 ? 'a' : 'b';
  return { m, first, second: first === 'a' ? 'b' : 'a' };
}

describe('Battleship placement', () => {
  it('parses coordinates', () => {
    expect(parseCoord('B4')).toEqual({ x: 1, y: 3 });
    expect(parseCoord('j10')).toEqual({ x: 9, y: 9 });
    expect(parseCoord('K1')).toBeNull();
    expect(parseCoord('A11')).toBeNull();
    expect(parseCoord('A0')).toBeNull();
  });

  it('rejects ships beyond the board', () => {
    expect(placementError([], { id: 'carrier', x: 6, y: 0, dir: 'h' })).toMatch(/beyond/);
    expect(placementError([], { id: 'carrier', x: 0, y: 6, dir: 'v' })).toMatch(/beyond/);
    expect(placementError([], { id: 'carrier', x: 5, y: 5, dir: 'h' })).toBeNull();
  });

  it('detects collisions', () => {
    const existing: Placement[] = [{ id: 'carrier', x: 0, y: 0, dir: 'h' }];
    expect(placementError(existing, { id: 'destroyer', x: 4, y: 0, dir: 'v' })).toMatch(/overlap/);
    expect(placementError(existing, { id: 'destroyer', x: 5, y: 0, dir: 'v' })).toBeNull();
  });

  it('validates whole fleets from untrusted input', () => {
    expect(validateFleet(ROWS).ok).toBe(true);
    expect(validateFleet(ROWS.slice(0, 4))).toMatchObject({ ok: false, error: /Place all/ });
    expect(validateFleet([...ROWS.slice(0, 4), { ...ROWS[0] }])).toMatchObject({ ok: false, error: /Duplicate/ });
    expect(validateFleet(ROWS.map((r, i) => (i === 4 ? { ...r, y: 0 } : r)))).toMatchObject({ ok: false, error: /overlap/ });
    expect(validateFleet(ROWS.map((r, i) => (i === 0 ? { ...r, x: 1.5 } : r)))).toMatchObject({ ok: false });
    expect(validateFleet(ROWS.map((r, i) => (i === 0 ? { ...r, dir: 'diagonal' } : r)))).toMatchObject({ ok: false });
    expect(validateFleet(ROWS.map((r, i) => (i === 0 ? { ...r, id: 'yacht' } : r)))).toMatchObject({ ok: false });
    expect(validateFleet('lol')).toMatchObject({ ok: false });
  });

  it('random fleets are always legal and seed-deterministic', () => {
    for (let i = 0; i < 50; i++) expect(validateFleet(randomFleet(new Rng(`f${i}`))).ok).toBe(true);
    expect(randomFleet(new Rng('x'))).toEqual(randomFleet(new Rng('x')));
  });

  it('the battle starts only when both fleets are placed', () => {
    const m = match();
    m.handleAction('a', { kind: 'place', fleet: ROWS }, 0);
    expect(m.viewFor('a').phase).toBe('placing');
    expect(m.handleAction('a', { kind: 'fire', x: 0, y: 0 }, 0)).toMatchObject({ ok: false, code: 'PHASE' });
    m.handleAction('b', { kind: 'place', fleet: ROWS }, 0);
    expect(m.viewFor('a').phase).toBe('battle');
    expect(m.handleAction('a', { kind: 'place', fleet: ROWS }, 0)).toMatchObject({ ok: false, code: 'PHASE' });
  });

  it('placement timer auto-deploys missing fleets', () => {
    const m = match({ placeTime: 60 });
    m.handleAction('a', { kind: 'place', fleet: ROWS }, 0);
    m.tick(59_000);
    expect(m.viewFor('a').phase).toBe('placing');
    m.tick(60_000);
    expect(m.viewFor('b').phase).toBe('battle');
    expect(m.viewFor('b').mine).toHaveLength(5);
  });
});

describe('Battleship battle', () => {
  it('enforces turns and rejects repeat or off-board shots', () => {
    const { m, first, second } = started();
    expect(m.handleAction(second, { kind: 'fire', x: 9, y: 9 }, 1)).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(m.handleAction(first, { kind: 'fire', x: 10, y: 0 }, 1)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(m.handleAction(first, { kind: 'fire', x: '1', y: 0 }, 1)).toMatchObject({ ok: false });
    expect(m.handleAction(first, { kind: 'fire', x: 9, y: 9 }, 1)).toEqual({ ok: true });
    expect(m.viewFor(first).last).toMatchObject({ result: 'miss' });
    expect(m.handleAction(first, { kind: 'fire', x: 8, y: 9 }, 2)).toMatchObject({ code: 'NOT_YOUR_TURN' });
    expect(m.handleAction(second, { kind: 'fire', x: 9, y: 9 }, 2)).toEqual({ ok: true });
    expect(m.handleAction(first, { kind: 'fire', x: 9, y: 9 }, 3)).toMatchObject({ ok: false, code: 'ALREADY_FIRED' });
    expect(m.handleAction('zed', { kind: 'fire', x: 0, y: 0 }, 3)).toMatchObject({ ok: false, code: 'NOT_PLAYING' });
  });

  it('reports hit, sunk and victory, and alternates turns', () => {
    const { m, first, second } = started();
    const targets = ROWS.flatMap(shipCells);
    let missX = 9;
    let missY = 9;
    for (let i = 0; i < targets.length; i++) {
      const [x, y] = targets[i];
      expect(m.handleAction(first, { kind: 'fire', x, y }, i)).toEqual({ ok: true });
      const last = m.viewFor(first).last!;
      if (i === 4) expect(last).toMatchObject({ result: 'sunk', ship: 'Carrier' });
      else if (i === 0) expect(last.result).toBe('hit');
      if (m.isOver()) break;
      // The opponent wastes a shot in the empty bottom-right area.
      expect(m.handleAction(second, { kind: 'fire', x: missX, y: missY }, i)).toEqual({ ok: true });
      if (--missX < 5) { missX = 9; missY--; }
    }
    expect(m.isOver()).toBe(true);
    const v = m.viewFor(second);
    expect(v.winner).toBe(players.findIndex((p) => p.id === first));
    expect(v.endReason).toBe('victory');
    expect(v.boards[players.findIndex((p) => p.id === second)].afloat).toBe(0);
    const out = m.outcome()!;
    expect(out.standings[0]).toMatchObject({ playerId: first, rank: 1 });
    expect(out.stats![first]).toMatchObject({ hits: 17, sunk: 5, won: 1 });
    expect(out.incomplete).toBeUndefined();
    expect(m.handleAction(second, { kind: 'fire', x: 0, y: 9 }, 99)).toMatchObject({ ok: false, code: 'PHASE' });
  });

  it('never sends the opponent\'s unhit ships', () => {
    const { m, first, second } = started('privacy');
    m.handleAction(first, { kind: 'fire', x: 0, y: 0 }, 1); // hit the carrier once
    const fi = players.findIndex((p) => p.id === first);
    const view = m.viewFor(first);
    expect(view.mine).toEqual(ROWS);
    // The opponent's board: only shots and sunk ships, no positions.
    const opp = view.boards[1 - fi];
    expect(opp).toEqual({ shots: [[0, 0, 'h']], sunk: [], afloat: 5, ready: true });
    const json = JSON.stringify(view);
    // The only placements in the view are the viewer's own.
    expect(json.split('"dir"').length - 1).toBe(5);
    // Spectators see no fleets at all.
    const spec = m.viewFor(null);
    expect(spec.mine).toBeNull();
    expect(JSON.stringify(spec)).not.toContain('"dir"');
    expect(m.viewFor(second).boards[1 - fi].shots).toEqual([[0, 0, 'h']]);
  });

  it('turn timer passes the turn on timeout', () => {
    const m = match({ turnTime: 20 });
    m.handleAction('a', { kind: 'place', fleet: ROWS }, 0);
    m.handleAction('b', { kind: 'place', fleet: ROWS }, 0);
    const t0 = m.viewFor('a').turn;
    m.tick(19_999);
    expect(m.viewFor('a').turn).toBe(t0);
    m.tick(20_000);
    expect(m.viewFor('a').turn).toBe(1 - t0);
  });
});

describe('Battleship disconnects', () => {
  it('pauses for a disconnected player and resumes when they return', () => {
    const { m, first } = started();
    m.setPresence(first, 'disconnected', 10);
    expect(m.viewFor(first).paused).toBe(players.find((p) => p.id === first)!.name);
    expect(m.handleAction(first, { kind: 'fire', x: 0, y: 0 }, 11)).toMatchObject({ code: 'PAUSED' });
    m.setPresence(first, 'connected', 20);
    expect(m.viewFor(first).paused).toBeNull();
    expect(m.handleAction(first, { kind: 'fire', x: 0, y: 0 }, 21)).toEqual({ ok: true });
  });

  it('a player who leaves for good forfeits, explicitly labelled', () => {
    const { m, first, second } = started();
    m.setPresence(first, 'gone', 10);
    expect(m.isOver()).toBe(true);
    expect(m.outcome()!.headline).toMatch(/forfeit/);
    expect(m.outcome()!.standings[0].playerId).toBe(second);
  });

  it('no-contest rule awards nobody', () => {
    const m = match({ onLeave: 'no-contest' });
    m.setPresence('a', 'gone', 5);
    expect(m.outcome()!).toMatchObject({ incomplete: true, headline: /No contest/ });
    expect(m.viewFor('b').winner).toBeNull();
  });

  it('host abort ends the match without a winner', () => {
    const { m } = started();
    m.abort('The host ended the match.');
    expect(m.outcome()).toMatchObject({ incomplete: true, headline: /host/ });
  });

  it('reveals both fleets only after the match', () => {
    const { m, first } = started();
    expect(m.viewFor(first).revealed).toBeNull();
    m.abort('x');
    expect(m.viewFor(null).revealed).toEqual([ROWS, ROWS]);
  });
});
