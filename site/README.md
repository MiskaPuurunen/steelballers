# VibeBreak disk shop

A static site that lists custom games and themes for VibeBreak. Plain HTML, CSS and JS, no build step.

## Run it locally

The page loads `catalog.json` and the `.lua` files with `fetch`, so it has to be served, not opened as a file:

```bash
python3 -m http.server -d site
```

Then open http://localhost:8000.

## Add a game

1. Put the script in `site/games/`, for example `site/games/my-game.lua`. Check that it loads in VibeBreak first (Custom games, then `F`).
2. Add an entry to the `games` list in `site/catalog.json`:

```json
{
  "id": "my-game",
  "title": "My Game",
  "author": "your-name",
  "price": "0.99€",
  "disk": "green",
  "file": "games/my-game.lua",
  "genre": "Arcade",
  "duration": 30,
  "description": "One or two sentences about what you do in the game.",
  "controls": [["Space", "jump"]],
  "cover": [
    "   ASCII art for the",
    "   disk label, about",
    "   22 characters wide",
    "   and up to 7 lines"
  ]
}
```

`disk` is the floppy colour: `blue`, `red`, `yellow`, `black` or `green`. Use `"Free"` as the price for a free game.

## Themes

Themes are built into VibeBreak (`vibebreak/src/ui/themes.ts`), so the Themes tab only shows them and the command that switches to each one. If you add a theme to the app, add a matching entry to `themes` in `catalog.json` with its colours as hex values.

## Prices

Prices are only labels. There is no checkout: every game can be downloaded and copied for free.

## Publishing

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every push to `main` that touches `site/`. Turn it on once under the repo's Settings, Pages, Source: GitHub Actions.
