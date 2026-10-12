import type { GameUiCtx, MpGameUi } from './types.js';
import { BattleshipUi } from './battleship-ui.js';
import { PromptPanicUi } from './prompt-panic-ui.js';
import { DoodleUi } from './doodle-ui.js';

/** Client UIs by game id (the server-side registry is src/mp/registry.ts). */
const UIS: Record<string, (ctx: GameUiCtx) => MpGameUi> = {
  battleship: (ctx) => new BattleshipUi(ctx),
  'prompt-panic': (ctx) => new PromptPanicUi(ctx),
  'doodle-protocol': (ctx) => new DoodleUi(ctx),
};

export function createGameUi(gameId: string, ctx: GameUiCtx): MpGameUi | null {
  return UIS[gameId]?.(ctx) ?? null;
}
