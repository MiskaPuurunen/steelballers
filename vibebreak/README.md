# VibeBreak

**Your AI is thinking. You're playing.**

VibeBreak is a terminal arcade for developers who work with AI coding agents like Claude Code and Codex. While the agent writes, debugs or refactors, you play a 20–60 second keyboard game in your terminal instead of opening social media. When the round ends you get your score, some XP, and a one-key exit back to work.

- **10 minigames:** Bug Bash, Terminal Snake, Ski Survival, Stack Overflow, Dependency Dungeon, Crossy Prod, Tetris, and **VibeBreak Racing** in three modes: Grand Prix, Time Trial and Highway.
- **Timed or untimed:** every built-in game can be played without a countdown (`--no-timer`, or **[8] SETTINGS > Timer** in the menu). Untimed rounds end on game over or when you choose to stop.
- **Random sessions:** each round rolls a game, a difficulty and a modifier such as *Overclocked*, *Glass Cannon* or *Chaos Mode*. Runs are seeded, so any session can be replayed exactly.
- **Daily challenge:** one seed per day, the same for everyone, with a share card you can paste.
- **LAN multiplayer:** host a lobby, friends join from their own terminals on the same network. **Battleship** (versus), **VibeBreak Racing** (2-8 drivers, real time), **Prompt Panic** (write the funniest answer, vote anonymously) and **Doodle Protocol** (ASCII draw-and-guess), or a random **Party Mix**. Server-authoritative, no accounts, no internet. See [docs/LAN.md](docs/LAN.md).
- **Progression:** high scores, XP, levels and 20 achievements. All of it is stored locally, with no account and no telemetry.
- **Optional Claude Code integration:** a status line shows what Claude is doing (thinking, running a tool, waiting for you, done) while you play, per session, with how fresh the information is.
- **Themes:** Classic, Christmas, Halloween, Frutiger Aero, Synthwave, Matrix and Amber CRT, plus a Seasonal option that switches by date. Each theme recolours the whole arcade and adds its own ambient effects (snow, bats, bubbles, digital rain…) around the menus.
- **Custom games:** write your own minigame in Lua, paste it or load the file from the menu, and play it like a built-in one. Scripts run in a sandbox.
- **No required runtime dependencies.** Node 18+ on Windows Terminal/PowerShell, macOS and Linux. Custom games use the optional `wasmoon` package (Lua in WebAssembly).

```
██╗   ██╗██╗██████╗ ███████╗██████╗ ██████╗ ███████╗ █████╗ ██╗  ██╗
██║   ██║██║██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗██║ ██╔╝
██║   ██║██║██████╔╝█████╗  ██████╔╝██████╔╝█████╗  ███████║█████╔╝
╚██╗ ██╔╝██║██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██╔══╝  ██╔══██║██╔═██╗
 ╚████╔╝ ██║██████╔╝███████╗██████╔╝██║  ██║███████╗██║  ██║██║  ██╗
  ╚═══╝  ╚═╝╚═════╝ ╚══════╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝

YOUR AI IS THINKING. YOU'RE PLAYING._

>  [1] QUICK PLAY  random game, random modifier
   [2] GAMES
   [3] DAILY CHALLENGE
   [4] MULTIPLAYER
   [5] CUSTOM GAMES
   [6] STATS & ACHIEVEMENTS
   [7] AGENT STATUS
   [8] SETTINGS
   [9] HELP & ABOUT
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

**In VS Code:** open the integrated terminal (``Ctrl+` ``) and run `vibebreak` (or `npm start`). The arcade draws inside the terminal panel; make the panel at least 80×24, or run `vibebreak --standalone` to give it its own window. See [Where it runs](#where-it-runs-this-terminal-or-its-own-window).

**Windows PowerShell 5.1** (the built-in one) doesn't support `&&`. Run the commands one per line, or separate them with `;`:

```powershell
npm install; npm run build; node dist/cli/index.js
```

PowerShell 7+ and Windows Terminal with PowerShell 7 accept `&&` as written.

During development, `npm run dev -- play --game snake` runs the TypeScript source directly through `tsx` with no build step.

### For everyone else: one command, no clone (once published to npm)

```bash
npx vibebreak-cli play          # try it instantly
npm install -g vibebreak-cli    # keep it: then just `vibebreak`
vibebreak hook install --launch # optional: auto-open a game whenever Claude starts working
```

The package is named `vibebreak-cli` because `vibebreak` on npm belongs to an unrelated project. The command you type is still `vibebreak`. To publish: `npm login`, then `npm publish` from this folder (`prepublishOnly` runs the typecheck, the tests and the build first).

Use a global install for the hook setup. `npx` runs from a temporary cache, so the hook paths would point somewhere that can disappear.

## Where it runs: this terminal or its own window

`vibebreak` always opens the **main menu**. Nothing starts until you pick something: not a saved preference, not the AI agent getting busy. Choose *where* the arcade draws with `--interface`, or save a default in **[8] SETTINGS > Interface**.

| Command | What happens |
|---|---|
| `vibebreak` | The saved interface (default `auto`) |
| `vibebreak --interface terminal` | Runs right here. Works in the **VS Code integrated terminal**, Windows Terminal, PowerShell, iTerm2, Terminal.app, tmux and most Linux terminals |
| `vibebreak --interface standalone` (or `--standalone`) | Opens a **new terminal window** running the arcade and gives this terminal back. Same save file, settings, LAN games and agent status |
| `vibebreak --interface auto` | This terminal. With no terminal at all (a pipe, a script) it explains how to open a window instead of opening one by itself |
| `vibebreak --list-interfaces` | What each option does, which terminal was detected, and what `vibebreak` would do here |

The flag works with every interactive command (`vibebreak play --game snake --standalone`, `vibebreak host --standalone`...). The command line always beats the saved setting.

**How the window opens:**

| Platform | Window |
|---|---|
| Windows inside Windows Terminal | a new Windows Terminal window (`wt -w new`) |
| Windows elsewhere (VS Code, PowerShell, cmd) | a new console window (`start`), which is Windows Terminal if it's your default terminal app |
| macOS | a new Terminal.app window |
| Linux | `$VIBEBREAK_TERMINAL`, else `$TERMINAL`, else `x-terminal-emulator` when a desktop session is running (inside tmux: a new tmux window) |

**Safety:** a standalone window never opens a second arcade (if one is already running you're told so), and the window itself always runs with `--interface terminal`, so it can't open another window. If no window can be opened (no desktop, terminal not installed), VibeBreak says why and starts in the current terminal instead. If the arcade hits an error inside a standalone window, the window waits for Enter so you can read the message.

## Commands

| Command | What it does |
|---|---|
| `vibebreak` | Open the arcade menu |
| `vibebreak play` | Start a random minigame right away (a short briefing counts down first) |
| `vibebreak play --game snake` | Play a specific game: `bugbash`, `snake`, `ski`, `stack`, `dungeon`, `crossy`, `tetris`, `racing`, `timetrial`, `highway` |
| `vibebreak play --duration 30` | Set the round's time limit in seconds (15–300) |
| `vibebreak play --game snake --no-timer` | Untimed round: no countdown, play until game over or Esc (`--untimed` works too) |
| `vibebreak play --game ski --mode endless` | Ski Survival's Endless Mountain (`--mode sprint` = Survival Sprint, timed) |
| `vibebreak play --timer` | Force a timed round when your saved preference is untimed |
| `vibebreak play --random --duration 30` | Explicit random game (`play` is random by default) |
| `vibebreak play --seed K7Q2-M9XA` | Replay an exact session |
| `vibebreak play --modifier chaos --difficulty hard` | Force a modifier and/or difficulty |
| `vibebreak daily` | Today's seeded challenge (UTC date, the same for everyone) |
| `vibebreak list` | List games and modifiers |
| `vibebreak stats` | Scores, level and achievements (`--json` for raw data) |
| `vibebreak theme` / `vibebreak theme <id>` | List the themes / set one (saved) |
| `vibebreak --theme matrix` | Use a theme for this run only (works with any command) |
| `vibebreak reset` | Erase local stats (asks for confirmation; `--yes` skips it) |
| `vibebreak hook install` | Show how to connect Claude Code (optional) |
| `vibebreak doctor` | Is the Claude Code integration configured, and is it actually receiving events? (`--json` too) |
| `vibebreak hook status` | One-line summary of the AI status the HUD would show |
| `vibebreak hook debug on\|off` | Log every status event and transition (no prompt text) for troubleshooting |
| `vibebreak host` | Host a LAN lobby (`--game battleship\|prompt-panic\|doodle-protocol`, `--party`, `--port`, `--max-players`, `--set key=value`) |
| `vibebreak join 192.168.1.42` | Join a LAN game (`--port 7777` or `host:port`; no address = browse rooms) |
| `vibebreak rooms` | List VibeBreak rooms on your network (`--json` too) |
| `vibebreak host --dedicated` | Headless LAN server with a text console (no TTY needed) |
| `vibebreak --help` / `--version` | Usage / version |

**What `--duration` means:** in a timed round it sets the maximum length (it can't be combined with `--no-timer`). A round can end sooner, for example when the snake crashes or the tower topples. The HUD timer turns yellow at 10 seconds left, and the last 5 seconds are counted down on screen, so a round never stops without warning. Each game has its own default (30–60s). The daily challenge always uses the default so scores can be compared.

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

### Ski Survival: downhill survival (60s, or endless)
Race down an endless, procedurally generated mountain drawn in multi-line ASCII art. The slope scrolls toward your skier, who leans into turns, crouches to tuck, snowploughs to brake and spins or grabs in big air. Dodge snow-covered pines, spruces, evergreens and windblown trees, rocks and snowmen. Moguls `_/^\_` slow you down. Jump over rocks and crevasses `\VVVV/`, hit ramps `.^^^.` for big air, and collect ski tokens `(*)`, gold `[$]` and hot cocoa `[_]D` (an extra life). Snow falls, gusts of wind sway the trees, and the forest lines the slope.

- **Fair collisions:** only the solid part of each sprite can hit you: a tree's trunk and the core of its lowest boughs, the body of a rock or snowman. Brushing the outer branches is safe. Your skis are the part of the skier that collides.
- **Any terminal size:** at 80 columns you see the whole slope plus the forest either side. Narrower terminals (down to 40 columns) get a camera that follows the skier, with compact art. Colour helps but isn't needed: every shape reads in monochrome.

| Key | Action |
|---|---|
| `A`/`D` or `←`/`→` | Carve left / right |
| `W` or `↑` | Jump. In big air off a ramp: **Spin** trick |
| `S` or `↓` | Tuck: faster, 2× distance points. In big air: **Grab** trick |
| `Space` | Brake |
| `P` / `R` / `Q` | Pause / restart / end the run (`Esc` also pauses) |

- **Lives:** you have 3 lives (Low Battery: 3, up to 5 with cocoa). A wipeout costs a life and 40 points, slows you down and gives 1.5 s of invincibility. Trees and snowmen are tall, so they hit you even mid-jump. Landing on a crevasse is fatal, whatever lives you have left.
- **Scoring:** 1 point per metre (2 while tucked), plus 25 per token, 100 per gold token, 15 for jumping a rock, 25 for clearing a crevasse and 50 for big air. Each trick is worth 100 when you land cleanly, doubled if you land two in one jump. A crash in the air loses the tricks.
- **Difficulty:** speed and obstacle density rise with distance. Snowmen, moguls, ramps and finally crevasses (from 150–400 m depending on difficulty) appear as you go.
- **Fair by design:** the generator always keeps a safe line, 3 columns wide and drifting at most one column per row, free of anything that can hurt you, so there is never an unavoidable wall. The art of anything that can hurt you never covers that line either, and sprites never overlap, so nothing hides behind a tree. Top speed is capped so you always get at least ~0.75 s to react. Tests check this across thousands of generated rows, and an autopilot skis 20 minutes on Hard without a crash.
- **Two modes:**
  - **Survival Sprint** (timed, 60 s by default): score as much as you can before time runs out.
  - **Endless Mountain** (untimed): no countdown, ever. You ski until you run out of lives, fall into a crevasse or quit. Distance, speed, lives and your best stay on screen.

  Pick the mode with `T` in the briefing, `--mode sprint|endless`, or **[8] SETTINGS > Timer**.

### Stack Overflow: timing & precision (45s)
A block slides back and forth. Press **Space** to drop it. Any overhang is sliced off, so the platform shrinks. A perfect drop keeps the block's full width, and three perfect drops in a row grow it back by one. The round ends if a block misses the tower completely. On Easy, a drop that is off by one cell still counts as perfect.

### Dependency Dungeon: mini roguelike (60s)
A turn-based dungeon, procedurally generated on every run. Collect every dependency `&`, then *publish* at the `>` gate. Bump into bugs (`b` flaky test, `n` NaN, `G` God Object) to fight them. Watch out for `^` breaking changes (traps), pick up `+` hotfix patches to heal, and collect `*` GitHub stars for points. Fog of war rewards exploration, and enemies chase you once you're close. Wild bugs can also spawn mid-run. Every map is checked for connectivity: the exit and all items are always reachable, and enemies never start within 6 steps of you.

### Crossy Prod: endless hopper (45s)
A Crossy Road-style run. Hop your `{}` hotfix forward with **arrows, WASD or HJKL** (Space also hops forward). Dodge `<==` CI pipelines on the roads, ride `[]` logs across the `~~` data lake (miss one and you sink, ride it off-screen and you're swept out of scope), and get off the tracks when the rail's edge flashes `!` because the release train doesn't stop. Trees `/\` block your path and `$$` coins are worth bonus points. Every new lane scores, and the world is generated forever ahead of you. Stand still too long and a code reviewer swoops in: the HUD's *REVIEW IN* timer resets each time you reach a new lane. Grass lanes are checked so trees can never wall you in.

### Tetris: block puzzle (90s)
The classic, in plain ASCII. All seven tetrominoes come from a **7-bag** randomizer, so every seven pieces contain each shape once, and the seed reproduces the exact sequence. It uses SRS rotation with wall and floor kicks, a ghost piece `::` showing where the piece will land, a two-piece NEXT preview, and a 500 ms lock delay that resets when you move or rotate (up to 15 times).

| Key | Action |
|---|---|
| `←` `→` / `A` `D` | Move |
| `↑` / `W` / `X` | Rotate clockwise |
| `Z` | Rotate counterclockwise |
| `↓` / `S` | Soft drop (+1 per row) |
| `Space` | Hard drop (+2 per row) |
| `P` | Pause / resume |
| `R` | Restart the round |
| `Q` / `Esc` | End the round (Q) or open the pause menu (Esc) |

Clearing 1, 2, 3 or 4 lines at once scores 100, 300, 500 or 800 × level. You level up every 10 lines (Easy starts at level 1, Normal at 2, Hard at 4), and gravity follows the guideline curve, so pieces fall faster each level. If a new piece can't spawn, you've topped out and the game is over. The side panel shows score, level, lines and your personal best, and the controls stay on screen the whole time. The well is 10 × 16 rather than the usual 20 rows, so the game fits an 80 × 24 terminal with the HUD. Chaos Mode pushes up a garbage line every 12–18 seconds ("Merge conflict!"). Low Battery and Glass Cannon are never rolled for Tetris, because it has no lives or penalties.

### VibeBreak Racing: Grand Prix, Time Trial and Highway
A top-down ASCII racer on a vertically scrolling road: dashed lanes, red-and-white kerbs, grass verges, barriers, curves that sweep across the screen, roadside trees and rocks (borrowed from Ski Survival), and rain, snow, dusk or night. Your car sits near the bottom so most of the screen is road ahead, and a `!` at the top edge warns about hazards just over the horizon. Rivals carry name tags and their own colours, and far-away cars are drawn smaller.

| Mode | Arcade id | How it plays |
|---|---|---|
| **Grand Prix** | `racing` | 3 laps against three AI rivals of different skill. You start at the back. Points by finishing place (1000/700/500/350), +200 for a clean race. A live standings panel sits beside the road when there's room |
| **Time Trial** | `timetrial` | 2 laps alone on a seeded track. Lap splits are compared with your best, and your best run drives alongside you as a faded **ghost**. Best times are saved per track and difficulty, and replaying from the results screen keeps the same track. Being slower than your record never ends the run |
| **Highway** | `highway` | Weave through endless traffic that gets denser with distance. 1 point per metre, +25 per car passed (+40 for a close call), coins, and wrenches that repair damage. **Endless Highway** (untimed) ends only when your car is wrecked or you quit; **Rush Hour** is the timed version |

| Key | Action |
|---|---|
| `A`/`D` or `←`/`→` | Steer: each press nudges your line, holding it swerves |
| `W` or `↑` | Gas. It stays on until you brake |
| `S` or `↓` | Brake while held, then coast |
| `Space` | Drift: a burst of grip through a bend, for a little speed |
| `P` / `R` / `Q` | Pause / restart (same track) / end the race (`Esc` also pauses) |

- **Why these controls:** terminals report key presses, never key releases, so the gas latches on and the brake holds only while the key repeats. Two quick presses are just a slightly bigger move, never a spin.
- **Physics:** speed builds up to a capped top speed, the grass is slow, the barrier scrapes speed (and paint), and bends push a car outward when it's faster than the grip allows, more so in rain and snow. Brake, drift or steer against it. Contact with another car slows the car behind and nudges both apart. Cones and potholes cost speed, oil spins you for a moment, barrels hurt. Collisions use each car's body, not its decorative wheel arches.
- **Fair tracks:** every track is built from a seed with smooth, closed curves whose sharpness is capped. Narrow sections still leave over two lanes, hazards are spaced out, never near the start line, and always leave two lanes' width clear. Tests check this across 120 generated tracks.
- **Races never get a deadline.** Grand Prix and Time Trial end at the finish line, so they ignore the timed/untimed setting and sit out the daily challenge. Highway supports both.
- **Modifiers** apply to every car alike (Overclocked makes the whole field faster). Chaos Mode adds crosswinds.

```bash
vibebreak play --game racing             # Grand Prix
vibebreak play --game timetrial --seed MONZA-1   # same seed, same track: chase your record
vibebreak play --game highway --mode endless
```

Racing also works over LAN: see [LAN multiplayer](#lan-multiplayer).

## LAN multiplayer

One person hosts and everyone else joins from their own terminal on the same network:

```bash
vibebreak host                       # host: opens a lobby and shows the join command
vibebreak join 192.168.1.42          # friends: join with the address the host's lobby shows
```

| Game | Players | How it plays |
|---|---|---|
| **Battleship** | 2 (+ spectators) | Place your fleet with the cursor, by typing coordinates like `B4`, or at random, then take turns firing. The server checks every placement and shot, and you never receive the enemy's unhit ship positions |
| **VibeBreak Racing** | 2–8 (+ AI rivals) | The same racing engine as singleplayer, run on the host. Clients only send key presses; the host's machine simulates the race and decides laps, positions and the finish order. Live standings, a countdown and synchronized start, a finish window for stragglers, rematches. Disconnected racers coast on autopilot until they reconnect |
| **Prompt Panic** | 3–8 | Everyone answers the same absurd prompt (161 original prompts in 8 categories, plus custom JSON packs). Answers are shown anonymously, everyone votes, and votes become points. No self-votes, no double votes |
| **Doodle Protocol** | 3–8 | The artist draws a secret word on a 30×12 ASCII canvas while everyone else guesses. Strokes are sent as small changes, and the word stays on the server until the reveal |
| **Party Mix** | 2–8 | `vibebreak host --party`: a random game each match, with a "next game" transition between them |

The lobby offers ready-up, chat, kick, spectators, per-game options, rematches and party standings. Dropped players reconnect automatically and keep their seat. By default the host binds only to your private LAN address and refuses non-private peers. All player text is cleaned so nobody can send escape sequences to someone else's terminal. `vibebreak join` and `vibebreak rooms` can find hosts via UDP broadcast, and typing the address always works.

**Firewall:** the host must allow Node.js on **private** networks (Windows asks the first time). Joiners need nothing. Full guide (setup, rules, controls, protocol, limitations): **[docs/LAN.md](docs/LAN.md)**.

Try it on one machine: `npm run build && node scripts/lan-demo.mjs`. This runs a host and bot players as separate processes and plays a Battleship match and a Prompt Panic game.

## Themes

Open **[8] SETTINGS > Theme** from the menu. Moving the selection previews each theme live (logo, colours, effects). `Enter` keeps it, and `Esc` goes back to what you had. You can also run `vibebreak theme <id>`, or `--theme <id>` for a single run.

| Theme | id | Look |
|---|---|---|
| Classic | `classic` | The original cyan and magenta (default) |
| Christmas | `christmas` | Candy-cane logo, twinkling light-string separators, falling snow |
| Halloween | `halloween` | Pumpkin orange and witchy purple, bats flapping across the screen |
| Frutiger Aero | `frutiger-aero` | Glossy aqua-to-sky and grass-green gradients, rising bubbles, shimmering separators |
| Synthwave | `synthwave` | Neon sunset gradient, magenta and cyan, twinkling stars |
| Matrix | `matrix` | Green phosphor and falling digital rain |
| Amber CRT | `amber` | Warm monochrome, like an 80s terminal |
| Seasonal | `seasonal` | Christmas in December, Halloween from Oct 15 to Nov 1, Classic the rest of the year |

- **What a theme changes:** the arcade's palette, the logo gradient, the separators, the menu tagline and ambient particles.
- **Particles:** they only fill empty space around the menu, briefing, results and stats screens. They are never drawn on a game board.
- **During play:** themes only recolour borders and separators, so games stay readable. Game pieces keep their own colours.
- **Animation off:** **[8] SETTINGS > Animations**, or `A` on the theme screen (saved).
- **Colour depth:** themes use 256-colour shades when the terminal supports them (Windows Terminal, iTerm2, most Linux terminals; the theme screen shows what was detected). Otherwise they fall back to the 16 standard colours. `NO_COLOR` still turns colour off completely.

## Custom games (Lua)

Open **[5] CUSTOM GAMES** in the menu to play games you write yourself.

- **`N`** opens the editor with a working example game.
- **`P`** opens the editor so you can paste code (Ctrl+V or right-click) or write it. **`Ctrl+S`** checks it and adds it.
- **`F`** loads a `.lua` file by path. Dragging the file into the terminal pastes its path.

Every script is checked before it is added: VibeBreak loads it, runs it for a few seconds with random input, and shows any error with its line number. Scripts that pass are copied to the `games` folder next to the save file, so they are still there next time. You can also drop `.lua` files into that folder and press `R` to reload.

A game is one file: a `game` table (id, name, size, controls) plus optional callbacks `init`, `update(dt)`, `on_key(key)`, `render()`, `hud()`, `metrics()` and `perfect()`. The `vb` table gives access to scoring and the seeded RNG, plus the round's difficulty and modifier.

```lua
game = { id = "clicker", name = "Clicker", min_size = { w = 20, h = 3 } }
local presses = 0
function on_key(key)
  if key.name == "space" then presses = presses + 1; vb.score(10) end
end
function render() return { "Press Space!", "", "Presses: " .. presses } end
```

Scripts are untrusted, so they run in a sandbox: Lua 5.4 in WebAssembly with no file, OS, network or terminal access, a per-call time budget, a memory cap, and sanitized output. Custom games don't give XP or achievements and never show up in Quick Play or the daily challenge; your best score for each is kept. See [docs/CUSTOM_GAMES.md](docs/CUSTOM_GAMES.md) for the full API.

## Timed and untimed play

Every round is either **timed** (the default: a gameplay countdown, 30–90 s depending on the game) or **untimed** (no gameplay deadline at all).

- **How to choose:** `vibebreak play --no-timer` (or `--mode endless`), **[8] SETTINGS > Timer** in the menu (shortcut `T`; saved as your default for Quick Play, the games list and replays), or `T` on the briefing screen to flip just that round. `--timer` forces a timed round.
- **What untimed means:** there is no countdown and nothing in the HUD counting down ("NO TIMER" instead). Nothing ends because time ran out, and no points are given or taken for time spent. The game keeps animating and updating. Rounds end on the game's own conditions (crash, top-out, lives, escape) or when you press Esc and choose *End round*. Pause, restart and `Ctrl+C` work as always.
- **Supported games:** all built-in games.
  - **Racing: Grand Prix** and **Time Trial** are always untimed: a race ends at the finish line. **Racing: Highway** is *Endless Highway* untimed and *Rush Hour* timed.
  - Snake, Stack Overflow, Dependency Dungeon (no escape time bonus untimed), Crossy Prod, Tetris and Ski Survival (Endless Mountain) end on their usual game over.
  - **Bug Bash** has no natural end, so untimed it gives you 5 lives instead of a clock, and misses cost points but not time.
- **Not untimed:** custom Lua games and the **daily challenge** are always timed, so daily scores stay comparable. Asking for untimed there shows a note and plays timed.
- **Fair scoring:** untimed rounds keep **separate personal bests** (the UNTIMED column in `vibebreak stats`), so an endless run never replaces a timed record. XP per round is capped the same way for both. Modifiers are rolled identically for timed and untimed rounds, and a seed reproduces the same round either way.
- **Multiplayer:** `vibebreak host --no-timer` turns off only optional gameplay timers (Battleship's turn and placement timers). Prompt Panic and Doodle Protocol timers are part of their rules and stay on.
- **Gameplay deadlines vs. network timeouts:** these are separate. Network heartbeats, connection timeouts and the reconnect grace period are never affected by any timer setting, so a dead connection is still detected in an untimed LAN game (a test checks this).

## Random sessions and modifiers

Every round rolls a **game** (weighted, never the same game twice in a row), a **difficulty** (Easy / Normal / Hard), a **modifier** and game-specific content such as layouts, spawn timing, mountain slopes and dungeon maps. The briefing screen shows all of it, including the seed, before play starts. Press `R` to reroll.

| Modifier | Effect |
|---|---|
| Standard Build | No modifier |
| Overclocked | Everything 30% faster, points ×1.25 |
| Bug Bounty | Bonus targets appear more often and are worth 2× |
| Low Battery | Only 3 mistakes allowed, points ×1.2 |
| Double XP | 2× XP for the round |
| Glass Cannon | Points ×1.5, mistakes hurt 2× |
| Chaos Mode | A random mix of the above, plus surprise events (swarms, the snake's food relocating, gusts of wind on the ski slope, speed glitches, merge-conflict spawns) |

Games can exclude modifiers that make no sense for them. Snake, for example, never rolls Low Battery, because one crash already ends the round.

Seeds are fully deterministic: `vibebreak play --seed K7Q2-M9XA` reproduces the same game, difficulty, modifier and content. Tests rely on this, and it makes bug reports reproducible.

## Progression

- High score per game, plus game-specific personal bests (best combo, longest snake, farthest ski run, tallest tower, dungeon escapes, farthest crossing, most lines).
- XP comes from score (normalised per game), with bonuses for perfect rounds, new personal bests and the daily challenge. XP per round is capped, so skill matters more than grinding.
- 20 achievements (4 for LAN games, 2 for Ski Survival; Code Sprint's *Touch Typist* was retired, but existing unlocks stay in your save), including *Back to Work*: finish a round and quit straight back to your code. Leaving is rewarded on purpose.
- Nothing decays and there are no streak-loss mechanics. Stopping costs you nothing.

## Save file and configuration

Stats live in one small JSON file:

| OS | Location |
|---|---|
| Windows | `%APPDATA%\vibebreak\save.json` |
| macOS | `~/Library/Application Support/vibebreak/save.json` |
| Linux | `$XDG_CONFIG_HOME/vibebreak/save.json` (default `~/.config/vibebreak/`) |

Set `VIBEBREAK_HOME=/some/dir` to override the location. `vibebreak stats` prints the exact path. Custom games are stored as `.lua` files in a `games` folder in the same directory.

- Writes are atomic: the data goes to a temporary file that is then renamed over the save.
- If the save file is unreadable, it is kept as `save.json.corrupt-<timestamp>`, a fresh save is started, and the menu tells you.
- Unknown or invalid fields are dropped, not trusted.
- No network requests, telemetry or account, ever.

Colour: VibeBreak respects `NO_COLOR` and `--no-color`, and falls back to plain text when output isn't a TTY or `TERM=dumb`. The Classic theme uses only the 16 standard ANSI colours, so it looks right in Windows Terminal, PowerShell, macOS Terminal, iTerm2 and Linux terminals. Other themes add 256-colour shades only where the terminal supports them.

## Claude Code integration (optional)

VibeBreak is a standalone game first. The integration is a one-way **status beacon**. Claude Code hooks record lifecycle events, and VibeBreak, running in another terminal, shows a status line under the game (and on the menu and results screens):

```
 AI WORKING /  running Bash                               myproject 3f9c2a · 2s ago · +1 more
```

It shows the status, what Claude is doing, which project and session it refers to, and how long ago the last sign of activity was. If other sessions are active too, it adds "+N more". You decide when to stop playing; it never interrupts a round.

```bash
vibebreak hook install --write   # adds the hooks to ~/.claude/settings.json (backup kept)
vibebreak hook install           # or: print the snippet and paste it yourself / via /hooks
vibebreak doctor                 # then check it is configured AND receiving events
```

Restart Claude Code after installing (it reads settings at startup), then run `vibebreak` in a second terminal while Claude works. **If you installed an earlier version, re-run `vibebreak hook install --write`** (add `--launch` if you use auto-launch). Older installs only listened to four events, and `vibebreak doctor` will flag this.

### What the statuses mean

| Shown | Status | Set by (Claude Code hook) | Meaning |
|---|---|---|---|
| `AI THINKING` | THINKING | `UserPromptSubmit`, or a tool finishing | Claude is working on your turn and no tool is running right now. Hooks can't tell reasoning from writing a reply, so both show as THINKING. |
| `AI WORKING` | WORKING | `PreToolUse` | At least one tool call (Bash, Edit, an MCP tool…) has started and not finished. Parallel calls are tracked by `tool_use_id`. |
| `AI NEEDS YOU` | WAITING_FOR_INPUT | `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`, `idle_prompt`) | A permission prompt or a question for you, or Claude finished a while ago and is waiting for your next prompt. It clears as soon as work resumes. |
| `AI DONE` | COMPLETED | `Stop` | The turn finished. It flashes for a few seconds. |
| `AI ERROR` | ERROR | `StopFailure` | The turn ended on an API error (rate limit, overload…). The next prompt clears it. |
| `AI IDLE` | IDLE | `SessionStart`, `SessionEnd`, interrupted tool | No active task. |
| `AI UNKNOWN` | UNKNOWN | (inferred) | A turn was active but nothing has been heard for a long time. VibeBreak has lost visibility, so it says so. |

A trailing `?` (for example `AI WORKING?`, shown dimmed) means the status is **inferred**: no event has arrived for 3 minutes, so it is VibeBreak's best guess rather than something an event reported. Silence alone never turns into DONE. A long-running task stays WORKING (inferred) until 20 minutes without any activity, then shows UNKNOWN. While Claude is generating, the session transcript file's modification time also counts as activity. Completed and errored turns settle to IDLE after 30 minutes. You can tune these with `VIBEBREAK_AGENT_QUIET_SEC`, `VIBEBREAK_AGENT_LOST_SEC` and `VIBEBREAK_AGENT_SETTLE_SEC`.

**Several sessions:** each Claude Code session has its own record. The line shows the session that most needs you (waiting, then error, then working, then done), and a game auto-launched by a session follows that session.

### How it works

```
Claude Code ──hook (async, exit 0, no stdout)──▶ vibebreak hook ──locked write──▶ agent/sessions/<session_id>.json
VibeBreak ──re-reads changed files every 0.5s, redraws the status line every frame──▶ HUD
```

- **One file per session**, so sessions can't overwrite each other.
- **Locking and atomic writes:** a short lock file serialises the hook processes of one session, and every write is temp-file + rename.
- **Ordering:** async hooks run as parallel processes with no delivery-order guarantee. Each event is therefore stamped with the moment its hook process was spawned, and an older event can't overwrite a newer status.
- **Duplicates and stale events:** duplicate deliveries (for example the same hook in two settings files) are ignored. A late `PreToolUse` from an earlier turn is dropped.
- **Restarts and cleanup:** VibeBreak keeps no state that a restart could lose. Start it mid-task and it picks up the current status from disk. Session files untouched for a week are deleted.

### Troubleshooting the AI status

1. Run **`vibebreak doctor`**. It separates *configured* (hooks are in `settings.json`, with any missing events listed) from *receiving* (when the last event actually arrived). It also lists every session, its status, whether that status is reported or inferred, event counts, duplicate and late-event counts, and the last hook error.
2. **Configured: no** → `vibebreak hook install --write`.
3. **Configured: yes, Receiving: no** → restart Claude Code. Check the hook command's paths exist; `doctor` flags broken paths.
4. **Status looks wrong** → `vibebreak hook debug on`, reproduce, then read `agent/events.log` in the VibeBreak config folder. It records each event, the transition (`THINKING -> WORKING`), whether the event was ignored and why, and the hook's delay. It is capped at 256 KB and rotated. `vibebreak hook debug off` stops it.

### Limitations

- **Esc interrupts fire no hook.** The [docs](https://code.claude.com/docs/en/hooks) say `Stop` doesn't run when you interrupt. An interrupted turn shows as THINKING/WORKING, then inferred, then UNKNOWN, until your next prompt resets it. If a running tool is aborted, `PostToolUseFailure` reports `is_interrupt` and the line shows IDLE (interrupted) right away.
- **Internal states that hooks don't expose stay merged:** THINKING covers both reasoning and writing a reply, and a tool waiting for permission shows WORKING until the permission hook fires.
- **No process liveness:** hooks expose no Claude Code process id, so a crashed session is only detected through silence (UNKNOWN), not instantly.
- **Hook cost:** tool hooks start a short-lived Node process per tool call. It runs async, so Claude never waits for it, but it costs a little CPU.

### Auto-launch: a game opens the moment Claude starts working

```bash
vibebreak hook install --launch --write
```

`--write` adds the hooks to `~/.claude/settings.json` for you. It keeps your other settings and hooks, saves a backup (`settings.json.vibebreak-backup`), and leaves a file it can't parse untouched. Leave out `--write` to just print the snippet and paste it yourself. `vibebreak hook uninstall --write` removes the hooks again.

This prints the same snippet, except that `UserPromptSubmit` runs `hook --launch`. The printed commands use absolute paths to Node and VibeBreak, so they work even without `npm link`. From then on, every prompt you send Claude opens VibeBreak next to it with a random game, on a 2-second countdown:

| Where Claude Code runs | What opens |
|---|---|
| Windows Terminal | A split pane on the right of the current tab (`wt -w 0 split-pane`) |
| Other Windows consoles (e.g. the old PowerShell window, VS Code) | A new console window |
| tmux (any OS) | A split pane (`tmux split-window -h`) |
| macOS iTerm2 / Terminal.app | An iTerm2 split / a new Terminal window |
| Linux desktop | `$VIBEBREAK_TERMINAL`, `$TERMINAL`, or `x-terminal-emulator -e` |

Safeguards:

- It never opens a second copy while one is already running (a lock file with a live-process check).
- It won't relaunch within 60 seconds of the last launch.
- The launch is fully detached, so the hook still returns instantly and prints nothing.
- Quitting with `Q` closes the pane and puts you back next to Claude. The HUD shows `AI DONE` when Claude finishes, so you know when to stop.
- To turn auto-launch off, remove `--launch` from the `UserPromptSubmit` entry.

**Caveat:** the new pane or window takes keyboard focus. That's the point when you've just pressed Enter on a prompt, but it can surprise you if you're queueing several prompts quickly. The tmux and Windows Terminal paths are tested; the macOS and Linux-desktop paths are untested on real machines.

**Instant play without hooks:**

- In Windows Terminal, add a **New Pane** action bound to a key (Settings → Actions) with the command line `vibebreak play`. One keypress then opens a game beside Claude.
- In tmux: `bind g split-window -h -l 45% 'vibebreak play'`.

These choices were made against the current [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks):

- **`async: true`**: the hook runs in the background and cannot block Claude.
- **Prints nothing and always exits 0.** For `UserPromptSubmit`, plain stdout would be added to Claude's context, and exit code 2 would block the prompt (for `Stop`, exit 2 would stop Claude from finishing). VibeBreak avoids both.
- **Stores event metadata only:** event name, session id, `prompt_id`, tool name, `tool_use_id`, notification type, error type, the project folder's name and the transcript path (whose modification time is used as a sign of life; the transcript itself is never read). It never stores prompt text, tool input or output, or messages, and a test enforces this.
- Never approves tools, never touches permissions, never edits project files, never reads or writes the agent's terminal. `PermissionRequest` and `PreToolUse` hooks that exit 0 with no output leave the normal permission flow unchanged.
- If the `vibebreak` binary is missing, Claude Code only shows a non-blocking hook error. To remove the integration: `vibebreak hook uninstall --write`.

Auto-launch is opt-in because it moves keyboard focus. The status beacon on its own never does.

## Development

```bash
npm install
npm run dev              # run from source (tsx)
npm test                 # vitest: 361 tests (incl. real TCP and multi-process LAN matches)
npm run typecheck
npm run build            # compile to dist/
python3 scripts/pty-smoke.py   # real-terminal smoke test (needs: pip install pyte; npm run build)
node scripts/lan-demo.mjs      # LAN demo: host + bot processes play real matches (after npm run build)
npx tsx scripts/lan-screens.ts # render the LAN screens to docs/screens/lan-*.txt (80x24 by default)
```

The LAN tests cover real TCP between in-process clients, the arcade UI on two simulated terminals over loopback, and **separate OS processes**: a dedicated host plus bot clients completing Battleship and Prompt Panic matches.

The PTY smoke test launches the built CLI in a real pseudo-terminal, sends keystrokes, renders the output with a VT100 emulator and checks:

- every game starts and runs
- Esc pauses
- Ctrl+C exits with code 0 and restores the cursor and alternate screen
- the time limit ends a round
- shrinking the window shows the too-small notice
- a corrupted save is recovered
- the AI status end to end: real `vibebreak hook` processes fed documented hook payloads update a live Tetris HUD (THINKING → WORKING → NEEDS YOU → DONE) with no key pressed; the hook prints nothing; no prompt text is stored; `doctor` sees the session
- Tetris's P / R / Q keys

On Windows, run it inside WSL (it needs a Unix PTY).

### Adding a minigame

1. Create `src/games/mygame.ts` with a class extending `BaseGame`. Implement `onKey`, `tick`, `render`, `hud`, `stats`, `metrics` and `isPerfect`, and use `addScore` / `penalize` / `flash` / `end`. `BaseGame` already handles the round clock, modifier multipliers and end-of-round state.
2. Export a `GameDefinition` with `id`, `name`, `genre`, `tagline`, `controls`, `weight`, `defaultDurationSec`, `xpScale` and `create(ctx)`. Optionally add `appKeys` to map letters your game doesn't use to the arcade's pause/restart/quit, as Tetris does with P/R/Q. `ctx.personalBest` carries the player's best score for display.
3. Add it to `GAMES` in `src/games/index.ts`.

That's it. Random selection, the menu, the arcade list, stats, XP and the fuzz/lifecycle tests all pick it up automatically. Use `this.rng` for all randomness so seeds stay reproducible, and never create timers or key listeners. The shell calls `update(dt)` and `handleInput(key)` for you.

### Adding a LAN game

1. Server side: implement `MpGameDefinition` / `MpMatch` (`src/mp/types.ts`) in `src/games/multiplayer/`. A match is synchronous, plain state. It validates every action, advances timers in `tick(now)`, returns a per-player view from `viewFor(playerId)` (never leak hidden state), handles `setPresence` for disconnects, and returns an `outcome()`. Register it in `MP_GAMES` (`src/mp/registry.ts`).
2. Client side: implement `MpGameUi` (`src/ui/lan/types.ts`). It renders the view, turns keys into actions with `ctx.send`, and never decides outcomes. Register it in `src/ui/lan/game-uis.ts`.

Lobby, networking, reconnection, spectators, rematches and party mode come for free.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Terminal too small" | Every game fits **80×24**; the menu needs 40×14. Enlarge the window. The game pauses until it fits |
| Box characters in the logo look broken | Use a font with box-drawing glyphs (Cascadia, Menlo, DejaVu Sans Mono…). Below 70 columns the logo switches to a compact text version |
| Colours look wrong / you want none | `vibebreak --no-color` or `NO_COLOR=1` |
| Arrow keys don't work on old Windows conhost | Use Windows Terminal, or WASD/HJKL |
| "needs an interactive terminal" | The arcade needs a TTY. Run it directly, not through a pipe, or use `vibebreak --standalone` to open a window |
| `--standalone` says it can't open a window | No desktop session or terminal found. On Linux set `VIBEBREAK_TERMINAL` (e.g. `gnome-terminal`, `kitty`). It falls back to the current terminal when there is one |
| "already open in another window" | Only one arcade at a time is opened as a window. Switch to it, or `vibebreak --interface terminal` for another one here (handy for testing LAN games) |
| VS Code terminal looks cramped or keys go to the editor | Click into the terminal panel first; make it at least 80×24 (drag it taller or maximize it), or use `--standalone` |
| Terminal left in a weird state after a crash | Run `reset` (macOS/Linux). VibeBreak restores the terminal on exit, Ctrl+C, SIGTERM and uncaught errors, so please report it with the seed |
| Want a clean slate | `vibebreak reset` |
| Friends can't join your LAN game | Same network? Allow Node.js through the host's firewall on private networks; use the address shown in the lobby. See [docs/LAN.md](docs/LAN.md#connection-troubleshooting) |
| AI status missing, stale or wrong | `vibebreak doctor`, then see [Troubleshooting the AI status](#troubleshooting-the-ai-status) |

## Project docs

- [LAN multiplayer guide](docs/LAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Custom games API](docs/CUSTOM_GAMES.md)
- [Business plan](docs/BUSINESS_PLAN.md)
- [Pitch outline, demo script and judge Q&A](docs/PITCH.md)

## License

MIT © 2026 Matei Stefan Crisan
