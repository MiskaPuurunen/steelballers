# VibeBreak

**Your AI is thinking. You're playing.**

VibeBreak is a terminal arcade for developers who work with AI coding agents like Claude Code and Codex. While the agent writes, debugs or refactors, you play a 20–60 second keyboard game in your terminal instead of opening social media. When the round ends you get your score, some XP, and a one-key exit back to work.

- **5 minigames:** Bug Bash, Terminal Snake, Code Sprint, Stack Overflow and Dependency Dungeon.
- **Random sessions:** each round rolls a game, a difficulty and a modifier such as *Overclocked*, *Glass Cannon* or *Chaos Mode*. Runs are seeded, so any session can be replayed exactly.
- **Daily challenge:** one seed per day, the same for everyone, with a share card you can paste.
- **Progression:** high scores, XP, levels and 13 achievements. All of it is stored locally, with no account and no telemetry.
- **Optional Claude Code integration:** the HUD shows *AI working / AI done* while you play in another terminal.
- **Zero runtime dependencies.** Node 18+ on Windows Terminal/PowerShell, macOS and Linux.

```
██╗   ██╗██╗██████╗ ███████╗██████╗ ██████╗ ███████╗ █████╗ ██╗  ██╗
██║   ██║██║██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗██║ ██╔╝
██║   ██║██║██████╔╝█████╗  ██████╔╝██████╔╝█████╗  ███████║█████╔╝
╚██╗ ██╔╝██║██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██╔══╝  ██╔══██║██╔═██╗
 ╚████╔╝ ██║██████╔╝███████╗██████╔╝██║  ██║███████╗██║  ██║██║  ██╗
  ╚═══╝  ╚═╝╚═════╝ ╚══════╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝

YOUR AI IS THINKING. YOU'RE PLAYING._

>  [1] QUICK PLAY  random game, random modifier
   [2] ARCADE
   [3] DAILY CHALLENGE
   [4] STATS & ACHIEVEMENTS
   [Q] QUIT
```

More screenshots, captured from a real terminal session, are in [`docs/screens/`](docs/screens).

---

## Install and run

Requirements: **Node.js 18 or newer**.

```bash
git clone <this repo> vibebreak
cd vibebreak
npm install
npm run build
npm link            # optional: puts `vibebreak` on your PATH
vibebreak           # or: node dist/cli/index.js
```

Without `npm link`, run `npm start` for the menu, or `node dist/cli/index.js play`.

During development, `npm run dev -- play --game snake` runs the TypeScript source directly through `tsx` with no build step.

## Commands

| Command | What it does |
|---|---|
| `vibebreak` | Open the arcade menu |
| `vibebreak play` | Start a random minigame right away (a short briefing counts down first) |
| `vibebreak play --game snake` | Play a specific game: `bugbash`, `snake`, `codesprint`, `stack`, `dungeon` |
| `vibebreak play --duration 30` | Set the round's time limit in seconds (15–300) |
| `vibebreak play --random --duration 30` | Explicit random game (`play` is random by default) |
| `vibebreak play --seed K7Q2-M9XA` | Replay an exact session |
| `vibebreak play --modifier chaos --difficulty hard` | Force a modifier and/or difficulty |
| `vibebreak daily` | Today's seeded challenge (UTC date, the same for everyone) |
| `vibebreak list` | List games and modifiers |
| `vibebreak stats` | Scores, level and achievements (`--json` for raw data) |
| `vibebreak reset` | Erase local stats (asks for confirmation; `--yes` skips it) |
| `vibebreak hook install` | Show how to connect Claude Code (optional) |
| `vibebreak --help` / `--version` | Usage / version |

**What `--duration` means:** it sets the round's maximum length. A round can end sooner, for example when the snake crashes or the tower topples. The HUD timer turns yellow at 10 seconds left, and the last 5 seconds are counted down on screen, so a round never stops without warning. Each game has its own default (30–60s). The daily challenge always uses the default so scores can be compared.

### Controls that work everywhere

| Key | Action |
|---|---|
| `Esc` | Pause. The clock stops, and you can resume, restart or end the round |
| `Ctrl+C` | Exit immediately. The terminal is always restored |
| `Enter` | Confirm / start now |
| `R` (briefing) | Reroll a different random session |
| `Q` (results) | Quit straight back to your shell |

## The games

### Bug Bash: reaction & precision (30s)
A 3×3 grid laid out like your keyboard's left hand: **Q W E / A S D / Z X C** (the numpad's 7–9 / 4–6 / 1–3 also work). Bugs `>(o.o)<` appear in cells. Press a cell's key to squash its bug before the bug escapes. Golden bugs `$(O.O)$` are worth 3×. Features `<feat/>` must **not** be squashed. Consecutive hits build a combo multiplier (×1.5 every 5 hits, up to ×4), and faster hits score more. A wrong key resets your combo and takes 1.5 seconds off the clock. Bugs spawn faster as the round goes on, and a surprise *swarm* drops several bugs at once.

### Terminal Snake: arcade classic (45s)
Steer with **arrows, WASD or HJKL**. Eat `<>` to grow. Bonus `$$` food appears now and then and fades after 5 seconds. Boards are generated at random as *open*, *pillars*, *walls* or *cross*, and every layout is checked with a flood fill so the whole board is reachable. Speed increases with each bite. Turn presses are buffered (up to 2) and reversals are ignored, so a fast double-tap does what you meant.

### Code Sprint: typing under pressure (30s)
Type programming snippets as fast and cleanly as you can: Git commands, shell one-liners, SQL, JS/TS/Python/Rust fragments and dev vocabulary. Characters you typed correctly turn green and mistakes turn red. Fix mistakes with Backspace. The HUD tracks live WPM and accuracy. Clean snippets earn ×1.5 and golden snippets ×2. Snippets get longer as you progress. **All challenge text is inert:** it is compared character by character and is never parsed or executed (a test enforces this).

### Stack Overflow: timing & precision (45s)
A block slides back and forth. Press **Space** to drop it. Any overhang is sliced off, so the platform shrinks. A perfect drop keeps the block's full width, and three perfect drops in a row grow it back by one. The round ends if a block misses the tower completely. On Easy, a drop that is off by one cell still counts as perfect.

### Dependency Dungeon: mini roguelike (60s)
A turn-based dungeon, procedurally generated on every run. Collect every dependency `&`, then *publish* at the `>` gate. Bump into bugs (`b` flaky test, `n` NaN, `G` God Object) to fight them. Watch out for `^` breaking changes (traps), pick up `+` hotfix patches to heal, and collect `*` GitHub stars for points. Fog of war rewards exploration, and enemies chase you once you're close. Wild bugs can also spawn mid-run. Every map is checked for connectivity: the exit and all items are always reachable, and enemies never start within 6 steps of you.

## Random sessions and modifiers

Every round rolls a **game** (weighted, never the same game twice in a row), a **difficulty** (Easy / Normal / Hard), a **modifier** and game-specific content such as layouts, spawn timing, snippet order and dungeon maps. The briefing screen shows all of it, including the seed, before play starts. Press `R` to reroll.

| Modifier | Effect |
|---|---|
| Standard Build | No modifier |
| Overclocked | Everything 30% faster, points ×1.25 |
| Bug Bounty | Bonus targets appear more often and are worth 2× |
| Low Battery | Only 3 mistakes allowed, points ×1.2 |
| Double XP | 2× XP for the round |
| Glass Cannon | Points ×1.5, mistakes hurt 2× |
| Chaos Mode | A random mix of the above, plus surprise events (swarms, the snake's food relocating, CAPS LOCK snippets, speed glitches, merge-conflict spawns) |

Games can exclude modifiers that make no sense for them. Snake, for example, never rolls Low Battery, because one crash already ends the round.

Seeds are fully deterministic: `vibebreak play --seed K7Q2-M9XA` reproduces the same game, difficulty, modifier and content. Tests rely on this, and it makes bug reports reproducible.

## Progression

- High score per game, plus game-specific personal bests (best combo, longest snake, top WPM, tallest tower, dungeon escapes).
- XP comes from score (normalised per game), with bonuses for perfect rounds, new personal bests and the daily challenge. XP per round is capped, so skill matters more than grinding.
- 13 achievements, including *Back to Work*: finish a round and quit straight back to your code. Leaving is rewarded on purpose.
- Nothing decays and there are no streak-loss mechanics. Stopping costs you nothing.

## Save file and configuration

Stats live in one small JSON file:

| OS | Location |
|---|---|
| Windows | `%APPDATA%\vibebreak\save.json` |
| macOS | `~/Library/Application Support/vibebreak/save.json` |
| Linux | `$XDG_CONFIG_HOME/vibebreak/save.json` (default `~/.config/vibebreak/`) |

Set `VIBEBREAK_HOME=/some/dir` to override the location. `vibebreak stats` prints the exact path.

- Writes are atomic: the data goes to a temporary file that is then renamed over the save.
- If the save file is unreadable, it is kept as `save.json.corrupt-<timestamp>`, a fresh save is started, and the menu tells you.
- Unknown or invalid fields are dropped, not trusted.
- No network requests, telemetry or account, ever.

Colour: VibeBreak respects `NO_COLOR` and `--no-color`, and falls back to plain text when output isn't a TTY or `TERM=dumb`. It uses only the 16 standard ANSI colours, so it looks right in Windows Terminal, PowerShell, macOS Terminal, iTerm2 and Linux terminals.

## Claude Code integration (optional)

VibeBreak is a standalone game first. The integration is a one-way **status beacon**. Claude Code hooks write a tiny status file, and VibeBreak, running in another terminal, shows `[AI working]`, `[AI needs you]` or a flashing `AI DONE` in its HUD. You decide when to stop playing; it never interrupts a round.

```bash
vibebreak hook install    # prints the settings snippet and instructions
```

Add the printed snippet to `~/.claude/settings.json`, or add it via `/hooks` inside Claude Code:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "vibebreak hook", "async": true, "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "vibebreak hook", "async": true, "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "vibebreak hook", "async": true, "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "vibebreak hook", "async": true, "timeout": 5 }] }]
  }
}
```

Then run `vibebreak` in a second terminal while Claude works.

These choices were made against the current [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks):

- **`async: true`**: the hook runs in the background and cannot block Claude.
- **Prints nothing and always exits 0.** For `UserPromptSubmit`, plain stdout would be added to Claude's context, and exit code 2 would block the prompt (for `Stop`, exit 2 would stop Claude from finishing). VibeBreak avoids both.
- Reads only `hook_event_name` from the hook's stdin JSON. Prompt text and transcripts are never stored. The status file holds just `{state, event, at, agent}`.
- Never approves tools, never touches permissions, never edits project files, never reads or writes the agent's terminal.
- If the `vibebreak` binary is missing, Claude Code only shows a non-blocking hook error. To remove the integration, delete the four entries (`vibebreak hook uninstall` prints instructions).

`vibebreak hook status` shows the last state that was recorded.

**Not included (on purpose):** auto-launching a game window from a hook. Opening a new terminal works differently on every OS and terminal emulator, and doing it from inside an agent's lifecycle risks stealing focus or input. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#future-integration-points) for the planned approach.

## Development

```bash
npm install
npm run dev              # run from source (tsx)
npm test                 # vitest: 111 tests
npm run typecheck
npm run build            # compile to dist/
python3 scripts/pty-smoke.py   # real-terminal smoke test (needs: pip install pyte; npm run build)
```

The PTY smoke test launches the built CLI in a real pseudo-terminal, sends keystrokes, renders the output with a VT100 emulator and checks:

- every game starts and runs
- Esc pauses
- Ctrl+C exits with code 0 and restores the cursor and alternate screen
- the time limit ends a round
- shrinking the window shows the too-small notice
- a corrupted save is recovered

### Adding a minigame

1. Create `src/games/mygame.ts` with a class extending `BaseGame`. Implement `onKey`, `tick`, `render`, `hud`, `stats`, `metrics` and `isPerfect`, and use `addScore` / `penalize` / `flash` / `end`. `BaseGame` already handles the round clock, modifier multipliers and end-of-round state.
2. Export a `GameDefinition` with `id`, `name`, `genre`, `tagline`, `controls`, `weight`, `defaultDurationSec`, `xpScale` and `create(ctx)`.
3. Add it to `GAMES` in `src/games/index.ts`.

That's it. Random selection, the menu, the arcade list, stats, XP and the fuzz/lifecycle tests all pick it up automatically. Use `this.rng` for all randomness so seeds stay reproducible, and never create timers or key listeners. The shell calls `update(dt)` and `handleInput(key)` for you.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Terminal too small" | Every game fits **80×24**; the menu needs 40×14. Enlarge the window. The game pauses until it fits |
| Box characters in the logo look broken | Use a font with box-drawing glyphs (Cascadia, Menlo, DejaVu Sans Mono…). Below 70 columns the logo switches to a compact text version |
| Colours look wrong / you want none | `vibebreak --no-color` or `NO_COLOR=1` |
| Arrow keys don't work on old Windows conhost | Use Windows Terminal, or WASD/HJKL |
| "needs an interactive terminal" | The arcade needs a TTY. Run it directly, not through a pipe |
| Terminal left in a weird state after a crash | Run `reset` (macOS/Linux). VibeBreak restores the terminal on exit, Ctrl+C, SIGTERM and uncaught errors, so please report it with the seed |
| Want a clean slate | `vibebreak reset` |

## Project docs

- [Architecture](docs/ARCHITECTURE.md)
- [Business plan](docs/BUSINESS_PLAN.md)
- [Pitch outline, demo script and judge Q&A](docs/PITCH.md)

## License

MIT © 2026 Matei Stefan Crisan
