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
                interface.ts   where the arcade runs: this terminal or a new window (see below)
  core/         types.ts       shared interfaces (GameInstance, GameDefinition, Key, Effects…)
                interfaces.ts  the interface choices (terminal | standalone | auto), dependency-free
                rng.ts         seedable mulberry32 RNG with pick/weighted/shuffle/fork
                session.ts     session generator: game, difficulty, modifier, duration, daily seed
                modifiers.ts   modifier + difficulty tables -> concrete Effects
                base-game.ts   BaseGame: round clock, scoring w/ multipliers, feedback, end state
                progression.ts XP curve, achievements, recordRound()
  games/        bugbash.ts snake.ts ski.ts stack.ts dungeon.ts crossy.ts tetris.ts, index.ts (registry)
                ski-sprites.ts  Ski Survival art: tree variants, obstacles, skier poses, effects (data only)
  games/racing/ track.ts       seeded tracks: smooth periodic curves, hazards, scenery (circuit + endless highway)
                sim.ts         the race simulation shared by every mode and the LAN server (fixed 20ms steps)
                ai.ts          AI drivers (press the same keys a person can) + a snapshot-only driver for bots
                sprites.ts     cars, traffic, hazards (built on ui/sprite.ts; scenery reuses ski-sprites)
                render.ts      RaceView: one renderer for singleplayer and LAN scenes
                game.ts        arcade modes: Grand Prix, Time Trial (records + ghost), Highway
                mp.ts          LAN racing: server-authoritative match over the shared sim
  ui/           terminal.ts    TerminalIO: NodeTerminal (real) and FakeTerminal (tests)
                menu-screens.ts main menu, Multiplayer, Settings, Agent status, Help (pure render + settings)
                screen.ts      line-diffing renderer with synchronized updates
                sprite.ts      multi-line ASCII sprites: frames, anchor, colour roles, hitboxes, compact art
                canvas.ts      layered character grid: clipped sprite blits, run-grouped ANSI output
                keys.ts        raw stdin -> Key events (CSI/SS3 arrows, ctrl chars, paste)
                style.ts       ANSI palette (16 colours, optional 256) with NO_COLOR/TTY fallback, width helpers
                themes.ts      theme registry, palette swap, themed rules, stateless particle field + margin overlay
                layout.ts      logo, HUD, bars, centering helpers
                app.ts         the arcade shell: one state machine, one loop, one input handler
                stats-view.ts  stats screen shared with `vibebreak stats`
                text-editor.ts in-terminal editor for Lua custom games
  custom/       lua-runtime.ts lua-game.ts library.ts template.ts  user-made Lua games (see CUSTOM_GAMES.md)
  storage/      save.ts        config dir per OS, atomic JSON save, validation, corruption backup
  integrations/ agent-model.ts   typed AI-status state machine + staleness rules (pure)
                agent-status.ts  per-session event store, hook entry, AgentMonitor (consumer)
                claude-settings.ts, launcher.ts  hook install/inspect, auto-launch
  cli/          hook.ts        fast hook path (loads no UI); doctor.ts `vibebreak doctor`
  net/          protocol.ts    LAN wire protocol v1: envelopes, validation, line framing, token buckets
                sanitize.ts    untrusted text: strip control/bidi/wide chars, wrap, deep scrub
                address.ts     private-address policy, LAN interface choice, host:port parsing
                lobby.ts       transport-agnostic lobby: members, host commands, match lifecycle, views
                server.ts      TCP host: framing, handshake/idle timeouts, heartbeats, flood limits
                client.ts      TCP client: join, auto-reconnect with seat resume, acked actions
                discovery.ts   UDP broadcast room discovery (responder + scanner)
  mp/           types.ts       server-authoritative multiplayer contract (MpGameDefinition, MpMatch)
                registry.ts    LAN game registry; bot.ts automated player; headless.ts dedicated host/bot
  games/multiplayer/  battleship.ts prompt-panic.ts prompts.ts moderation.ts doodle.ts
  ui/lan/       lan-screen.ts  host/join setup, lobby, intro, match, results (driven by the App loop)
                battleship-ui.ts prompt-panic-ui.ts doodle-ui.ts game-uis.ts widgets.ts
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
  setViewport?(w: number, h: number): void; // optional: space available, told before each render
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

A single state machine: `menu → arcade → briefing → playing (paused?) → results`, plus `stats`, `multiplayer`, `settings`, `agent`, `help`, `themes`, the custom-game screens and `lan`. Every run starts at `menu` unless the command line asked for something specific (`play`, `daily`, `host`, `join`); nothing starts a game on its own.

- **One loop.** One `setInterval` at about 30 fps calls `tick()`. `tick()` computes `dt`, advances the briefing countdown or the game, re-scans agent session files every 500 ms (the status line is redrawn every frame, so ages tick and staleness shows with no input), animates the results count-up and renders. `quit()` clears the interval, and a test asserts no timer remains.
- **One input handler.** stdin data is parsed into `Key`s and dispatched by state. Ctrl+C is handled before any game sees the key.
- **Debouncing.** Menus ignore a second Enter within 150 ms. The results screen ignores keys for 600 ms after a round ends, so a mashed key can't skip your score. Bug Bash and Stack Overflow ignore immediate repeats of the key that just scored or dropped.
- **Too-small terminals.** If the window is smaller than the game's `minSize` plus the HUD, the game is paused (its clock does not advance) and a resize hint is shown. Every game fits 80×24.
- **Injected dependencies.** `TerminalIO`, a `Scheduler` (clock + interval) and the `SaveStore` are all injected. The app tests drive the whole flow with a fake terminal and a fake clock, including the countdown, timed rounds, pause, restart, reroll, resize, stats reset and Ctrl+C.

## Interfaces: one app, two places to draw it

```
vibebreak [--interface terminal|standalone|auto]
   |
cli/main.ts ── chooseInterface(cli flag > saved setting > auto)
   |                 |
   | inline          | window: cli/interface.ts openStandalone()
   |                 |   planLaunch(..., 'window') -> wt / start / Terminal.app / x-terminal-emulator
   |                 |   the window runs the same CLI with --interface terminal --window
   v                 v
runArcade(): NodeTerminal + App (menu, games, LAN, agent status, save file)
```

There is no second front end. An interface only decides which terminal the one `App` draws in, so both share every game, the save file and settings, the LAN stack and the agent status by construction.

- **Recursion guard.** The window's command line carries `--interface terminal`, and the window process takes the arcade lock, so a standalone launch can neither open another window nor a second arcade. An environment marker is set too, but it isn't relied on: Windows Terminal starts new windows from its own process.
- **`auto` never spawns.** Without a TTY it explains how to open a window. Only an explicit choice (`--standalone` or the saved setting) ever opens one.
- **Cleanup.** All terminal state (raw mode, alternate screen, cursor, bracketed paste) is set and restored by `NodeTerminal.start/stop`, which is idempotent and also runs on process exit. `runArcade` routes normal quit, SIGINT/SIGTERM/SIGHUP, stdin EOF, uncaught exceptions and unhandled rejections through it. A standalone window pauses on an error so the message isn't lost when it closes.
- **The agent hook's auto-launch** uses the same `planLaunch` (as a split pane) and opens the menu with `--interface terminal`; it never starts a game.

## Timed and untimed rounds

A round's gameplay deadline is `SessionConfig.durationMs: number | null`; `null` means untimed. It flows unchanged into `GameContext.durationMs`, and `BaseGame` only ends a round with `'time'` when there is a deadline. `GameInstance.timeLeftMs()` returns `null` for untimed rounds, and the HUD shows "NO TIMER" instead of a countdown. The frame loop, `update(dt)` and animations run the same either way. Only the deadline is optional.

- Games declare `untimed: true` when they can be played without a deadline, and optionally `modeNames` (Ski Survival: *Survival Sprint* / *Endless Mountain*). Games that ramp difficulty by elapsed time use `rampProgress(untimedRampMs)`: timed rounds ramp over their duration, untimed ones over a fixed span. Bug Bash replaces the clock with lives when untimed.
- Games that always end on their own (a race ends at the finish line) declare `untimedOnly`: every session for them is untimed, and they never come up as the daily challenge. `retrySameSeed` makes the results screen's replay keep the seed (Time Trial retries the same track).
- Best *times* (lower is better) are kept apart from scores: a game returns `records` in its result, `recordRound` stores each only if it beats the saved one (`save.timeRecords`, with optional ghost samples, size-capped), and games read them back from `GameContext.records`.
- Real-time LAN games set `tickMs` on their `MpGameDefinition`. The server ticks at that rate while their match runs (racing: 33 ms) and goes back to its 200 ms default afterwards. Matches stay plain synchronous state: the racing match advances its simulation to the server clock on every tick and every input.
- `generateSession({ untimed })` never consumes randomness for timing, so a seed reproduces the same round in both modes. Requests that can't be honoured (the daily, custom games) fall back to timed with a `timingNote` shown in the briefing.
- The preference lives in `settings.timing`. Untimed results go to `save.untimedScores` and history entries are tagged `untimed`, so timed records stay comparable.
- Network timeouts (heartbeats, idle and hello timeouts, reconnect grace) live in `src/net` and know nothing about gameplay timing. `host --no-timer` only changes game options.

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
Claude Code ──hook (async, exit 0, no stdout)──▶ vibebreak hook (cli/hook.ts, loads no UI)
   parseHookPayload (metadata only) → lock(session) → applyEvent → tmp+rename
        ▼
   agent/sessions/<session_id>.json    agent/health.json    agent/events.log (debug only)
        │ AgentMonitor.poll() every 500 ms (re-reads only files whose mtime changed)
        ▼
   deriveView(record, now) → pickPrimary(views) → App status line (its own row, every frame)
```

**Root cause of the old stale status (v1).** There was one global `agent-status.json`, written last-writer-wins from four events. That caused four problems:

1. Concurrent sessions overwrote each other.
2. A permission `Notification` left "needs you" on screen until `Stop`, usually for the rest of the turn.
3. An Esc interrupt fires no `Stop`, so "working" stayed for 30 minutes.
4. Async hooks are separate processes with no ordering guarantee, and each one stamped its write with its *finish* time, so a slow earlier hook could overwrite a newer state.

**State machine (`agent-model.ts`).**

- **Ordering:** each event carries its hook process's *spawn* time. Only events at least as new as the one that set the current status may change it; older ones still update tool bookkeeping.
- **Tool tracking:** in-flight tools are tracked by `tool_use_id` (parallel calls work). Recently finished ids are remembered, so a late `PreToolUse` can't resurrect a call.
- **Turns:** a new `UserPromptSubmit` clears stale completion, errors and orphaned tools.
- **Duplicates:** an event is a duplicate if it shares a `prompt_id`/`tool_use_id`, or (for id-less events) arrives within 250 ms of an identical event with nothing in between.
- **Mapping:** the event-to-status table is in the README. Unknown future events count as activity only.

**Derived view.** Silence makes a status less certain, never "completed". An active turn becomes *inferred* after 3 minutes without activity and UNKNOWN after 20. COMPLETED/ERROR settle to IDLE after 30 minutes. The transcript file's mtime counts as activity. The limits can be set with the `VIBEBREAK_AGENT_*_SEC` environment variables.

**Transport.**

- **Files and locking:** one file per session. An O_EXCL lock file serialises one session's hook processes (broken after 3 s; on timeout the hook writes anyway rather than drop the event). Writes are atomic, with retries for Windows `EPERM`/`EBUSY` on rename. A test spawns six concurrent writer processes and checks that no event is lost.
- **Malformed data:** malformed payloads and unreadable files are counted and reported by `doctor`, never fatal.
- **Cleanup:** session files are garbage-collected after 7 days, and orphaned temp/lock files after 1 minute.
- **Hook process:** the hook path calls `process.exit` so it can't linger.

### Future integration points

- **Auto-launch (implemented, opt-in).** `vibebreak hook --launch` (`src/integrations/launcher.ts`) runs on `UserPromptSubmit`. `planLaunch()` is a pure function that picks a Windows Terminal split, a tmux split, an iTerm2 split, Terminal.app, `$TERMINAL`, or a new console window. The child is spawned detached and unref'd with no stdio. `arcade.lock` (pid plus a liveness check) prevents duplicates, and `last-launch.json` enforces a 60-second gap. Launched sessions use `play --from-hook`, which shortens the countdown to 2 seconds.
- **Other agents.** `vibebreak hook` accepts any JSON with `hook_event_name` and `session_id`. The model encodes *Claude Code* event semantics, so another agent should go through a small adapter that maps its own events onto those meanings, not be assumed identical. Auto-launched games receive `--agent-session <id>` and follow that session.
- **Agent-aware rounds.** An optional mode that ends the round gracefully (with the usual warning) when the agent reports *done*.

## LAN multiplayer

```
 player terminal                      host process                          player terminal
 ┌──────────────┐   TCP, NDJSON v1   ┌───────────────────────────────┐     ┌──────────────┐
 │ App loop     │ ─── hello/action ─>│ LanServer (sockets, limits)   │<────│ App loop     │
 │  LanScreen   │<── lobby/view/ack ─│   Lobby (seats, host cmds)    │────>│  LanScreen   │
 │  game UI     │                    │     MpMatch (game rules)      │     │  game UI     │
 └──────────────┘                    └───────────────────────────────┘     └──────────────┘
                                       host's own App joins via loopback
```

- **Server-authoritative.** `MpMatch` implementations are synchronous and pure like solo games: no sockets, timers or terminal access. The lobby feeds them validated actions and `tick(now)`, and asks `viewFor(playerId)` for each viewer. Views are diffed per player as JSON and only sent when they change. Small deltas, such as Doodle strokes, go out as events with a revision number. A client that sees a gap asks for a snapshot.
- **One networking stack.** Framing, size limits, rate limits, heartbeats, reconnection, kick/ban, spectators, chat, rematches and party mode live in `src/net`. Games only implement rules and views.
- **The host is a client too.** The hosting player's App connects to its own server over loopback with a secret host key. Host and guests share one code path, and the dedicated host (`--dedicated`) is the same server without a UI.
- **Terminal safety.** Network callbacks only update `LanClient` state. The App's single loop renders it on the next frame, and its single input handler routes keys. Nothing in `src/net` writes to the terminal, so live updates can't tear frames or fight over stdin. AI-status polling keeps running in the same loop and isn't blocked by networking.
- **Trust.** Identity comes from the connection, not from what the client claims. Client-sent scores, outcomes and positions don't exist in the protocol. Strings are cleaned on the server, and again on each client before rendering.
- **Persistence.** When a match ends, each client records the server-reported result for its own player in `save.lan`. That feeds stats and the four LAN achievements.

See [LAN.md](LAN.md) for the user guide, protocol summary and limitations.

## Testing strategy

| Layer | How |
|---|---|
| Pure logic | Unit tests for the RNG, session generator, every game's rules (scoring, combos, collisions, alignment, typing accuracy, dungeon connectivity), progression, storage, the arg parser and the key parser |
| Robustness | Each game is fuzzed with random input over 25 seeds and random modifiers. The tests check it never throws, that render lines fit `minSize`, that the round ends on time and that the game is inert afterwards, plus reproducibility and an 80×24 fit check |
| App flow | `App` is driven with `FakeTerminal` and `FakeScheduler`: full menu-to-results flow, pause clock freeze, restart, reroll, resize pause, stats reset, Ctrl+C timer cleanup and the frame-diff size |
| Real terminal | `scripts/pty-smoke.py` runs the built binary in a PTY with a VT100 emulator: menus, all seven games, pause, the time limit, Ctrl+C exit code and terminal restoration, resize, daily, and corrupted-save recovery |
