import type { GameDefinition } from '../core/types.js';
import { blackjackDef } from './blackjack.js';
import { slotsDef } from './slots.js';
import { snakeDef } from './snake.js';
import { skiDef } from './ski.js';
import { dungeonDef } from './dungeon.js';
import { crossyDef } from './crossy.js';
import { tetrisDef } from './tetris.js';
import { grandPrixDef, highwayDef, timeTrialDef } from './racing/game.js';

/**
 * The game registry. To add a game: implement GameDefinition (usually by
 * extending BaseGame) in its own file and append it here. Nothing else in
 * the arcade needs to change.
 */
export const GAMES: readonly GameDefinition[] = [blackjackDef, slotsDef, snakeDef, skiDef, dungeonDef, crossyDef, tetrisDef, grandPrixDef, timeTrialDef, highwayDef];

/** Aliases accepted by `--game`. */
const ALIASES: Record<string, string> = {
  bj: 'blackjack', '21': 'blackjack', cards: 'blackjack',
  slot: 'slots', 'slot-machine': 'slots', reels: 'slots',
  skiing: 'ski', 'ski-survival': 'ski', skisurvival: 'ski', skier: 'ski', slope: 'ski',
  'crossy-road': 'crossy', crossyroad: 'crossy', 'crossy-prod': 'crossy', frogger: 'crossy', road: 'crossy',
  blocks: 'tetris', tetromino: 'tetris', tetrominoes: 'tetris',
  race: 'racing', races: 'racing', gp: 'racing', 'grand-prix': 'racing', grandprix: 'racing', cars: 'racing', car: 'racing',
  'time-trial': 'timetrial', tt: 'timetrial', trial: 'timetrial',
  'endless-highway': 'highway', traffic: 'highway', 'rush-hour': 'highway',
  roguelike: 'dungeon', 'dependency-dungeon': 'dungeon', deps: 'dungeon',
};


export function findGame(idOrAlias: string): GameDefinition | undefined {
  const id = idOrAlias.toLowerCase();
  return GAMES.find((g) => g.id === (ALIASES[id] ?? id));
}
