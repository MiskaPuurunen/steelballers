import type { MpGameDefinition } from './types.js';
import { battleshipDef } from '../games/multiplayer/battleship.js';
import { promptPanicDef } from '../games/multiplayer/prompt-panic.js';
import { doodleDef } from '../games/multiplayer/doodle.js';

/**
 * Multiplayer game registry (server side). To add a LAN game, implement
 * MpGameDefinition, add it here, and add its client UI to
 * src/ui/lan/game-uis.ts. Lobby, networking and reconnection are shared.
 */
export const MP_GAMES: readonly MpGameDefinition[] = [battleshipDef, promptPanicDef, doodleDef];

export const RANDOM_GAME = 'random';

const ALIASES: Record<string, string> = {
  ships: 'battleship', battleships: 'battleship', bs: 'battleship', naval: 'battleship',
  prompt: 'prompt-panic', prompts: 'prompt-panic', promptpanic: 'prompt-panic', panic: 'prompt-panic', pp: 'prompt-panic',
  doodle: 'doodle-protocol', draw: 'doodle-protocol', drawing: 'doodle-protocol', doodleprotocol: 'doodle-protocol', dp: 'doodle-protocol',
  party: RANDOM_GAME, any: RANDOM_GAME,
};

export function findMpGame(idOrAlias: string): MpGameDefinition | undefined {
  const id = idOrAlias.toLowerCase();
  return MP_GAMES.find((g) => g.id === (ALIASES[id] ?? id));
}

/** Resolve a --game value to a game id or 'random'; undefined if unknown. */
export function resolveMpGameId(idOrAlias: string): string | undefined {
  const id = idOrAlias.toLowerCase();
  if ((ALIASES[id] ?? id) === RANDOM_GAME) return RANDOM_GAME;
  return findMpGame(id)?.id;
}
