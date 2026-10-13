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

  
## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- A terminal at least 80x24 (Windows Terminal recommended)

## Install & Run

```bash
git clone https://github.com/<your-username>/waitquest.git
cd waitquest
npm install
npm run build
npm start
```

Dev mode with live reload:

```bash
npm run dev
```

## Project Structure

```
steelballers/
├── site/                  # static website
└── vibebreak/
    ├── src/
    │   ├── cli/           # entry point, argument parsing, doctor, Claude Code hook
    │   ├── core/          # game base class, RNG, sessions, modifiers, XP and achievements
    │   ├── games/         # the 9 arcade games
    │   │   └── multiplayer/   # Battleship, Prompt Panic, Doodle Protocol
    │   ├── custom/        # custom Lua games: sandboxed runtime, loader, library
    │   ├── net/           # LAN: TCP server/client, UDP room discovery, lobby, protocol
    │   ├── mp/            # multiplayer game registry, bots, headless play
    │   ├── integrations/  # Claude Code agent status and auto-launch
    │   ├── storage/       # local save file
    │   └── ui/            # app screens, rendering, input, themes, text editor
    │       └── lan/       # multiplayer screens
    ├── tests/             # vitest
    ├── scripts/           # PTY smoke test, LAN demo
    └── docs/              # architecture, LAN guide, custom games API
```

## Tech Stack

- TypeScript, Node.js 18+
- Terminal rendering with ANSI escape codes and `process.stdin` raw mode, with no UI libraries
- LAN multiplayer over TCP (`node:net`), with room discovery over UDP (`node:dgram`)
- Custom games in Lua 5.4 through [wasmoon](https://github.com/ceifa/wasmoon) (WebAssembly, optional dependency)
- Vitest for tests, tsx for dev mode
- Website: plain HTML, CSS and JS, deployed with GitHub Pages

## License

MIT
