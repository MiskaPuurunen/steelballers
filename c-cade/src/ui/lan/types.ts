import type { Key } from '../../core/types.js';

/**
 * Client-side presentation for one multiplayer game. Game UIs are pure
 * view + input: they render the latest server view and turn keys into
 * actions via `ctx.send`. They never decide outcomes.
 */
export interface GameUiCtx {
  /** The local player's id (null before joining). */
  you(): string | null;
  /** Send a game action to the server. */
  send(action: Record<string, unknown>): void;
  /** Server clock estimate, for deadlines in views. */
  serverNow(): number;
  isHost(): boolean;
  /** Animation clock (ms) for cursors and blinking. */
  anim(): number;
}

export interface MpGameUi {
  setView(view: unknown): void;
  onEvent(data: unknown): void;
  /** Returns true when the key was used. */
  onKey(key: Key): boolean;
  tick(dtMs: number): void;
  render(width: number, height: number): string[];
  /** True while a text field has focus (letters are text, not shortcuts). */
  capturing(): boolean;
  /** Key hints for the footer. */
  hints(): Array<[string, string]>;
}
