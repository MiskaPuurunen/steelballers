import type { GameDefinition } from '../core/types.js';
import { bugBashDef } from './bugbash.js';
import { snakeDef } from './snake.js';
import { codeSprintDef } from './codesprint.js';
import { stackDef } from './stack.js';
import { dungeonDef } from './dungeon.js';
import { crossyDef } from './crossy.js';
import { tetrisDef } from './tetris.js';

/**
 * The game registry. To add a game: implement GameDefinition (usually by
 * extending BaseGame) in its own file and append it here. Nothing else in
 * the arcade needs to change.
 */
export const GAMES: readonly GameDefinition[] = [bugBashDef, snakeDef, codeSprintDef, stackDef, dungeonDef, crossyDef, tetrisDef];

/** Aliases accepted by `--game`. */
const ALIASES: Record<string, string> = {
  bug: 'bugbash', bugs: 'bugbash', 'bug-bash': 'bugbash',
  typing: 'codesprint', code: 'codesprint', 'code-sprint': 'codesprint', sprint: 'codesprint',
  stacking: 'stack', 'stack-overflow': 'stack', tower: 'stack',
  'crossy-road': 'crossy', crossyroad: 'crossy', 'crossy-prod': 'crossy', frogger: 'crossy', road: 'crossy',
  blocks: 'tetris', tetromino: 'tetris', tetrominoes: 'tetris',
  roguelike: 'dungeon', 'dependency-dungeon': 'dungeon', deps: 'dungeon',
};

export function findGame(idOrAlias: string): GameDefinition | undefined {
  const id = idOrAlias.toLowerCase();
  return GAMES.find((g) => g.id === (ALIASES[id] ?? id));
}
