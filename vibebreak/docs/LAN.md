# LAN multiplayer

VibeBreak can host party and versus games on your local network. One person hosts, friends join from their own terminals, and everyone plays at the same time. There are no accounts, no cloud services and no internet connection involved. Traffic never leaves your network.

| Game | Type | Players | In one line |
|---|---|---|---|
| **Battleship** | Versus | 2 (others spectate) | Hide your fleet, find theirs. Classic 10×10 naval duel |
| **Prompt Panic** | Party | 3–8 (2 works) | Answer absurd prompts, vote anonymously for the funniest |
| **Doodle Protocol** | Party | 3–8 (2 works) | One player draws a secret word in ASCII, everyone else guesses |
| **Party Mix** | Party | 2–8 | A random game each match (never the same one twice in a row) |

## Quick start

On the host's computer:

```bash
vibebreak host                      # opens a lobby; pick the game there
vibebreak host --game battleship    # or choose up front
vibebreak host --party              # random game each match
```

The lobby shows the exact command your friends need, for example `vibebreak join 192.168.1.42`. On each friend's computer:

```bash
vibebreak join 192.168.1.42
vibebreak join 192.168.1.42 --port 7778     # if the host is not on the default port
vibebreak join 192.168.1.42:7778            # same thing
vibebreak join                              # browse rooms found on the network
vibebreak rooms                             # just list them
```

You can do all of this from the menu too: **[H] Host LAN game**, **[J] Join LAN game** and **[P] Party mode**.

The LAN games are separate from your Lua [custom games](CUSTOM_GAMES.md) (**[6]** in the menu), which are single-player. Custom games can't be played over the network yet.

## Network setup

**Everyone must be on the same network**, for example the same Wi-Fi or office LAN.

**Port:** the host listens on TCP **7777**. If 7777 is busy, it takes the next free port (7778, 7779…) and the lobby shows which one. Use `--port <n>` to choose one yourself. LAN discovery uses UDP 7777.

**What the host binds to:** by default the host listens on **one LAN address**, the computer's private IP on Wi-Fi or Ethernet, chosen automatically. It never listens on every interface unless you ask. It also refuses connections from public (non-private) addresses, so a laptop on a network that hands out public IPs does not become an open game server.

| `--bind` value | Who can connect |
|---|---|
| `lan` (default) | Devices on your LAN, via the auto-detected private address |
| `local` (or `--local`) | Only this computer (testing with several terminals). Discovery is limited to this computer too |
| `all` | Every interface: Wi-Fi, Ethernet, VPN and virtual adapters. Still private addresses only |
| an IP address | The interface with that address, e.g. `--bind 10.0.0.12` if auto-detect chose a VPN or VM adapter |

`--allow-public` lifts the private-address rule. Don't use it unless you know why you need it. Nothing here is designed to be exposed to the internet.

### Firewalls

The **host** needs to accept incoming connections. Players who only join need nothing.

- **Windows:** the first time you host, Windows Defender Firewall may ask about **Node.js JavaScript Runtime**. Allow it on **Private networks** only, and leave Public unticked. If you dismissed the prompt, open *Windows Security → Firewall & network protection → Allow an app through firewall* and tick **Private** for Node.js. Your network must also be set to *Private* (Settings → Network → your connection → Network profile).
- **macOS:** if the firewall is on, macOS asks whether to accept incoming connections for `node`. Click **Allow**.
- **Linux:** with `ufw`, run `sudo ufw allow from 192.168.0.0/16 to any port 7777 proto tcp` (plus `proto udp` for discovery), adjusted to your subnet.

### When discovery finds nothing

Discovery broadcasts one small UDP probe on your subnet, and only VibeBreak hosts answer it. It is often blocked, for example on guest Wi-Fi, networks with client isolation, corporate networks and some VPNs. **Joining by address always works when discovery doesn't**, provided the TCP port is reachable. Discovery does not port-scan, contacts no other devices and collects nothing about other people on the network.

### Connection troubleshooting

| Message | Likely cause |
|---|---|
| *Nothing is accepting connections at …* | Wrong address or port, or the host is not running |
| *Timed out reaching …* | Different network, or the host's firewall is blocking the port |
| *Can't reach … from this network* | You're on a different subnet or guest Wi-Fi |
| *The lobby is full (8/8 players)* | Join as a spectator (`--spectate`) or ask the host to raise the limit |
| *You were removed from this lobby by the host* | You were kicked. Your address is blocked from that lobby for 5 minutes |
| *The host runs a different VibeBreak protocol* | Update VibeBreak on both machines |

## Hosting

The host is a normal player who also runs the server inside their own VibeBreak process. When the host quits, the lobby closes and everyone sees *The host closed the lobby*.

**Lobby keys (host):**

| Key | Action |
|---|---|
| `S` / `Enter` | Start the match. If someone isn't ready you get a warning; press `S` again to start anyway |
| `G`, `←`/`→` | Change game (Battleship / Prompt Panic / Doodle Protocol / Party Mix) |
| `O` | Game options (timers, rounds, canvas size…). `↑`/`↓` select, `←`/`→` change |
| `+` / `-` | Player limit (2–8; up to 8 spectators extra) |
| `↑`/`↓` then `K` | Kick the selected player (asks to confirm) |
| `T` | Chat |
| `V` | Toggle spectator |
| `Esc` | Menu: close lobby |

**During and after a match (host):** `Esc` opens a menu with *End match (no winner)*, *Everyone back to the lobby* and *Close lobby*. On the results screen, `R` starts a rematch, `N` starts the next random game in party mode, and `L` returns to the lobby.

**Players:** `R` ready / not ready, `T` chat, `V` spectate, `Esc` leave. If your connection drops, VibeBreak reconnects automatically for up to a minute and you get your seat back.

### Dedicated (headless) host

`vibebreak host --dedicated` runs only the server. It needs no interactive terminal, so it works over SSH, in tmux or in CI, and prints a log. You can type commands on its standard input:

```
status                 players, game and phase
start [force]          start the match
game <id>              battleship | prompt-panic | doodle-protocol | random
set <key> <value>      change a game option
max <n>                player limit
kick <name>            remove a player
end | lobby | rematch | next
close                  close the lobby and exit
```

`--no-timer` turns off Battleship's optional turn and placement timers. It doesn't change Prompt Panic or Doodle Protocol, whose timers are part of the game, and it never changes network timeouts. `--autostart <n>` starts automatically when n players are ready, and `--matches <n>` exits after n matches. After each match the host prints a machine-readable `RESULT {...}` line.

### Options from the command line

```bash
vibebreak host --game prompt-panic --set rounds=8 --set answerTime=90 --max-players 6
vibebreak list        # shows every option and its legal values
```

## The games

### Battleship (2 players)

- Each player has a private 10×10 grid and a standard fleet: **Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2**.
- **Placement:** move with the arrow keys, rotate with `R` or `Space`, place with `Enter`, undo with `U`. `X` places the remaining ships at random. You can also type a square such as `B4` and press `Enter`. Once all ships are placed, press `Enter` to confirm. Until the battle starts, `U` lets you take the fleet back and change it.
- **Battle:** players alternate turns. Aim with the arrows and fire with `Enter`, or type `B4` and press `Enter`. `X` = hit, `o` = miss, `#` = a sunk ship. Firing at the same square twice, firing outside the board and firing out of turn are all refused.
- The server checks both fleets (in bounds, no overlaps, exactly one of each ship) and decides every hit, miss, sink and the winner. Each player's screen receives only their own ship positions. An opponent's ships are revealed only when sunk, and both fleets are shown after the match.
- **Disconnects:** if a player drops, the game pauses and turn timers freeze while they reconnect. If they haven't returned when the grace period ends (60 s), the match follows the *If a player leaves* option: **forfeit** (the default, labelled clearly as "wins by forfeit") or **no-contest** (nobody wins).
- **Options:** turn timer (off/20/30/60 s; running out skips your turn), placement timer (off/60/90/120 s; running out auto-deploys your fleet), and the leave rule.
- After the match you see your shots, hits, accuracy and ships sunk. The host can start a rematch.
- If more than two people are in the lobby, the first two by join order play and everyone else spectates.

### Prompt Panic (3–8 players)

1. Everyone gets the same prompt, sometimes with a twist such as *Answer as a git commit message*. Type an answer (up to 120 characters) and press `Enter`.
2. Answers are shuffled and labelled A, B, C… with no names attached. Vote for your favourite with `↑`/`↓` or the letter key, then `Enter`. You can't vote for your own answer, and you get one vote per round.
3. The reveal shows who wrote what, the votes and the points. Then the next round starts.

**Scoring (computed by the server):** +100 per vote your answer receives, +25 for submitting an answer, and +100 for a **clean sweep** (every vote cast went to your answer, with at least 2 votes). Points double in the final round. If two players submit the same answer, the answers are merged into one entry marked **JINX!** and both authors get the votes.

- Players who don't answer in time get no points that round but can still vote. The game never waits for disconnected players.
- **Host tools:** `N` skips the current timer or moves to the next round. During voting, `X` removes the selected answer; the removed answer scores nothing, and anyone who voted for it can vote again.
- **Family filter** (on by default) masks common profanity. Slurs are always masked. The host's veto handles anything the filter misses.
- **Options:** rounds (3/5/8), answer timer, vote timer, time on the results screen, absurdity (*mixed* ramps from mild to unhinged), category, prompt deck (built-in / custom / mixed) and the family filter.
- **Prompts:** 161 original prompts in 8 categories: Programming & Debugging, AI Coding Chaos, Absurd Hypotheticals, Product Pitches, Unexpected Inventions, Workplace Comedy, Creative Storytelling and Party Classics. Prompts don't repeat within a lobby session.

**Custom prompt packs:** put JSON files in the `prompt-packs` folder inside your VibeBreak config directory, which is loaded automatically, or pass `--pack file.json`:

```json
{
  "name": "Office Party",
  "prompts": [
    "The worst thing to find in the office fridge.",
    { "text": "Name a meeting that should be illegal.", "category": "workplace", "absurdity": 3 }
  ]
}
```

Each pack is validated when loaded. It can be at most 256 KB with up to 500 prompts, and each prompt must be 10–160 characters. Control characters are stripped. Duplicates and prompts containing slurs are dropped with a warning. A pack with no usable prompts is rejected. Packs are read only by the host; players receive just the prompt text.

### Doodle Protocol (3–8 players)

- Artists take turns. The server privately gives the artist a word; everyone else sees only the letter count (`_ _ _ _ _`). One letter is revealed at half time and another at three quarters, never the whole word.
- **Artist:** arrows move the cursor and `Space` stamps the brush. `P` toggles *pen down*, so moving draws a line. `E` toggles the eraser. `1`–`0`, `-` and `=` pick one of 12 brushes (`# * o + . - | / \ = @ ~`). Press `C` twice to clear the canvas, and `S` to give up the turn.
- **Guessers:** type a guess and press `Enter`. Wrong guesses appear in the feed. Correct ones show only "Ada guessed it!", never the word. A guess that contains the answer is never echoed. Close guesses get a private "so close!".
- **Scoring:** a correct guess scores 50 plus up to 50 for speed, and the first correct guesser gets +25 more. The artist scores +25 for each player who gets it. The turn ends when everyone has guessed or time runs out.
- **Options:** turns per player (1–3), draw timer (45–120 s), canvas size (24×10, 30×12 or 40×14), word pack (dev / everyday / mixed) and letter hints.
- **Drawing protocol:** the artist's client batches strokes every 50 ms and sends small `[x, y, char]` changes. The server checks each one (artist only, inside the canvas, a known brush) and sends the same small change to everyone, so the full canvas isn't re-sent on every keystroke. A client that misses an update (late join, reconnect) asks once for a full snapshot.

## Protocol and architecture (summary)

The design is server-authoritative. The host owns all game state. Clients send what they want to do ("fire at B4", "vote for C"), and the server validates it and decides every outcome. Each player gets a personal view containing only what they're allowed to see. Full details are in [ARCHITECTURE.md](ARCHITECTURE.md#lan-multiplayer).

- **Transport:** TCP, one JSON message per line, at most **16 KB per message**.
- **Envelope:** `{ "v": 1, "type": "action", "seq": 12, "matchId": "m3-ab12", "playerId": "p…", "payload": {…} }`. Clients send `hello`, `ready`, `spectate`, `action`, `host`, `chat`, `ping`/`pong` and `leave`. The server sends `welcome`, `lobby`, `view`, `event`, `ack`, `chat`, `error`, `bye` and `ping`/`pong`.
- **Identity** comes from the connection, never from what the client claims. Each seat has a random 24-character resume token. Host powers require a 32-character key that exists only inside the host's process.
- **Reliability:**
  - Actions carry a sequence number and are acknowledged. Repeats (e.g. re-sent after a reconnect) are acknowledged as duplicates and not applied again.
  - Actions tagged with an old match id are refused.
  - Server messages are numbered, so clients drop stale or out-of-order ones.
  - A ping every 5 s keeps connections alive; one that is silent for 20 s is closed. A connection that hasn't said hello within 5 s is dropped.
  - A disconnected player's seat is held for 60 s in a match and 30 s in the lobby.
- **Limits:**
  - Messages per connection are capped at 30/s with bursts up to 60. Floods are dropped, and a connection that keeps flooding is disconnected.
  - Chat is limited to about one message every 1.5 s.
  - Doodle guesses are limited to one every 0.4 s.
  - At most 8 players plus 8 spectators, and 32 connections in total.
- **Untrusted text:** names, chat, answers, guesses and prompt packs are cleaned on the server. Each client cleans everything again before rendering, so even a modified host can't inject terminal control sequences. Cleaning removes control characters (including ESC), bidirectional and zero-width characters, combining marks and double-width glyphs that would break the layout.

## Implemented vs. future

| Implemented | Not implemented (ideas) |
|---|---|
| LAN host / join / rooms, reconnection, kick, spectators, chat | Internet play, relay servers, NAT traversal |
| Battleship, Prompt Panic, Doodle Protocol, Party Mix | More party games, team modes, tournaments |
| Custom prompt packs (local JSON, validated) | A pack browser or marketplace, community uploads |
| Local LAN stats and 4 LAN achievements | Shared or global leaderboards |
| Bots (`join --bot`) for testing and demos | Smart AI opponents |
| | Multiplayer Lua custom games |
| | Payments, accounts, cloud anything |

Monetization ideas are in the [business plan](BUSINESS_PLAN.md). None of them is implemented, and the core LAN game stays free and offline.

## Known limitations

- **Real-terminal coverage:** the interactive arcade was tested end to end with simulated terminals, and the network side with real processes and sockets. No one has yet played on real terminals across several physical machines on one network. The PTY smoke test (`scripts/pty-smoke.py`) needs a Unix PTY and doesn't cover LAN screens.
- **No encryption:** traffic is plain TCP, which is fine on a trusted home LAN. Anyone who can watch your network can read chat and answers, so don't type secrets.
- **Network layout:** discovery covers one subnet. Hosts on different VLANs or subnets need the address typed in.
- **Character set:** emoji and CJK characters are removed from names and text, because the terminal layout assumes single-width characters.
- **The host is the server:** if the host's VibeBreak exits, the lobby ends. There is no host migration.
- **Moderation:** the word filter is basic; the host's veto and kick are the real moderation tools.
- **LAN stats:** they record what the host reported. They're for fun, not proof.
