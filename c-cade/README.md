# C-Cade

C-Cade is a small arcade of keyboard games that runs in your terminal. It's for the minutes you spend waiting on an AI coding agent (or a build, or tests): play a quick round next to your work instead of reaching for your phone, then get straight back to it.

## Features

- 10 single-player games, including a tactical roguelite, Tetris, skiing and racing.
- 4 LAN party games for 2-8 players on the same network. No accounts or internet needed.
- Games end when you lose (or win). There is no countdown clock.
- Seeded rounds: a seed replays the same round, and the daily challenge is the same for everyone.
- Difficulty levels and random modifiers (Double XP, Glass Cannon, Chaos...).
- Local high scores, XP, levels and achievements. Nothing leaves your computer.
- Optional Claude Code integration: the HUD shows what Claude is doing while you play.
- Your own games in Lua, run in a sandbox.
- Themes, from Classic to Synthwave and Matrix.

## Requirements

- Node.js 18 or newer.
- A terminal of at least 80x24 (Windows Terminal, the VS Code terminal, iTerm2, most Linux terminals).

## Installation

```bash
npm install
npm run build
npm link        # optional: puts the `c-cade` command on your PATH
```

Without `npm link`, use `npm start` instead of `c-cade` below.

## Running

```bash
c-cade                          # open the menu
c-cade play                     # jump into a random game
c-cade play --game tetris       # play a specific game
c-cade daily                    # today's challenge
c-cade list                     # list the games
c-cade stats                    # scores, level and achievements
c-cade --help                   # every command and option
```

Where it runs:

```bash
c-cade --interface terminal     # in this terminal (also what the default, auto, does)
c-cade --standalone             # in a new terminal window
```

To play next to Claude Code, split your terminal (`Alt+Shift+D` in Windows Terminal) and run `c-cade` in the new pane.

Optional Claude Code integration:

```bash
c-cade hook install --write             # show Claude's status in the game HUD
c-cade hook install --write --launch    # also open C-Cade when Claude starts working
c-cade doctor                           # check that it's receiving events
```

`--write` edits `~/.claude/settings.json` and keeps a backup. Restart Claude Code afterwards.

`vibebreak`, the project's old name, still works as an alias for the command.

## Controls

- **Menu:** press a number or letter key, or use the arrow keys and Enter. Esc goes back, and `Q` quits.
- **In a game:** each game shows its controls before it starts. Esc pauses, with options to resume, restart or end the round.
- **Anywhere:** Ctrl+C exits immediately.

## Games

| Game | |
|---|---|
| Bug Bash | Squash bugs before they reach prod, and spare the features. |
| Terminal Snake | Eat, grow long and avoid legacy code. |
| Ski Survival | Race down an endless mountain: dodge trees, jump crevasses, land tricks. |
| Stack Overflow | Drop blocks to build the tallest tower. Overhangs get sliced. |
| Dependency Dungeon | Tactical roguelite: pick a class, fight telegraphed battles, loot, level up and beat the final boss. |
| Crossy Prod | Hop your hotfix across CI traffic and release trains. |
| Tetris | Clear lines and survive the gravity curve. |
| Racing: Grand Prix | Three laps against three AI rivals. |
| Racing: Time Trial | Beat your best lap time and your ghost. |
| Racing: Highway | Weave through endless traffic. |

You can also write your own games in Lua and load them from **Custom Games** in the menu. See [docs/CUSTOM_GAMES.md](docs/CUSTOM_GAMES.md).

## Multiplayer

Everyone needs C-Cade on the same local network.

```bash
c-cade host                         # host a lobby (choose the game in the lobby)
c-cade host --game battleship       # or: prompt-panic, doodle-protocol, racing
c-cade host --party                 # a random game each match
c-cade join                         # find rooms on your network
c-cade join 192.168.1.42            # join a host by address
```

The same options are in the menu under **Multiplayer**. The party games are Battleship, Racing, Prompt Panic (answer absurd prompts, then vote for the funniest) and Doodle Protocol (draw a word in ASCII while the others guess). Troubleshooting and details: [docs/LAN.md](docs/LAN.md).

## Development

```bash
npm run dev -- play --game snake    # run from source, no build step
npm test                            # unit and integration tests (Vitest)
npm run typecheck                   # TypeScript type check
npm run build                       # compile to dist/
```

How the code is organised: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

License: MIT.
