# C-Cade business plan

> **Read this first.** C-Cade is a 48-hour hackathon project with **no users, no revenue and no market data yet**. Every number below is a labelled hypothesis or simple arithmetic, not traction. The tables clearly separate what is built from what is proposed.

## 1. What exists today vs. what is proposed

| Implemented (in this repo) | Proposed (not built) |
|---|---|
| 5 minigames, random sessions, 7 modifiers, 3 difficulties | Additional game packs |
| Seeded daily challenge with a local best and a text share card | Online leaderboards (needs a backend) |
| Local XP, levels, 19 achievements, stats | Cloud sync of stats across machines |
| Claude Code status beacon + opt-in auto-launch of a game pane via async hooks | Integrations for other agents |
| Zero telemetry, offline, no account | Optional, opt-in accounts for paid features only |
| MIT-licensed CLI | Cosmetic themes / ASCII art styles, custom modifiers, team editions |

| LAN multiplayer: Battleship, Prompt Panic, Doodle Protocol, party mix, custom prompt packs (local JSON) | Premium party-game packs, curated prompt packs, a pack marketplace |

No payment processing is implemented. The LAN multiplayer added later is free, works offline and has no accounts or backend.

## 2. The problem

AI coding agents create a new kind of idle time: a task runs for anywhere from tens of seconds to several minutes while the developer waits. That time is too short to start deep work and too long to just stare at the screen, so many people pick up their phone or open a social feed, and a 40-second wait turns into 10 minutes. We have no survey data on how common this is. The first validation step (section 8) is to measure it.

The job C-Cade does: **give the waiting time a short, enjoyable, bounded activity that keeps you in the terminal and hands you back to work as soon as the agent is done.**

## 3. Target customers (hypotheses, in priority order)

1. **Individual developers who use agentic coding tools daily** (Claude Code, Codex CLI, Cursor agents, Aider). They already live in the terminal and wait on agents many times a day. They are reachable through GitHub, npm, Hacker News, Reddit (r/ClaudeAI, r/programming), Discord communities and X/Bluesky dev circles.
2. **Students and bootcamp learners** using AI tools. Price-sensitive, but highly social, so the daily challenge and share cards fit them well.
3. **Engineering teams and dev-tool companies.** A team edition with shared challenges and team leaderboards as a light culture and onboarding perk, or as branded swag from developer-tool companies (a "sponsored daily").

## 4. Why C-Cade and not something else

| Alternative | Why C-Cade is different |
|---|---|
| Social media / phone | Bounded (short arcade rounds that end on game over, with a score), and it never leaves the terminal, so getting back to work is one key |
| Existing terminal games (`nsnake`, `bastet`, `moon-buggy`, typing tutors) | One game each, with no session variety, no progression across games, no agent awareness and often no Windows support. C-Cade is a curated arcade built around break-sized rounds |
| Browser games / IDE plugins | Require a context switch to another app. C-Cade runs in the same terminal workflow as the agent |
| Productivity timers (Pomodoro apps) | Tell you to take a break but don't make the break pleasant or short. C-Cade's design explicitly rewards quitting (*Back to Work* achievement) |
| Generic "agent done" notifiers | They tell you when to come back but don't fill the wait. C-Cade does both (status beacon in the HUD) |

Defensibility is low at the code level (games are easy to clone). The real moat, if one forms, comes from **(a)** a community daily challenge with shared seeds, **(b)** distribution inside AI-coding communities and **(c)** a large set of short, well-tuned games. These are execution advantages, not technical barriers, and we say so.

## 5. Business model and pricing hypotheses

**Free forever:** the core arcade, all current games, local stats and the daily challenge. Free use is the distribution engine.

| Offer | Hypothesis | Price hypothesis |
|---|---|---|
| **C-Cade Plus** (one-time) | Extra game packs, cosmetic themes and ASCII styles, custom modifier presets and session lengths | €8–15 one-time |
| **C-Cade Cloud** (subscription) | Stats synced across machines, global and friends leaderboards for the daily, community challenge packs | €2–4 / month |
| **Team edition** | Private team leaderboards, a shared weekly challenge, custom branding, admin-controlled settings | €3–5 per seat / month, minimum 5 seats |
| **Sponsored daily** (experiment) | A dev-tool company brands one day's challenge (tasteful, no tracking) | Flat fee per day; to be discovered |

**LAN party ideas (hypotheses, not built):**

| Idea | Notes |
|---|---|
| Premium party-game packs | New multiplayer games built on the shared lobby (e.g. a team trivia or bluffing game), sold once |
| Curated prompt packs | Themed Prompt Panic decks (conference edition, holiday edition, language-specific dev humour). The pack format and validator already exist |
| Cosmetic themes | Lobby and board skins; would reuse the existing theme system |
| Community content | Shared prompt packs and word lists; needs moderation tooling before it is viable |
| Expanded edition (one-time) | Bundle of packs, themes and extra games |
| Team / event edition | Custom branding in the lobby, a host-only "event mode" for offsites and meetups |

The core LAN game, the three current multiplayer games and custom packs stay free and offline. Payments, accounts and a cloud backend are explicitly out of scope for now.

The guiding principle is never to monetise attention. No ads in the game loop, no dark patterns, nothing that extends play time. Charging for that would contradict the product.

## 6. Distribution

- **npm + GitHub:** `npx c-cade` with zero dependencies installs in seconds. A good README GIF and the share card do most of the marketing.
- **AI-coding communities:** Claude Code, Codex and Cursor communities and Discords. The hook integration is the hook (pun intended), and a "made for your agent's think time" story fits naturally.
- **Developer media:** a Show HN post, Reddit, dev.to and Hashnode write-ups about building a flicker-free terminal renderer (the technical story recruits contributors).
- **The daily challenge as a loop:** paste-able share text (`C-Cade Daily 2026-10-12 · Score 4,820 [########--]`). The idea is borrowed from Wordle-style sharing; whether it works for C-Cade is a hypothesis to test.
- **Package managers:** Homebrew, Scoop and winget once the npm version is stable.

## 7. Acquisition assumptions and revenue scenarios (illustrative arithmetic only)

These are **not forecasts**. They show what has to be true for each revenue level, which tells us what to measure.

Assumptions:

- *A*: monthly active users (MAU) reached through free distribution.
- *c₁*: share of MAU who buy Plus once.
- *c₂*: share of MAU who subscribe to Cloud.

| Scenario | MAU | Plus conversion | Plus revenue (once, €10) | Cloud conversion | Cloud MRR (€3/mo) |
|---|---|---|---|---|---|
| Side project | 2,000 | 1% | €200 | 0.5% | €30 |
| Healthy indie tool | 20,000 | 2% | €4,000 | 1% | €600 |
| Breakout | 200,000 | 2% | €40,000 | 1% | €6,000 |

Team edition example: 10 teams × 10 seats × €4 = €400 MRR.

**Takeaway:** this is an indie or lifestyle business unless distribution breaks out. A realistic near-term goal is a free tool with a loyal community plus a small Plus or Team revenue stream, not venture scale. Payment-processor fees and VAT (EU) are not included above.

## 8. Experiments to validate willingness to pay

| # | Experiment | Success signal (set in advance) |
|---|---|---|
| 1 | Problem interviews with 15–20 developers who use AI agents daily: how long they wait, and what they do while waiting | ≥ 50% say they lose focus to phone or social media during waits |
| 2 | Ship free v1 to npm; opt-in, anonymous "rounds per week" counter only if users enable it (default off) | Week-4 retention of people who opted in ≥ 20% |
| 3 | Fake-door "Plus" item in `c-cade stats` that links to a waitlist page (clearly says "coming soon") | ≥ 3% of visitors join the waitlist |
| 4 | Pre-sell a themes + extra games pack at €8 via Gumroad / Lemon Squeezy | ≥ 50 purchases in 30 days |
| 5 | Pilot the team edition with 3 teams (free for 1 month, then quote) | ≥ 1 team converts to paid |
| 6 | Daily challenge share test: track share-card text mentions on social platforms | Organic shares grow week over week for 4 weeks |

Privacy note: C-Cade ships with **zero telemetry**. Any measurement is opt-in and anonymous, and is announced in the changelog.

## 9. Main risks

| Risk | Mitigation |
|---|---|
| **Agents get fast**, so waits shrink | Rounds are short and end on game over; *End round* is one key away. The product also works as a general micro-break arcade |
| **"Games at work" stigma** in some companies | Position it as a focus-protection tool: bounded rounds, quit rewards, a Team edition endorsed by leads |
| **Low willingness to pay** for terminal games | Keep the core free. Test Plus and Team cheaply before building them (fake doors, pre-sales) |
| **Easy to clone** | Move fast on content and community (the daily). Open-source goodwill is the brand |
| **Agent-integration breakage** when hook contracts change | The beacon is optional and one-way. The standalone arcade never depends on it |
| **Distracting rather than helping** (the opposite of the mission) | No infinite modes by default, no streak loss, nothing that punishes quitting, and a *Back to Work* achievement |

## 10. Next 90 days (if pursued)

1. Publish v1 to npm, Homebrew and Scoop. Record a demo GIF.
2. Run experiments 1, 2 and 6.
3. Add two games based on interview feedback (e.g. a regex puzzle, a rhythm game).
4. If experiment 3 or 4 passes: build Plus (themes and a game pack) with license-key unlocks. No account needed.
5. Only then consider the Cloud backend (leaderboards and sync).
