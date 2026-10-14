# Steelballers

> ASCII art game that lives in your terminal. Play it while your AI is thinking or tests are testing.

```
<img width="596" height="469" alt="image" src="https://github.com/user-attachments/assets/8b516e85-12c0-4126-b971-0235b0ead2c8" />

```

Built for B.A.L.L.S in TypeScript.

## Why

Now you have a fun way to spend time while being able to do it straight in the terminal rather than on a phone for example. You can experience the fun with friends while doing projects or waiting for the professor to come back from a break.

## Features

- ASCII rendering
- Built for Windows Terminal
- Short rounds, easy to drop and pick back up
- Zero setup beyond Node.js
- Custom made community games

## Games

The Arcade opens with two quick ones: **Blackjack** (hit or stand against a dealer who draws to 17) and **Slots** (three reels, three of a kind pays). Both use play chips only, with no real money. After those come Terminal Snake, Ski Survival, Dependency Dungeon, Crossy Prod, Tetris, and Racing (Grand Prix, Time Trial and Highway). Over LAN you can also play Battleship, Prompt Panic, Doodle Protocol and Racing.

Start a specific game with `c-cade play --game <id>`, for example `--game blackjack` (or `bj`) and `--game slots`.
  
## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- A terminal at least 80x24 (Windows Terminal recommended)

## Install & Run

```bash
git clone https://github.com/MiskaPuurunen/steelballers.git
cd steelballers/c-cade
npm install
npm run build
npm link        # puts the `c-cade` command on your PATH
c-cade play
```

`npm link` is optional. Without it, run the game from the `c-cade` folder with `npm start -- play` (or `node dist/cli/index.js play`). To remove the global command later: `npm unlink -g c-cade`.

If `c-cade` isn't recognized after linking, open a new terminal and check that the folder printed by `npm prefix -g` is on your PATH.

Dev mode (runs the TypeScript source directly, no build step):

```bash
npm run dev -- play
```

## Project Structure

```
steelballers/
├── site/                  # static website
└── c-cade/
    ├── src/
    │   ├── cli/           # entry point, argument parsing, doctor, Claude Code hook
    │   ├── core/          # game base class, RNG, sessions, modifiers, XP and achievements
    │   ├── games/         # the arcade games
    │   │   └── multiplayer/   # Battleship, Prompt Panic, Doodle Protocol
    │   ├── custom/        # custom Lua games: sandboxed runtime, loader, library
    │   ├── net/           # LAN: TCP server/client, UDP room discovery, lobby, protocol
    │   ├── mp/            # multiplayer game registry, bots, headless play
    │   ├── integrations/  # Claude Code agent status and auto-launch
    │   ├── storage/       # local save file
    │   └── ui/            # app screens, rendering, input, themes, text editor
    │       └── lan/       # multiplayer screens
    └── scripts/           # PTY smoke test, LAN demo
```

## Tech Stack

- TypeScript, Node.js 18+
- Terminal rendering with ANSI escape codes and `process.stdin` raw mode, with no UI libraries
- LAN multiplayer over TCP (`node:net`), with room discovery over UDP (`node:dgram`)
- Custom games in Lua 5.4 through [wasmoon](https://github.com/ceifa/wasmoon) (WebAssembly, optional dependency)
- tsx for dev mode
- Website: plain HTML, CSS and JS, deployed with GitHub Pages

## License

MIT
