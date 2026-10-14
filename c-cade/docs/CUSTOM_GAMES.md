# Custom games (Lua)

You can write your own C-Cade minigame as a single Lua 5.4 script and play it from the arcade. It gets the same treatment as the built-in games: the briefing screen, seeds, difficulty, modifiers, pause, the HUD and the results screen.

Open **[5] CUSTOM GAMES** in the main menu, then:

| Key | Action |
|---|---|
| `N` | Open the editor with a working example (Packet Catcher) |
| `P` | Paste or write code in the editor. `Ctrl+S` checks it and adds it |
| `F` | Load a `.lua` file by path. Dragging a file into the terminal pastes its path |
| `R` | Reload the folder (handy if you edit the files in your own editor) |
| `X` | Delete the selected game (press twice) |
| `Enter` | Play |

Every script you add is checked first. C-Cade loads it, runs `init()` and plays a few seconds of random input headlessly. Errors are shown with a line number, and in the editor the cursor jumps to that line. A script that passes the check is copied to the `games` folder next to your save file (`%APPDATA%\c-cade\games` on Windows, `~/.config/c-cade/games` on Linux). Any `.lua` file you put in that folder yourself shows up too.

Custom games never give XP, never unlock achievements and are never picked by Quick Play or the daily challenge. Your best score per custom game is kept.

Custom games are single-player. LAN multiplayer (**[4] MULTIPLAYER** in the menu, see [LAN.md](LAN.md)) uses its own built-in games; a Lua script can't be played over the network.

## The smallest game

```lua
game = { id = "clicker", name = "Clicker", min_size = { w = 20, h = 3 } }

local presses = 0

function on_key(key)
  if key.name == "space" then
    presses = presses + 1
    vb.score(10)
  end
end

function render()
  return { "Press Space!", "", "Presses: " .. presses }
end
```

## The `game` table

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | 1-24 characters: lowercase letters, digits and dashes. Also the file name. Adding a script with an existing id updates that game |
| `min_size` | yes | `{ w = 10..78, h = 3..18 }`, the area `render()` draws into. Larger values are clamped so the game fits an 80x24 terminal |
| `name` | no | Up to 24 characters (defaults to the id) |
| `genre`, `tagline` | no | Shown in the list and on the briefing screen |
| `duration` | no | Ignored. Rounds have no clock any more; the field is still accepted so older scripts load |
| `controls` | no | Up to 6 rows of `{ "keys", "what they do" }` for the briefing screen |

## Callbacks

All of them are optional. Define the ones you need as global functions.

| Function | Called |
|---|---|
| `init()` | Once at the start of each round (also on restart) |
| `update(dt)` | About 30 times a second while the round runs. `dt` is in milliseconds |
| `on_key(key)` | For each key press. `key.name` is one of `up down left right enter space backspace tab char`; `key.ch` is the character for `char` and `space`; `key.ctrl` is true for Ctrl combinations. Esc and Ctrl+C never reach the game |
| `render()` | Return a table of strings (one per line) or a single string with `\n`. Lines are clipped to `min_size` |
| `hud()` | Return up to 6 `{ label = "...", value = "...", tone = "good" }` items for the HUD bar |
| `metrics()` | Return up to 8 `{ "label", "value" }` pairs for the results screen |
| `perfect()` | Return `true` for a flawless round |

### Colour in `render()`

Plain text is drawn as-is. Use tags to colour parts of a line: `{good}`, `{bad}`, `{gold}`, `{info}`, `{accent}`, `{muted}` and `{bold}` start a style, `{/}` ends it, and `{{` prints a literal `{`. Raw escape sequences and control characters are removed. Stick to single-width characters (no emoji or CJK) so columns line up.

## The `vb` table

| Name | What it does |
|---|---|
| `vb.score(n)` | Add points. The modifier's score multiplier is applied. Returns the points actually added |
| `vb.penalize(n)` | Subtract points (scaled by the penalty multiplier; never below 0) |
| `vb.flash(text, tone, ms)` | Short message under the game. `tone` is `good`, `bad`, `gold` or `info` |
| `vb.finish(reason)` | End the round: `"win"` or `"gameover"`. Rounds have no clock, so this is how a game ends (the player can always end it from the pause menu too) |
| `vb.random()` | Float in [0, 1) from the round's seed |
| `vb.randint(a, b)` | Integer in [a, b] |
| `vb.chance(p)` | `true` with probability `p` |
| `vb.elapsed()` | Milliseconds played in the round |
| `vb.time_left()` | Always `math.huge`: there is no deadline. Kept for older scripts |
| `vb.get_score()` | Current score |
| `vb.difficulty` | `"easy"`, `"normal"` or `"hard"` |
| `vb.speed` | Speed multiplier from the modifier (1 = normal, 1.3 = Overclocked) |
| `vb.special` | Bonus multiplier (2 under Bug Bounty) |
| `vb.penalty`, `vb.score_mult` | Penalty and score multipliers (already applied by `score`/`penalize`) |
| `vb.lives` | Mistakes allowed under Low Battery, otherwise `nil` |
| `vb.chaos` | `true` in Chaos Mode, a hint to trigger surprise events |
| `vb.duration` | Always `0` (no deadline). Kept for older scripts |

Always use `vb.random` and friends for randomness. `math.random` is not available, which keeps every run reproducible from its seed.

## Sandbox and limits

Scripts are untrusted code, so they run in a sandbox:

- Lua runs inside WebAssembly. Only `string`, `table`, `math` (without `random`), `utf8`, `coroutine` and the basic functions are available. There is no `io`, `os`, `require`, `load`, `debug` or `collectgarbage`, so a script can't touch files, the network or the terminal.
- Each callback has a budget of 500,000 Lua instructions and at most 50 ms. A script that loops forever ends the round with a "script ran too long" error. `pcall` and coroutines can't get around this.
- Each game has a 32 MB memory cap, and scripts are limited to 128 KB.
- Only plain text crosses back to the host, and it is sanitized before it is drawn.

Do not paste code you don't understand from strangers anyway. The sandbox stops it from doing harm, but it can't stop a game from being boring.

## Requirements

Custom games need the `wasmoon` package (Lua 5.4 compiled to WebAssembly, no native build step). It is an optional dependency and is installed by `npm install` by default. If it is missing, the Custom Games screen says so and the rest of C-Cade works as before.
