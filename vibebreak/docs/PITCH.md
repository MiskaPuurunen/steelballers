# VibeBreak: pitch, demo and judge Q&A

## Seven-minute pitch outline

| Time | Section | Key lines |
|---|---|---|
| 0:00–0:45 | **Hook** | "Raise your hand if you've asked an AI agent to fix something, opened your phone 'for a second', and come back ten minutes later." AI made coding faster, but it created a new kind of dead time: the wait. |
| 0:45–1:30 | **Problem** | Waits run from tens of seconds to minutes: too short for deep work, long enough to lose focus. The phone wins by default. (We haven't measured this at scale yet; validating it is experiment #1 in our plan.) |
| 1:30–2:00 | **Solution** | VibeBreak: an ASCII arcade that lives in your terminal. Rounds of 20–60 seconds, a score, then one key back to work. *Your AI is thinking. You're playing.* |
| 2:00–4:30 | **Live demo** | See the demo script below. |
| 4:30–5:15 | **How it's built** | TypeScript, zero runtime dependencies, a custom line-diffing renderer for flicker-free 30 fps, games as pure logic behind one interface, seeded RNG so every session is reproducible, and procedural content validated by flood fill/BFS. 131 automated tests plus a real-PTY smoke test. |
| 5:15–6:15 | **Business** | Free core arcade for distribution through npm and AI-coding communities. Monetise with a one-time Plus pack (games, themes), a small Cloud subscription (sync, daily leaderboards) and a Team edition. Every revenue figure is a labelled hypothesis; we show the experiments that would prove or kill it. |
| 6:15–7:00 | **Close** | We built something that rewards you for *leaving*. That's the point: a break that ends. Ask: try `vibebreak daily` and send us your share card. |

## Live demo script (about 2.5 minutes)

**Setup before going on stage:**

- Two terminal panes side by side, font size 18+, window at least 100×30.
- Left pane: Claude Code with the hooks installed. Right pane: `vibebreak`.
- Pre-seed one known-good session for Snake, e.g. `--seed DEMO-1`, so the board is pleasant.
- Run `vibebreak reset --yes` beforehand (or keep a nice-looking save), so achievements unlock live.

1. **(15s) The menu.** Type `vibebreak` in the right pane, let the logo shimmer, and point at the tagline.
2. **(30s) The agent beacon.** In the left pane, ask Claude to do a small refactor. The right HUD switches to **[AI working]**. "VibeBreak knows Claude is busy, through official async hooks that print nothing and can't block the agent."
3. **(40s) Quick Play.** Press `1`. On the briefing screen, point out the random game, modifier, difficulty and seed. Press `R` once to show the reroll, then `Enter`. Play Bug Bash for a few seconds and narrate the combos, the golden bug and the "Don't squash features" rule.
4. **(20s) Pause & honesty.** Press `Esc`. "The clock stops." Choose *End round*. The results screen shows the score count-up, XP and an achievement.
5. **(30s) Variety.** Press `N` for another random game (it never repeats the last one). If it's Snake or Stack Overflow, play 10 seconds. Mention Chaos Mode surprises.
6. **(15s) Agent done.** The HUD flashes **AI DONE**. Press `Q`: the *Back to Work* achievement fires as you land back in the shell. "It rewards you for leaving."
7. **(10s) Daily.** Run `vibebreak daily`. "Same seed for everyone today. Share card on exit."

**Fallbacks:**

- If the hook demo fails, skip step 2 and run `vibebreak hook status` later.
- If the venue terminal is small, VibeBreak pauses and shows the needed size. Every game fits 80×24.
- If something crashes, Ctrl+C restores the terminal. Replay the exact session with `--seed`.

## Likely judge questions

**Isn't this just encouraging procrastination?**
It's designed to replace an *unbounded* distraction with a *bounded* one. Rounds have a hard time limit and a visible countdown, there are no infinite modes or streak-loss mechanics, and the *Back to Work* achievement rewards quitting. Whether it actually reduces lost time is our first experiment; we don't claim it yet.

**Why would anyone pay for a terminal game?**
Most won't, and that's fine. The core stays free. We think a minority would pay a small one-time fee for more games and themes, and teams might pay for shared challenges. Our plan includes fake-door and pre-sale tests with success thresholds set in advance, before we build anything paid.

**How does the Claude Code integration work, and is it safe?**
It uses official hooks (`UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`) with `async: true`. The hook reads only the event name, writes a tiny status file, prints nothing and always exits 0. Exit code 2 or stdout could block a prompt or inject context, so we avoid both by design. VibeBreak never approves tools, touches permissions, edits project files or reads the agent's I/O. It's documented and removable in one step.

**Why not auto-open the game when the agent starts?**
It can: `vibebreak hook install --launch` opens a game pane next to Claude on every prompt (a Windows Terminal or tmux split, or a new window elsewhere). It's opt-in because it moves keyboard focus. It never opens duplicates, waits 60 seconds between launches, and is fully detached so Claude is never blocked.

**What was technically hard?**
1. Flicker-free real-time rendering in every terminal, including Windows: a line-diffing renderer plus synchronized output.
2. Guaranteeing that procedural content is always playable: flood-fill and BFS checks, tested over hundreds of seeds.
3. Never leaving the terminal broken: one idempotent restore path wired to exit, signals and crashes, verified in a real PTY.

**How do you know the games work?**
131 Vitest tests:

- rules tests for each game
- fuzzing with random input across 25 seeds per game
- determinism checks
- an 80×24 fit test
- full app flows with a fake terminal and clock

On top of that, a pseudo-terminal smoke test drives the real binary through every game, pause, the time limit, Ctrl+C, resize and corrupted-save recovery.

**Why Ink wasn't used, when the brief suggested it?**
For 30 fps games we wanted direct control over which terminal rows are rewritten, and zero dependencies for instant `npx` startup. The renderer is small (under 100 lines with the terminal wrapper) and tested. The architecture doc explains the trade-off.

**Can it be cloned easily?**
Yes. The code isn't the moat. Community (the shared daily seed), content breadth and distribution inside AI-coding communities are. We're honest that these are execution advantages.

**What's next?**
Publishing to npm, Homebrew and Scoop; running the validation experiments; two new games based on interviews; then deciding on Plus vs. Cloud based on the data.

**What about privacy?**
No telemetry, no network, no account. Stats are a local JSON file. Any future measurement will be opt-in and anonymous.
