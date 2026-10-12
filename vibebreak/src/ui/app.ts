import type { GameDefinition, GameInstance, GameResult, Key, SessionConfig } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { generateSession, todayUtc, type SessionOptions } from '../core/session.js';
import { getModifier, DIFFICULTIES } from '../core/modifiers.js';
import { levelProgress, recordRound, unlock, getAchievement, type RoundSummary } from '../core/progression.js';
import { GAMES } from '../games/index.js';
import type { SaveData, SaveStore } from '../storage/save.js';
import type { AgentWatcher } from '../integrations/agent-status.js';
import type { TerminalIO } from './terminal.js';
import { Screen } from './screen.js';
import { isCtrlC, parseKeys } from './keys.js';
import { c, theme, tone, visibleWidth } from './style.js';
import {
  bar, centerBlock, centerVertically, fmt, fmtTime, hudLine, keyHint, logo, padRight, rule, spread,
} from './layout.js';
import { statsLines } from './stats-view.js';

/* ------------------------------------------------------------------ deps */

export interface Scheduler {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export type StartMode =
  | { mode: 'menu' }
  | { mode: 'play'; session: SessionOptions }
  | { mode: 'daily' };

export interface AppOptions {
  io: TerminalIO;
  store: SaveStore;
  save: SaveData;
  start: StartMode;
  games?: readonly GameDefinition[];
  scheduler?: Scheduler;
  agent?: AgentWatcher | null;
  /** Notice shown on the menu (e.g. recovered from a corrupted save). */
  notice?: string;
  /** Frame interval in ms. */
  frameMs?: number;
}

export interface ExitInfo {
  /** Lines to print to the normal terminal after the arcade closes. */
  messages: string[];
}

/* ---------------------------------------------------------------- states */

type State =
  | { kind: 'menu'; sel: number }
  | { kind: 'arcade'; sel: number }
  | { kind: 'briefing'; session: SessionConfig; countdownMs: number }
  | {
      kind: 'playing';
      session: SessionConfig;
      game: GameInstance;
      def: GameDefinition;
      playedMs: number;
      paused: boolean;
      pauseSel: number;
    }
  | {
      kind: 'results';
      session: SessionConfig;
      def: GameDefinition;
      result: GameResult;
      summary: RoundSummary;
      shownScore: number;
      lockMs: number;
      saved: boolean;
    }
  | { kind: 'stats'; confirmReset: boolean };

const MENU_ITEMS: Array<{ key: string; label: string; hint: string }> = [
  { key: '1', label: 'QUICK PLAY', hint: 'random game, random modifier' },
  { key: '2', label: 'ARCADE', hint: 'pick a game' },
  { key: '3', label: 'DAILY CHALLENGE', hint: 'same seed for everyone today' },
  { key: '4', label: 'STATS & ACHIEVEMENTS', hint: 'your progress' },
  { key: 'Q', label: 'QUIT', hint: 'back to work' },
];

const PAUSE_ITEMS = ['Resume', 'Restart round', 'End round'];
const COUNTDOWN_MS = 4000;
const RESULTS_LOCK_MS = 600;

/* ------------------------------------------------------------------- app */

export class App {
  private readonly io: TerminalIO;
  private readonly screen: Screen;
  private readonly games: readonly GameDefinition[];
  private readonly sched: Scheduler;
  private readonly store: SaveStore;
  private readonly agent: AgentWatcher | null;
  private save: SaveData;
  private state: State;
  private handle: unknown = null;
  private last = 0;
  private sinceAgentPoll = 0;
  private animMs = 0;
  private lastEnterAt = -1000;
  private notice: string | undefined;
  private agentFlash = 0;
  private resolveExit: ((info: ExitInfo) => void) | null = null;
  private exitMessages: string[] = [];
  private roundsThisRun = 0;
  private xpThisRun = 0;
  private dailyShare: string | null = null;
  private readonly frameMs: number;
  private readonly launchedToPlay: boolean;
  private finished = false;

  constructor(opts: AppOptions) {
    this.io = opts.io;
    this.screen = new Screen(opts.io);
    this.games = opts.games ?? GAMES;
    this.sched = opts.scheduler ?? realScheduler;
    this.store = opts.store;
    this.save = opts.save;
    this.agent = opts.agent ?? null;
    this.notice = opts.notice;
    this.frameMs = opts.frameMs ?? 33;
    this.launchedToPlay = opts.start.mode !== 'menu';
    this.state = { kind: 'menu', sel: 0 };
    if (opts.start.mode === 'play') this.toBriefing(this.newSession(opts.start.session));
    else if (opts.start.mode === 'daily') this.toBriefing(this.newSession({ daily: todayUtc() }));
  }

  /** Current state kind (for tests). */
  get stateKind(): State['kind'] {
    return this.state.kind;
  }

  /** The live game, if playing (for tests). */
  get currentGame(): GameInstance | null {
    return this.state.kind === 'playing' ? this.state.game : null;
  }

  get frame(): string[] {
    return this.screen.frame;
  }

  get timerActive(): boolean {
    return this.handle !== null;
  }

  run(): Promise<ExitInfo> {
    return new Promise((resolve) => {
      this.resolveExit = resolve;
      this.io.onData((d) => this.onData(d));
      this.io.onResize(() => this.render());
      this.io.start();
      this.last = this.sched.now();
      this.agent?.poll();
      this.handle = this.sched.setInterval(() => this.tick(), this.frameMs);
      this.render();
    });
  }

  /** Stop the loop, restore the terminal and resolve run(). Idempotent. */
  quit(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.handle !== null) {
      this.sched.clearInterval(this.handle);
      this.handle = null;
    }
    if (this.state.kind === 'playing') this.state.game.dispose();
    this.io.stop();
    const messages = [...this.exitMessages];
    if (this.dailyShare) messages.push('', this.dailyShare);
    if (this.roundsThisRun > 0) {
      messages.push('', theme.primary(`VibeBreak: ${this.roundsThisRun} round${this.roundsThisRun === 1 ? '' : 's'}, +${fmt(this.xpThisRun)} XP. Back to work!`));
    }
    this.resolveExit?.({ messages });
  }

  /* ---------------------------------------------------------- loop */

  tick(): void {
    const now = this.sched.now();
    const dt = Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    this.animMs += dt;

    this.sinceAgentPoll += dt;
    if (this.agent && this.sinceAgentPoll >= 1000) {
      this.sinceAgentPoll = 0;
      if (this.agent.poll() && this.agent.current?.state === 'done') this.agentFlash = 4000;
    }
    if (this.agentFlash > 0) this.agentFlash -= dt;

    const s = this.state;
    if (s.kind === 'briefing') {
      s.countdownMs -= dt;
      if (s.countdownMs <= 0) this.startRound(s.session);
    } else if (s.kind === 'playing') {
      if (!s.paused && !this.tooSmallFor(s.game)) {
        s.game.update(dt);
        s.playedMs += dt;
        if (s.game.isOver()) this.finishRound();
      }
    } else if (s.kind === 'results') {
      s.lockMs -= dt;
      const target = s.result.score;
      s.shownScore = Math.min(target, s.shownScore + Math.max(1, target * (dt / 700)));
    }
    this.render();
  }

  private onData(data: string): void {
    for (const key of parseKeys(data)) {
      if (this.finished) return;
      if (isCtrlC(key)) {
        this.quit();
        return;
      }
      this.onKey(key);
    }
    if (!this.finished) this.render();
  }

  /** Dispatch a key (public for tests). */
  onKey(key: Key): void {
    const s = this.state;
    switch (s.kind) {
      case 'menu': return this.menuKey(s, key);
      case 'arcade': return this.arcadeKey(s, key);
      case 'briefing': return this.briefingKey(s, key);
      case 'playing': return this.playingKey(s, key);
      case 'results': return this.resultsKey(s, key);
      case 'stats': return this.statsKey(s, key);
    }
  }

  /** Debounce accidental double Enter presses in menus. */
  private enterOk(): boolean {
    const now = this.sched.now();
    if (now - this.lastEnterAt < 150) return false;
    this.lastEnterAt = now;
    return true;
  }

  /* -------------------------------------------------------- sessions */

  private newSession(opts: SessionOptions): SessionConfig {
    return generateSession(this.games, { previousGameId: this.save.lastGameId, ...opts });
  }

  private def(id: string): GameDefinition {
    return this.games.find((g) => g.id === id)!;
  }

  private toBriefing(session: SessionConfig): void {
    this.state = { kind: 'briefing', session, countdownMs: COUNTDOWN_MS };
  }

  private startRound(session: SessionConfig): void {
    const def = this.def(session.gameId);
    const game = def.create({
      rng: new Rng(session.seed).fork(`game:${session.gameId}`),
      difficulty: session.difficulty,
      effects: session.effects,
      durationMs: session.durationMs,
    });
    this.state = { kind: 'playing', session, def, game, playedMs: 0, paused: false, pauseSel: 0 };
    this.screen.invalidate();
  }

  private finishRound(): void {
    const s = this.state;
    if (s.kind !== 'playing') return;
    const result = s.game.result();
    s.game.dispose();
    const summary = recordRound(this.save, s.def, s.session, result, s.playedMs, this.games.map((g) => g.id));
    const saved = this.store.save(this.save);
    this.roundsThisRun++;
    this.xpThisRun += summary.xpGained;
    if (s.session.daily) this.dailyShare = shareText(s.session, s.def, result, summary);
    this.state = { kind: 'results', session: s.session, def: s.def, result, summary, shownScore: 0, lockMs: RESULTS_LOCK_MS, saved };
    this.screen.invalidate();
  }

  /* ------------------------------------------------------------ input */

  private menuKey(s: Extract<State, { kind: 'menu' }>, key: Key): void {
    if (key.name === 'up') s.sel = (s.sel + MENU_ITEMS.length - 1) % MENU_ITEMS.length;
    else if (key.name === 'down' || key.name === 'tab') s.sel = (s.sel + 1) % MENU_ITEMS.length;
    else if (key.name === 'escape') this.quit();
    else if (key.name === 'enter' || key.name === 'space') {
      if (this.enterOk()) this.menuSelect(MENU_ITEMS[s.sel].key);
    } else if (key.ch) this.menuSelect(key.ch.toUpperCase());
  }

  private menuSelect(k: string): void {
    this.notice = undefined;
    if (k === '1') this.toBriefing(this.newSession({}));
    else if (k === '2') this.state = { kind: 'arcade', sel: 0 };
    else if (k === '3') this.toBriefing(this.newSession({ daily: todayUtc() }));
    else if (k === '4') this.state = { kind: 'stats', confirmReset: false };
    else if (k === 'Q') this.quit();
  }

  private arcadeKey(s: Extract<State, { kind: 'arcade' }>, key: Key): void {
    const n = this.games.length;
    if (key.name === 'up') s.sel = (s.sel + n - 1) % n;
    else if (key.name === 'down' || key.name === 'tab') s.sel = (s.sel + 1) % n;
    else if (key.name === 'escape' || key.ch?.toLowerCase() === 'q' || key.name === 'backspace') this.state = { kind: 'menu', sel: 1 };
    else if (key.name === 'enter' || key.name === 'space') {
      if (this.enterOk()) this.toBriefing(this.newSession({ gameId: this.games[s.sel].id }));
    } else if (key.ch && /^[1-9]$/.test(key.ch)) {
      const i = Number(key.ch) - 1;
      if (i < n) this.toBriefing(this.newSession({ gameId: this.games[i].id }));
    }
  }

  private briefingKey(s: Extract<State, { kind: 'briefing' }>, key: Key): void {
    const ch = key.ch?.toLowerCase();
    if (key.name === 'enter' || key.name === 'space') {
      if (this.enterOk()) this.startRound(s.session);
    } else if (ch === 'r' && !s.session.daily) {
      // Reroll: a fresh random session that avoids the game just offered.
      this.toBriefing(generateSession(this.games, { previousGameId: s.session.gameId }));
    } else if (key.name === 'escape' || ch === 'q') {
      this.state = { kind: 'menu', sel: 0 };
    }
  }

  private playingKey(s: Extract<State, { kind: 'playing' }>, key: Key): void {
    if (s.paused) {
      const ch = key.ch?.toLowerCase();
      if (key.name === 'up') s.pauseSel = (s.pauseSel + PAUSE_ITEMS.length - 1) % PAUSE_ITEMS.length;
      else if (key.name === 'down' || key.name === 'tab') s.pauseSel = (s.pauseSel + 1) % PAUSE_ITEMS.length;
      else if (key.name === 'escape') s.paused = false;
      else if (ch === 'r') this.pauseAction(1);
      else if (ch === 'q' || ch === 'e') this.pauseAction(2);
      else if (key.name === 'enter' || key.name === 'space') this.pauseAction(s.pauseSel);
      return;
    }
    if (key.name === 'escape') {
      s.paused = true;
      s.pauseSel = 0;
      return;
    }
    s.game.handleInput(key);
    if (s.game.isOver()) this.finishRound();
  }

  private pauseAction(i: number): void {
    const s = this.state;
    if (s.kind !== 'playing') return;
    if (i === 0) s.paused = false;
    else if (i === 1) {
      s.game.dispose();
      this.startRound(s.session);
    } else {
      s.game.forceEnd('quit');
      this.finishRound();
    }
  }

  private resultsKey(s: Extract<State, { kind: 'results' }>, key: Key): void {
    // Swallow keys right after a round ends so a mashed key doesn't skip the results.
    if (s.lockMs > 0) return;
    const ch = key.ch?.toLowerCase();
    if (key.name === 'enter' || ch === 'r') {
      if (!this.enterOk()) return;
      // Replay the same game. The daily replays its fixed seed.
      const next = s.session.daily
        ? this.newSession({ daily: s.session.daily })
        : this.newSession({ gameId: s.session.gameId });
      this.toBriefing(next);
    } else if (ch === 'n') {
      this.toBriefing(this.newSession({}));
    } else if (ch === 'm' || key.name === 'escape') {
      this.state = { kind: 'menu', sel: 0 };
    } else if (ch === 'q') {
      if (unlock(this.save, 'back-to-work')) {
        this.store.save(this.save);
        const a = getAchievement('back-to-work')!;
        this.exitMessages.push(theme.gold(`Achievement unlocked: ${a.name}`) + theme.muted(` - ${a.description}`));
      }
      this.quit();
    }
  }

  private statsKey(s: Extract<State, { kind: 'stats' }>, key: Key): void {
    const ch = key.ch?.toLowerCase();
    if (ch === 'x') {
      if (s.confirmReset) {
        const settings = this.save.settings;
        this.store.reset();
        this.save = this.store.load().data;
        this.save.settings = settings;
        this.store.save(this.save);
        s.confirmReset = false;
        this.notice = 'Stats reset.';
      } else {
        s.confirmReset = true;
      }
      return;
    }
    s.confirmReset = false;
    if (key.name === 'escape' || key.name === 'enter' || ch === 'q' || key.name === 'backspace') {
      this.state = { kind: 'menu', sel: 3 };
    }
  }

  /* ------------------------------------------------------------ render */

  private tooSmallFor(game: GameInstance): boolean {
    return this.io.columns < game.minSize.width + 2 || this.io.rows < game.minSize.height + 6;
  }

  render(): void {
    if (this.finished) return;
    const { columns, rows } = this.io;
    let lines: string[];
    if (columns < 40 || rows < 14) {
      lines = centerVertically(centerBlock([
        theme.accent('VIBEBREAK'),
        theme.muted(`Terminal too small (${columns}x${rows}).`),
        theme.muted('Resize to at least 40x14.'),
        theme.muted('Ctrl+C to exit.'),
      ], columns), rows);
    } else {
      switch (this.state.kind) {
        case 'menu': lines = this.renderMenu(this.state); break;
        case 'arcade': lines = this.renderArcade(this.state); break;
        case 'briefing': lines = this.renderBriefing(this.state); break;
        case 'playing': lines = this.renderPlaying(this.state); break;
        case 'results': lines = this.renderResults(this.state); break;
        case 'stats': lines = this.renderStats(this.state); break;
      }
    }
    this.screen.draw(lines);
  }

  private agentBadge(): string {
    const st = this.agent?.current;
    if (!st) return '';
    const spin = ['|', '/', '-', '\\'][Math.floor(this.animMs / 150) % 4];
    if (st.state === 'working') return theme.muted(`[AI working ${spin}]`);
    if (st.state === 'attention') return theme.gold(c.bold('[AI needs you]'));
    const blink = this.agentFlash > 0 && Math.floor(this.animMs / 300) % 2 === 0;
    return blink ? c.inverse(theme.good(' AI DONE - check it ')) : theme.good('[AI done]');
  }

  private footerLevel(): string {
    const lp = levelProgress(this.save.xp);
    return theme.muted('LVL ') + c.bold(String(lp.level)) + ' ' + bar(lp.into / lp.needed, 12) + theme.muted(` ${fmt(lp.into)}/${fmt(lp.needed)} XP`);
  }

  private renderMenu(s: Extract<State, { kind: 'menu' }>): string[] {
    const { columns, rows } = this.io;
    const cursor = Math.floor(this.animMs / 530) % 2 ? '_' : ' ';
    const body: string[] = [];
    body.push(...logo(columns, this.animMs / 180));
    body.push('');
    body.push(theme.muted("YOUR AI IS THINKING. YOU'RE PLAYING.") + theme.primary(cursor));
    body.push('');
    MENU_ITEMS.forEach((it, i) => {
      const sel = i === s.sel;
      const label = `[${it.key}] ${it.label}`;
      body.push(sel ? theme.primary('> ') + c.inverse(c.bold(` ${label} `)) + ' ' + theme.muted(it.hint) : '   ' + label + ' ');
    });
    body.push('');
    const badge = this.agentBadge();
    body.push(this.footerLevel() + theme.muted(`   ${fmt(this.save.rounds)} rounds`) + (badge ? '   ' + badge : ''));
    if (this.notice) body.push(theme.gold(this.notice));
    body.push('');
    body.push(keyHint([['Up/Down', 'select'], ['Enter', 'go'], ['1-4', 'shortcut'], ['Q', 'quit']]));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderArcade(s: Extract<State, { kind: 'arcade' }>): string[] {
    const { columns, rows } = this.io;
    const body: string[] = [theme.title('ARCADE'), theme.muted('Pick a game. Modifier and difficulty are still rolled.'), ''];
    this.games.forEach((g, i) => {
      const sel = i === s.sel;
      const best = this.save.highScores[g.id]?.score;
      const name = `[${i + 1}] ${g.name}`;
      const line = padRight(sel ? c.inverse(c.bold(` ${name} `)) : ` ${name} `, 26) + padRight(theme.muted(g.genre), 24) + theme.muted('best ') + (best ? theme.gold(fmt(best)) : theme.muted('-'));
      body.push((sel ? theme.primary('> ') : '  ') + line);
      body.push('    ' + (sel ? theme.text(g.tagline) : theme.muted(g.tagline)));
    });
    body.push('');
    body.push(keyHint([['Up/Down', 'select'], ['Enter', 'play'], ['Esc', 'back']]));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderBriefing(s: Extract<State, { kind: 'briefing' }>): string[] {
    const { columns, rows } = this.io;
    const def = this.def(s.session.gameId);
    const mod = getModifier(s.session.modifierId);
    const diff = DIFFICULTIES.find((d) => d.id === s.session.difficulty)!.name;
    const secs = Math.ceil(s.countdownMs / 1000);
    const body: string[] = [];
    body.push(s.session.daily ? theme.gold(c.bold(`DAILY CHALLENGE ${s.session.daily}`)) + theme.muted('  same for everyone today') : theme.muted('NEXT UP'));
    body.push('');
    body.push(theme.title(`>> ${def.name.toUpperCase()} <<`) + '  ' + theme.muted(def.genre));
    body.push(def.tagline);
    body.push('');
    const modColor = s.session.modifierId === 'standard' ? theme.muted : s.session.modifierId === 'chaos' ? theme.bad : theme.gold;
    body.push(padRight(theme.muted('Modifier'), 12) + modColor(c.bold(mod.name)) + theme.muted(' - ' + mod.description));
    body.push(padRight(theme.muted('Difficulty'), 12) + diff);
    body.push(padRight(theme.muted('Time limit'), 12) + `${Math.round(s.session.durationMs / 1000)}s`);
    body.push(padRight(theme.muted('Seed'), 12) + theme.primary(s.session.seed));
    body.push('');
    body.push(theme.muted('Controls'));
    for (const [k, v] of def.controls) body.push('  ' + theme.key(padRight(k, 24)) + theme.muted(v));
    body.push('  ' + theme.key(padRight('Esc', 24)) + theme.muted('pause / quit round'));
    body.push('');
    body.push(theme.primary(c.bold(`Starting in ${secs}...`)));
    const hints: Array<[string, string]> = [['Enter', 'start now']];
    if (!s.session.daily) hints.push(['R', 'reroll']);
    hints.push(['Esc', 'menu']);
    body.push(keyHint(hints));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderPlaying(s: Extract<State, { kind: 'playing' }>): string[] {
    const { columns, rows } = this.io;
    const g = s.game;
    if (this.tooSmallFor(g)) {
      return centerVertically(centerBlock([
        theme.title(s.def.name.toUpperCase()) + theme.muted('  (paused)'),
        '',
        theme.bad('Terminal too small for this game.'),
        theme.muted(`Need at least ${g.minSize.width + 2}x${g.minSize.height + 6}, have ${columns}x${rows}.`),
        theme.muted('Resize the window to continue, or press Esc for the pause menu.'),
      ], columns), rows);
    }

    const gameLines = s.paused ? this.pauseOverlay(s) : g.render();
    const gameWidth = Math.max(...gameLines.map(visibleWidth), g.minSize.width);
    const width = Math.min(columns - 2, Math.max(76, gameWidth + 4));
    const mod = getModifier(s.session.modifierId);
    const left = theme.accent(c.bold('VIBEBREAK')) + theme.muted(' > ') + theme.primary(c.bold(s.def.name.toUpperCase()));
    const rightParts = [mod.id !== 'standard' ? theme.gold(mod.name) : '', theme.muted(s.session.difficulty), theme.muted(`seed ${s.session.seed}`)].filter(Boolean);
    const header = spread(left, rightParts.join(theme.muted(' · ')), width);

    const tl = g.timeLeftMs();
    const timeTone = tl <= 5000 ? (s2: string) => c.bold(theme.bad(s2)) : tl <= 10000 ? theme.gold : c.bold;
    const hud = theme.muted('SCORE ') + c.bold(theme.primary(fmt(g.score))) + theme.muted('  |  TIME ') + timeTone(fmtTime(tl)) + theme.muted('  |  ') + hudLine(g.hud());
    const badge = this.agentBadge();

    let fb = g.feedback();
    if (!fb && tl <= 5000 && !s.paused) fb = { text: `Round ends in ${Math.ceil(tl / 1000)}...`, tone: 'bad' };
    const feedback = fb ? tone(fb.tone)(c.bold(fb.text)) : '';

    const body: string[] = [];
    body.push(header);
    body.push(spread(hud, badge, width));
    body.push(rule(width));
    const area = centerBlock(gameLines, width);
    body.push(...area);
    body.push(rule(width));
    body.push(spread(feedback, keyHint([['Esc', 'pause'], ['Ctrl+C', 'exit']]), width));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private pauseOverlay(s: Extract<State, { kind: 'playing' }>): string[] {
    const lines = ['', theme.title('PAUSED'), theme.muted('The clock is stopped.'), ''];
    PAUSE_ITEMS.forEach((label, i) => {
      lines.push(i === s.pauseSel ? theme.primary('> ') + c.inverse(c.bold(` ${label} `)) : `   ${label} `);
    });
    lines.push('');
    lines.push(keyHint([['Esc', 'resume'], ['R', 'restart'], ['Q', 'end round']]));
    const h = s.game.minSize.height;
    while (lines.length < h) lines.push('');
    return lines;
  }

  private renderResults(s: Extract<State, { kind: 'results' }>): string[] {
    const { columns, rows } = this.io;
    const { result, summary } = s;
    const titleByReason: Record<string, string> = {
      time: "TIME'S UP",
      gameover: 'GAME OVER',
      win: 'OBJECTIVE COMPLETE',
      quit: 'ROUND ENDED EARLY',
    };
    const mod = getModifier(s.session.modifierId);
    const body: string[] = [];
    body.push(theme.title(titleByReason[result.endReason]) + (result.perfect ? '  ' + theme.gold(c.bold('* PERFECT RUN *')) : ''));
    body.push(theme.muted(`${s.def.name} · ${mod.name} · ${s.session.difficulty} · seed ${s.session.seed}`));
    body.push('');
    let scoreLine = theme.muted('SCORE  ') + c.bold(theme.primary(fmt(s.shownScore)));
    if (summary.newHighScore && s.shownScore >= result.score) {
      scoreLine += '   ' + theme.gold(c.bold('NEW PERSONAL BEST!')) + (summary.previousBest !== null ? theme.muted(` (was ${fmt(summary.previousBest)})`) : '');
    } else if (summary.previousBest !== null && !summary.newHighScore) {
      scoreLine += theme.muted(`   best ${fmt(summary.previousBest)}`);
    }
    body.push(scoreLine);
    if (summary.dailyBest !== undefined) body.push(theme.muted('Daily best today: ') + c.bold(fmt(summary.dailyBest)));
    body.push('');
    const m = result.metrics;
    for (let i = 0; i < m.length; i += 2) {
      const cell = (pair?: [string, string]) => (pair ? padRight(theme.muted(pair[0] + ' ') + c.bold(pair[1]), 36) : '');
      body.push(cell(m[i]) + cell(m[i + 1]));
    }
    body.push('');
    const lp = levelProgress(this.save.xp);
    body.push(
      theme.good(`+${fmt(summary.xpGained)} XP`) + (s.session.effects.xpMult > 1 ? theme.gold(' (double!)') : '') + '   ' +
        theme.muted('LVL ') + c.bold(String(lp.level)) + ' ' + bar(lp.into / lp.needed, 16) +
        (summary.levelAfter > summary.levelBefore ? '  ' + theme.gold(c.bold('LEVEL UP!')) : ''),
    );
    for (const a of summary.newAchievements) {
      body.push(theme.gold('Achievement unlocked: ') + c.bold(a.name) + theme.muted(' - ' + a.description));
    }
    if (!s.saved) body.push(theme.bad('Could not write the save file; stats for this round were not stored.'));
    if (s.session.daily) {
      body.push('');
      body.push(theme.muted('Share text is printed when you quit.'));
    }
    const badge = this.agentBadge();
    if (badge) body.push('', badge);
    body.push('');
    body.push(keyHint([['Enter', s.session.daily ? 'retry daily' : 'replay'], ['N', 'play another'], ['M', 'menu'], ['Q', 'quit to shell']]));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderStats(s: Extract<State, { kind: 'stats' }>): string[] {
    const { columns, rows } = this.io;
    const body = statsLines(this.save, this.games, Math.min(columns, 100), rows < 36);
    body.push('');
    if (s.confirmReset) body.push(theme.bad(c.bold('Press X again to erase all stats. Any other key cancels.')));
    else if (this.notice) body.push(theme.gold(this.notice));
    body.push(keyHint([['Esc', 'back'], ['X', 'reset stats']]));
    return centerVertically(centerBlock(body, columns), rows);
  }
}

/** Plain-text share card for the daily challenge (no spoilers, no colour). */
export function shareText(session: SessionConfig, def: GameDefinition, result: GameResult, summary: RoundSummary): string {
  const mod = getModifier(session.modifierId);
  const blocks = Math.max(0, Math.min(10, Math.round((result.score / Math.max(1, summary.dailyBest ?? result.score)) * 10)));
  return [
    `VibeBreak Daily ${session.daily}`,
    `${def.name} · ${mod.name} · ${session.difficulty}`,
    `Score ${fmt(result.score)}${result.perfect ? ' · PERFECT' : ''}  [${'#'.repeat(blocks)}${'-'.repeat(10 - blocks)}]`,
    'Play it: vibebreak daily',
  ].join('\n');
}
