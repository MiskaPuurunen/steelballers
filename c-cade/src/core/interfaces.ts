/**
 * The interface choices (see src/cli/interface.ts for how each one runs).
 * Kept dependency-free so settings, the CLI parser and the menu can share it.
 */

export type InterfaceMode = 'terminal' | 'standalone' | 'auto';

export const INTERFACES: ReadonlyArray<{ id: InterfaceMode; summary: string }> = [
  { id: 'auto', summary: 'the current terminal (default); never opens a window by itself' },
  { id: 'terminal', summary: 'the current terminal: VS Code integrated terminal, Windows Terminal, iTerm, tmux...' },
  { id: 'standalone', summary: 'a new terminal window; this terminal stays free' },
];

export const isInterfaceMode = (v: unknown): v is InterfaceMode => v === 'terminal' || v === 'standalone' || v === 'auto';

/** A friendly name for the terminal we're in (for messages and `--list-interfaces`). */
export function describeTerminal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.TERM_PROGRAM === 'vscode') return 'the VS Code integrated terminal';
  if (env.WT_SESSION) return 'Windows Terminal';
  if (env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'Terminal.app';
  if (env.TMUX) return 'tmux';
  if (platform === 'win32') return 'a Windows console';
  return 'this terminal';
}
