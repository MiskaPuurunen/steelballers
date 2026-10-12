Actual readme under this: Here just dev notes and other shi
- Custom games via LUA for example
- Server support for leaderboards
- other minigames
  - Gambling game
  - tetris?
  - 
- 


Tests:
- Works in windows terminal
- Works in claude code
- 





# Steelballers

> A tiny ASCII art game that lives in your terminal. Play it while your AI is thinking or tests are testing.

```
  ____________________________________
 |  SCORE: 0909          LIVES: ♥ ♥ ♥ |
 |                                    |
 |        *        @          *       |
 |    #####               #####       |
 |              >o<                   |
 |____________________________________|
```

Built for B.A.L.L.S in TypeScript.

## Why

Waiting for an AI agent to finish is dead time. GAMENAMEGAMENAME turns it into a quick round of something fun and is an alternative for taking out a phone, right next to your work. No browser, no alt-tab, no context switch.

## Features

- Pure ASCII rendering, runs in any modern terminal
- Built for Windows Terminal
- Short rounds, easy to drop and pick back up
- Zero setup beyond Node.js
- Leaderboard

  
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

## Controls

| Key            | Action        |
| -------------- | ------------- |
| `←` `→` / `A` `D` | Move       |
| `Space`        | Action / jump |
| `P`            | Pause         |
| `Q` / `Ctrl+C` | Quit          |

## Play alongside Claude Code

In Windows Terminal, split the pane so the game sits next to your agent:

1. Start Claude Code in one pane
2. Press `Alt+Shift+D` (or `Alt+Shift+-` / `Alt+Shift++`) to split
3. Run `npm start` in the new pane
4. Glance over when Claude is done 👀

## Project Structure

```
src/
├── index.ts      # entry point, game loop
├── renderer.ts   # draws ASCII frames to the terminal
├── input.ts      # raw keyboard input handling
├── game/         # game state, entities, logic
└── assets/       # ASCII sprites
```

## Tech Stack

- TypeScript
- Node.js (`process.stdin` raw mode + ANSI escape codes)

## Team

- **WhiteBeard** - [@your-github](https://github.com/your-github)

## License

MIT
