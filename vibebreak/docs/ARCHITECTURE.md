# VibeBreak architecture

## Goals that shaped the design

1. **Instant start, instant exit.** Zero runtime dependencies, one process, and the terminal is always restored.
2. **Games are pure logic.** A game never touches the terminal, creates timers or listens for keys, so every game can be unit-tested and fuzzed headlessly.
3. **Reproducible randomness.** Every random decision flows from a session seed.
4. **Adding a game is one file plus one line.**

## Layout

```
src/
  cli/          index.ts (bin entry), main.ts (commands), args.ts (pure arg parser)
  core/         types.ts       shared interfaces (GameInstance, GameDefinition, Key, Effects…)
                rng.ts         seedable mulberry32 RNG with pick/weighted/shuffle/fork
                session.ts     session generator: game, difficulty, modifier, duration, daily seed
                modifiers.ts   modifier + difficulty tables -> concrete Effects
                base-game.ts   BaseGame: round clock, scoring w/ multipliers, feedback, end state
                progression.ts XP curve, achievements, recordRound()
  games/        bugbash.ts snake.ts codesprint.ts stack.ts dungeon.ts, index.ts (registry)
  ui/           terminal.ts    TerminalIO: NodeTerminal (real) and FakeTerminal (tests)
                screen.ts      line-diffing renderer with synchronized updates
                keys.ts        raw stdin -> Key events (CSI/SS3 arrows, ctrl chars, paste)
                style.ts       16-colour ANSI palette with NO_COLOR/TTY fallback, width helpers
                layout.ts      logo, HUD, bars, centering helpers
                app.ts         the arcade shell: one state machine, one loop, one input handler
                stats-view.ts  stats screen shared with `vibebreak stats`
  storage/      save.ts        config dir per OS, atomic JSON save, validation, corruption backup
  integrations/ agent-status.ts  hook entry point + status file watcher
tests/          vitest suites (unit, lifecycle fuzzing, app flow with a fake terminal + clock)
scripts/        pty-smoke.py   real pseudo-terminal end-to-end smoke test
```

## Why not Ink?

The brief suggested Ink. VibeBreak uses a small custom renderer (under 100 lines with the terminal wrapper) instead, for three reasons:

- **Real-time games at 30 fps.** Ink re-renders a React tree and rewrites its output region on every change. For Snake and Stack Overflow, the most reliable flicker-free approach is to diff whole lines and rewrite only the rows that changed, wrapped in DEC mode 2026 synchronized output (supported by Windows Terminal and most modern terminals, ignored by the rest). A test checks that a typical game frame writes under 400 bytes.
- **Full control of terminal state.** Alternate screen, cursor visibility and raw mode are all handled in one class (`NodeTerminal`) with an idempotent `stop()`. That `stop()` is wired to normal exit, Ctrl+C, SIGTERM/SIGHUP/SIGINT and uncaught exceptions.
- **Zero runtime dependencies.** `npx vibebreak` starts instantly, which matters for a tool you open for a 30-second break.

## The game contract

```ts
interface GameInstance {
  readonly score: number;
  readonly minSize: { width: number; height: number };
  handleInput(key: Key): void;   // called by the shell's single input handler
  update(dtMs: number): void;     // called by the shell's single loop
  render(): string[];             // lines for the central area
  hud(): HudItem[];
  feedback(): { text; tone } | null;
  timeLeftMs(): number;
  isOver(): boolean;
  forceEnd(reason): void;
  result(): GameResult;           // score, endReason, stats, metrics, perfect
  dispose(): void;
}
```

Lifecycle: `create(ctx)` initialises the game, `handleInput`/`update` advance it, `render`/`hud` draw it, `isOver`/`result` complete it, and `dispose` cleans it up. `BaseGame` implements the clock: `update()` clamps `dt` to 100 ms so a suspended laptop can't break physics, ends the round at the time limit, and decays feedback messages. After the round ends, input and updates have no effect; the lifecycle tests verify this.

The `GameContext` passed to `create()` contains a forked `Rng`, the difficulty, the resolved `Effects` (speed, scoreMult, xpMult, specialMult, penaltyMult, lives, chaos) and the duration. Each game decides how to interpret the effects. Snake, for example, excludes Low Battery because one crash already ends the round.

## The shell (`ui/app.ts`)

A single state machine: `menu → arcade → briefing → playing (paused?) → results`, plus `stats`.

- **One loop.** One `setInterval` at about 30 fps calls `tick()`. `tick()` computes `dt`, advances the briefing countdown or the game, polls the agent beacon once a second, animates the results count-up and renders. `quit()` clears the interval, and a test asserts no timer remains.
- **One input handler.** stdin data is parsed into `Key`s and dispatched by state. Ctrl+C is handled before any game sees the key.
- **Debouncing.** Menus ignore a second Enter within 150 ms. The results screen ignores keys for 600 ms after a round ends, so a mashed key can't skip your score. Bug Bash and Stack Overflow ignore immediate repeats of the key that just scored or dropped.
- **Too-small terminals.** If the window is smaller than the game's `minSize` plus the HUD, the game is paused (its clock does not advance) and a resize hint is shown. Every game fits 80×24.
- **Injected dependencies.** `TerminalIO`, a `Scheduler` (clock + interval) and the `SaveStore` are all injected. The app tests drive the whole flow with a fake terminal and a fake clock, including the countdown, timed rounds, pause, restart, reroll, resize, stats reset and Ctrl+C.

## Session generation

`generateSession(games, opts)` works from `new Rng(seed).fork('session')`:

1. **Game.** A weighted pick that excludes the previous game when there is an alternative. The daily challenge ignores history so everyone gets the same game.
2. **Difficulty.** A weighted pick: Easy 3, Normal 5, Hard 2.
3. **Modifier.** A weighted pick with the game's excluded modifiers set to weight 0.
4. **Effects.** Resolved from the modifier. Chaos Mode rolls its own mix with a forked RNG.
5. **Duration.** The `--duration` value clamped to 15–300 s, or the game's default. The daily always uses the default.

The game itself gets `new Rng(seed).fork('game:<id>')`, so the same seed always produces the same content. The lifecycle tests run identical inputs twice and expect identical results. The daily seed is `daily-YYYY-MM-DD` using the UTC date.

## Procedural content validation

- **Snake.** A random layout is generated, the starting lane is cleared, and a flood fill confirms at least 95% of free cells are reachable (otherwise the board falls back to open). Food and bonus food spawn only on reachable, unoccupied cells. Tested over 200 seeds.
- **Dungeon.** Non-overlapping rooms are chained with L-shaped corridors (connected by construction), sometimes with an extra loop corridor. The exit goes on the farthest reachable cell according to a BFS from the start. Items are placed only on BFS-reachable cells. Enemies start at least 6 steps away. Tested over 500 seeds at every difficulty.

## Persistence

`SaveStore` reads and writes a single JSON file:

- **Loading** passes data through `normalizeSave`, which type-checks every field and drops junk. A file that fails to parse is renamed to `save.json.corrupt-<ts>` and a fresh save is started.
- **Writing** goes to a temp file first, which is then renamed over the save (atomic). A failed write never crashes the app; the results screen shows a notice instead.
- **History** is capped at 20 entries and daily records at 30 days, so the file stays small.

## Agent integration

```
Claude Code ──hook (async, exit 0, no stdout)──▶ vibebreak hook ──writes──▶ agent-status.json
                                                                                 │ (mtime poll, 1/s)
                                         VibeBreak in another terminal ◀──────────┘ HUD badge
```

`vibebreak hook` reads stdin with a 1-second timeout and parses only `hook_event_name`. It maps `UserPromptSubmit` to *working*, `Stop`/`StopFailure` to *done*, `Notification` to *attention* and `SessionEnd` to *idle*, writes `{state, event, at, agent}` atomically, and exits 0 silently. The hook path skips everything else (no save load, no colour setup) and calls `process.exit` so it can't linger. Statuses older than 30 minutes are ignored.

### Future integration points

- **Auto-launch.** A `vibebreak hook --launch` that opens a new terminal tab (`wt.exe -w 0 nt`, `osascript` for Terminal or iTerm, `$TERMINAL -e` on Linux) on `UserPromptSubmit`, rate-limited and opt-in. This was deferred: the behaviour differs on every platform, and stealing focus mid-thought is a real risk.
- **Other agents.** The beacon only needs a command that writes the status file, so Codex or Aider wrappers can call `vibebreak hook` with the same JSON shape (`{"hook_event_name":"UserPromptSubmit"}`).
- **Agent-aware rounds.** An optional mode that ends the round gracefully (with the usual warning) when the agent reports *done*.

## Testing strategy

| Layer | How |
|---|---|
| Pure logic | Unit tests for the RNG, session generator, every game's rules (scoring, combos, collisions, alignment, typing accuracy, dungeon connectivity), progression, storage, the arg parser and the key parser |
| Robustness | Each game is fuzzed with random input over 25 seeds and random modifiers. The tests check it never throws, that render lines fit `minSize`, that the round ends on time and that the game is inert afterwards, plus reproducibility and an 80×24 fit check |
| App flow | `App` is driven with `FakeTerminal` and `FakeScheduler`: full menu-to-results flow, pause clock freeze, restart, reroll, resize pause, stats reset, Ctrl+C timer cleanup and the frame-diff size |
| Real terminal | `scripts/pty-smoke.py` runs the built binary in a PTY with a VT100 emulator: menus, all five games, pause, the time limit, Ctrl+C exit code and terminal restoration, resize, daily, and corrupted-save recovery |
