import type { GameDefinition } from '../core/types.js';
import { bugBashDef } from './bugbash.js';
import { snakeDef } from './snake.js';
import { skiDef } from './ski.js';
import { stackDef } from './stack.js';
import { dungeonDef } from './dungeon.js';
import { crossyDef } from './crossy.js';
import { tetrisDef } from './tetris.js';

/**
 * The game registry. To add a game: implement GameDefinition (usually by
 * extending BaseGame) in its own file and append it here. Nothing else in
 * the arcade needs to change.
 */
export const GAMES: readonly GameDefinition[] = [bugBashDef, snakeDef, skiDef, stackDef, dungeonDef, crossyDef, tetrisDef];

/** Aliases accepted by `--game`. */
const ALIASES: Record<string, string> = {
  bug: 'bugbash', bugs: 'bugbash', 'bug-bash': 'bugbash',
  skiing: 'ski', 'ski-survival': 'ski', skisurvival: 'ski', skier: 'ski', slope: 'ski',
  stacking: 'stack', 'stack-overflow': 'stack', tower: 'stack',
  'crossy-road': 'crossy', crossyroad: 'crossy', 'crossy-prod': 'crossy', frogger: 'crossy', road: 'crossy',
  blocks: 'tetris', tetromino: 'tetris', tetrominoes: 'tetris',
  roguelike: 'dungeon', 'dependency-dungeon': 'dungeon', deps: 'dungeon',
};

/** Games that were removed, with a hint for anyone still asking for them. */
export const RETIRED_GAMES: Record<string, string> = {
  codesprint: 'Code Sprint was retired and replaced by Ski Survival (--game ski).',
  'code-sprint': 'Code Sprint was retired and replaced by Ski Survival (--game ski).',
  typing: 'Code Sprint was retired and replaced by Ski Survival (--game ski).',
};

export function findGame(idOrAlias: string): GameDefinition | undefined {
  const id = idOrAlias.toLowerCase();
  return GAMES.find((g) => g.id === (ALIASES[id] ?? id));
}
