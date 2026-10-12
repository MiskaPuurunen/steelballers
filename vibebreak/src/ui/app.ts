import path from 'node:path';
import type { GameDefinition, GameInstance, GameResult, Key, SessionConfig, Tone } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { generateSession, todayUtc, type SessionOptions } from '../core/session.js';
import { getModifier, DIFFICULTIES } from '../core/modifiers.js';
import { levelProgress, recordCustomRound, recordRound, unlock, getAchievement, type RoundSummary } from '../core/progression.js';
import { GAMES } from '../games/index.js';
import { configDir, type SaveData, type SaveStore } from '../storage/save.js';
import type { AgentMonitor, AgentSnapshot } from '../integrations/agent-status.js';
import type { AiStatus, StatusView } from '../integrations/agent-model.js';
import type { TerminalIO } from './terminal.js';
import { Screen } from './screen.js';
import { KeyStream, isCtrlC, parseKeys } from './keys.js';
import { c, getColorDepth, theme, tone, truncate, visibleWidth } from './style.js';
import { LineInput, TextEditor } from './text-editor.js';
import { CUSTOM_PREFIX, compileCustomGame, scriptErrorOf, type CustomMeta } from '../custom/lua-game.js';
import { loadLuaRuntime, type LuaRuntime } from '../custom/lua-runtime.js';
import { deleteScript, gamesDir, listGameFiles, normalizeInputPath, readScript, saveScript } from '../custom/library.js';
import { TEMPLATE_LUA } from '../custom/template.js';
import {
  bar, centerBlock, centerVertically, fmt, fmtTime, hudLine, keyHint, logo, padRight, rule, spread,
} from './layout.js';
import { statsLines } from './stats-view.js';
import { THEMES, SEASONAL, activeTheme, applyTheme, overlayParticles, particleCells, resolveTheme, seasonalTheme, themeIds, type ThemeDef } from './themes.js';
import { paint } from './style.js';

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
  agent?: AgentMonitor | null;
  /** Wall clock for event ages (tests inject a fake). */
  wallNow?: () => number;
  /** Notice shown on the menu (e.g. recovered from a corrupted save). */
  notice?: string;
  /** Frame interval in ms. */
  frameMs?: number;
  /** Folder for user-made Lua games (default: <config dir>/games). */
  customDir?: string;
  /** Loads the Lua runtime (injectable for tests). */
  loadRuntime?: () => Promise<LuaRuntime>;
  /** Briefing auto-start countdown in ms. */
  countdownMs?: number;
  /** Theme for this run only (--theme); otherwise the saved setting. */
  themeOverride?: string;
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
      /** Script error that ended a custom game, if any. */
      note: string | null;
    }
  | { kind: 'stats'; confirmReset: boolean }
  | { kind: 'themes'; sel: number; revertTo: ThemeDef }
  | { kind: 'custom'; sel: number; confirmDelete: boolean }
  | { kind: 'custom-file'; input: LineInput; error: string | null; failedSource: string | null }
  | { kind: 'custom-editor'; error: string | null; confirmClear: boolean };

type CustomStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

const MENU_ITEMS: Array<{ key: string; label: string; hint: string }> = [
  { key: '1', label: 'QUICK PLAY', hint: 'random game, random modifier' },
  { key: '2', label: 'ARCADE', hint: 'pick a game' },
  { key: '3', label: 'DAILY CHALLENGE', hint: 'same seed for everyone today' },
  { key: '4', label: 'STATS & ACHIEVEMENTS', hint: 'your progress' },
  { key: '5', label: 'THEMES', hint: 'Christmas, Halloween, Frutiger Aero...' },
  { key: '6', label: 'CUSTOM GAMES', hint: 'play your own Lua games' },
  { key: 'Q', label: 'QUIT', hint: 'back to work' },
];

const PAUSE_ITEMS = ['Resume', 'Restart round', 'End round'];
const COUNTDOWN_MS = 4000;
const RESULTS_LOCK_MS = 600;
const AGENT_POLL_MS = 500;

/* ------------------------------------------------------------------- app */

export class App {
  private readonly io: TerminalIO;
  private readonly screen: Screen;
  private readonly games: readonly GameDefinition[];
  private readonly sched: Scheduler;
  private readonly store: SaveStore;
  private readonly agent: AgentMonitor | null;
  private readonly wallNow: () => number;
  private agentSnap: AgentSnapshot | null = null;
  private agentKey = '';
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
  private readonly countdownMs: number;
  private readonly launchedToPlay: boolean;
  private finished = false;
  private readonly keyStream = new KeyStream();

  // Custom (Lua) games. Loaded lazily the first time the screen is opened.
  private readonly customDir: string;
  private readonly loadRuntime: () => Promise<LuaRuntime>;
  private customStatus: CustomStatus = 'idle';
  private customRuntime: LuaRuntime | null = null;
  private customGames: GameDefinition[] = [];
  private customProblems: Array<{ file: string; error: string }> = [];
  private customReason = '';
  private customMessage: { text: string; tone: Tone } | null = null;
  private customLoading: Promise<void> = Promise.resolve();
  /** The paste/write editor keeps its text between visits. */
  private readonly draft = new TextEditor();

  constructor(opts: AppOptions) {
    this.io = opts.io;
    this.screen = new Screen(opts.io);
    this.games = opts.games ?? GAMES;
    this.sched = opts.scheduler ?? realScheduler;
    this.store = opts.store;
    this.save = opts.save;
    this.agent = opts.agent ?? null;
    this.wallNow = opts.wallNow ?? Date.now;
    this.notice = opts.notice;
    this.frameMs = opts.frameMs ?? 33;
    this.customDir = opts.customDir ?? gamesDir(configDir());
    this.loadRuntime = opts.loadRuntime ?? loadLuaRuntime;
    this.countdownMs = opts.countdownMs ?? COUNTDOWN_MS;
    this.launchedToPlay = opts.start.mode !== 'menu';
    applyTheme(resolveTheme(opts.themeOverride ?? this.save.settings.theme));
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

  /** Resolves when the custom game library has finished loading (for tests). */
  get customReady(): Promise<void> {
    return this.customLoading;
  }

  /** The editor draft (for tests). */
  get editor(): TextEditor {
    return this.draft;
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
      this.pollAgent();
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

    // Independent of input: the status line refreshes even while nobody types.
    this.sinceAgentPoll += dt;
    if (this.agent && this.sinceAgentPoll >= AGENT_POLL_MS) {
      this.sinceAgentPoll = 0;
      this.pollAgent();
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
    for (const key of this.keyStream.feed(data)) {
      if (this.finished) return;
      // Only the text fields want a paste as one block. Everywhere else it is
      // replayed as ordinary keys, exactly as before bracketed paste existed.
      const keys = key.name === 'paste' && !this.acceptsPaste() ? parseKeys(key.text ?? '') : [key];
      for (const k of keys) {
        if (this.finished) return;
        if (isCtrlC(k)) {
          this.quit();
          return;
        }
        this.onKey(k);
      }
    }
    if (!this.finished) this.render();
  }

  private acceptsPaste(): boolean {
    return this.state.kind === 'custom-file' || this.state.kind === 'custom-editor';
  }

  /** Re-scan agent sessions; flash when the followed session finishes or needs you. */
  private pollAgent(): void {
    if (!this.agent) return;
    try {
      this.agent.poll(this.wallNow());
      this.agentSnap = this.agent.snapshot(this.wallNow());
    } catch {
      this.agentSnap = null;
    }
    const p = this.agentSnap?.primary;
    const key = p ? `${p.sessionId}:${p.status}` : '';
    if (key !== this.agentKey && p && p.certainty === 'reported' && (p.status === 'COMPLETED' || p.status === 'WAITING_FOR_INPUT' || p.status === 'ERROR')) {
      this.agentFlash = 4000;
    }
    this.agentKey = key;
  }

  /** The agent session the HUD is showing (for tests). */
  get agentView(): StatusView | null {
    return this.agentSnap?.primary ?? null;
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
      case 'themes': return this.themesKey(s, key);
      case 'custom': return this.customKey(s, key);
      case 'custom-file': return this.customFileKey(s, key);
      case 'custom-editor': return this.customEditorKey(s, key);
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
    if (opts.gameId?.startsWith(CUSTOM_PREFIX)) return generateSession(this.customGames, { ...opts, previousGameId: null });
    return generateSession(this.games, { previousGameId: this.save.lastGameId, ...opts });
  }

  private def(id: string): GameDefinition {
    return this.games.find((g) => g.id === id) ?? this.customGames.find((g) => g.id === id)!;
  }

  private isCustom(session: SessionConfig): boolean {
    return session.gameId.startsWith(CUSTOM_PREFIX);
  }

  private toBriefing(session: SessionConfig): void {
    this.state = { kind: 'briefing', session, countdownMs: this.countdownMs };
  }

  private startRound(session: SessionConfig): void {
    const def = this.def(session.gameId);
    const best = def.custom ? this.save.customScores[session.gameId] : this.save.highScores[session.gameId];
    let game: GameInstance;
    try {
      game = def.create({
        rng: new Rng(session.seed).fork(`game:${session.gameId}`),
        difficulty: session.difficulty,
        effects: session.effects,
        durationMs: session.durationMs,
        ...(best ? { personalBest: best.score } : {}),
      });
    } catch (err) {
      if (!def.custom) throw err;
      // A user script can fail in init() with some seeds/modifiers only.
      this.customMessage = { text: `${def.name} failed to start: ${errText(err)}`, tone: 'bad' };
      this.toCustomList(def.id);
      return;
    }
    this.state = { kind: 'playing', session, def, game, playedMs: 0, paused: false, pauseSel: 0 };
    this.screen.invalidate();
  }

  private finishRound(): void {
    const s = this.state;
    if (s.kind !== 'playing') return;
    const result = s.game.result();
    s.game.dispose();
    const note = scriptErrorOf(s.game);
    const summary = s.def.custom
      ? recordCustomRound(this.save, s.def, s.session, result)
      : recordRound(this.save, s.def, s.session, result, s.playedMs, this.games.map((g) => g.id));
    const saved = this.store.save(this.save);
    this.roundsThisRun++;
    this.xpThisRun += summary.xpGained;
    if (s.session.daily) this.dailyShare = shareText(s.session, s.def, result, summary);
    this.state = { kind: 'results', session: s.session, def: s.def, result, summary, shownScore: 0, lockMs: RESULTS_LOCK_MS, saved, note };
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
    else if (k === '5') {
      const ids = themeIds();
      const cur = ids.indexOf(this.save.settings.theme);
      this.state = { kind: 'themes', sel: cur >= 0 ? cur : ids.indexOf(activeTheme().id), revertTo: activeTheme() };
    }
    else if (k === '6') this.toCustomList();
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
    } else if (ch === 'r' && this.isCustom(s.session)) {
      // Custom games reroll the seed, difficulty and modifier, not the game.
      this.toBriefing(this.newSession({ gameId: s.session.gameId }));
    } else if (ch === 'r' && !s.session.daily) {
      // Reroll: a fresh random session that avoids the game just offered.
      this.toBriefing(generateSession(this.games, { previousGameId: s.session.gameId }));
    } else if (key.name === 'escape' || ch === 'q') {
      if (this.isCustom(s.session)) this.toCustomList(s.session.gameId);
      else this.state = { kind: 'menu', sel: 0 };
    }
  }

  private playingKey(s: Extract<State, { kind: 'playing' }>, key: Key): void {
    if (s.paused) {
      const ch = key.ch?.toLowerCase();
      const resume = s.def.appKeys?.pause?.includes(ch ?? '');
      if (resume) { s.paused = false; return; }
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
    // Per-game shortcuts for arcade actions (e.g. Tetris: P / R / Q).
    const ch = key.name === 'char' && !key.ctrl ? key.ch?.toLowerCase() : undefined;
    const ak = s.def.appKeys;
    if (ch && ak) {
      if (ak.pause?.includes(ch)) { s.paused = true; s.pauseSel = 0; return; }
      if (ak.restart?.includes(ch)) return this.pauseAction(1);
      if (ak.quit?.includes(ch)) return this.pauseAction(2);
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
      if (s.def.custom) this.toCustomList(s.def.id);
      else this.state = { kind: 'menu', sel: 0 };
    } else if (ch === 'q') {
      if (!s.def.custom && unlock(this.save, 'back-to-work')) {
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

  private themesKey(s: Extract<State, { kind: 'themes' }>, key: Key): void {
    const ids = themeIds();
    const ch = key.ch?.toLowerCase();
    const preview = () => applyTheme(resolveTheme(ids[s.sel]));
    if (key.name === 'up') { s.sel = (s.sel + ids.length - 1) % ids.length; preview(); }
    else if (key.name === 'down' || key.name === 'tab') { s.sel = (s.sel + 1) % ids.length; preview(); }
    else if (ch && /^[1-9]$/.test(ch) && Number(ch) <= ids.length) { s.sel = Number(ch) - 1; preview(); }
    else if (ch === 'a') {
      this.save.settings.animations = !this.save.settings.animations;
      this.store.save(this.save);
    } else if (key.name === 'enter' || key.name === 'space') {
      if (!this.enterOk()) return;
      this.save.settings.theme = ids[s.sel];
      preview();
      this.notice = this.store.save(this.save) ? `Theme set: ${themeLabel(ids[s.sel])}` : 'Could not save the theme setting.';
      this.state = { kind: 'menu', sel: 4 };
    } else if (key.name === 'escape' || ch === 'q' || key.name === 'backspace') {
      applyTheme(s.revertTo);
      this.state = { kind: 'menu', sel: 4 };
    }
  }

  /* ------------------------------------------------- custom games */

  private toCustomList(selectId?: string): void {
    const i = selectId ? this.customGames.findIndex((g) => g.id === selectId) : -1;
    this.state = { kind: 'custom', sel: Math.max(0, i), confirmDelete: false };
    this.ensureCustomLoaded();
  }

  private ensureCustomLoaded(): void {
    if (this.customStatus !== 'idle') return;
    this.customStatus = 'loading';
    this.customLoading = this.loadRuntime()
      .then(
        (rt) => {
          this.customRuntime = rt;
          this.scanCustomFolder();
          this.customStatus = 'ready';
        },
        (err: unknown) => {
          this.customStatus = 'unavailable';
          this.customReason = errText(err);
        },
      )
      .then(() => {
        if (!this.finished) this.render();
      });
  }

  /** (Re)load every .lua file in the library folder. */
  private scanCustomFolder(): void {
    const rt = this.customRuntime;
    if (!rt) return;
    const games: GameDefinition[] = [];
    const problems: Array<{ file: string; error: string }> = [];
    for (const { file, source } of listGameFiles(this.customDir)) {
      const name = path.basename(file);
      const r = compileCustomGame(source, rt, file);
      if (!r.ok) problems.push({ file: name, error: r.error });
      else if (games.some((g) => g.id === r.def.id)) problems.push({ file: name, error: `duplicate game id "${r.meta.id}"` });
      else games.push(r.def);
    }
    this.customGames = games.sort((a, b) => a.name.localeCompare(b.name));
    this.customProblems = problems;
  }

  /** Save a validated script to the library and select it in the list. */
  private installCustom(source: string, def: GameDefinition, meta: CustomMeta, verb: string): void {
    const replaced = this.customGames.some((g) => g.id === def.id);
    let where: string;
    try {
      const file = saveScript(this.customDir, meta.id, source);
      def.custom = { source, file };
      where = `Saved to ${file}`;
    } catch (err) {
      where = `Could not save a copy (${errText(err)}); it is available until you quit`;
    }
    this.customGames = [...this.customGames.filter((g) => g.id !== def.id), def].sort((a, b) => a.name.localeCompare(b.name));
    this.customProblems = this.customProblems.filter((p) => p.file !== `${meta.id}.lua`);
    this.customMessage = { text: `${replaced ? 'Updated' : verb} "${def.name}". ${where}. Press Enter to play.`, tone: 'good' };
    this.toCustomList(def.id);
  }

  /** True when the Lua runtime is ready; otherwise explains why not. */
  private customUsable(): boolean {
    if (this.customStatus === 'ready') return true;
    this.customMessage = this.customStatus === 'unavailable'
      ? { text: this.customReason, tone: 'bad' }
      : { text: 'Still loading the Lua runtime, one moment...', tone: 'info' };
    return false;
  }

  private customKey(s: Extract<State, { kind: 'custom' }>, key: Key): void {
    const ch = key.ch?.toLowerCase();
    const n = this.customGames.length;
    if (ch !== 'x') s.confirmDelete = false;
    if (key.name === 'up' && n) s.sel = (s.sel + n - 1) % n;
    else if ((key.name === 'down' || key.name === 'tab') && n) s.sel = (s.sel + 1) % n;
    else if (key.name === 'escape' || key.name === 'backspace' || ch === 'q') {
      this.customMessage = null;
      this.state = { kind: 'menu', sel: 5 };
    } else if (key.name === 'enter' || key.name === 'space') {
      if (n && this.enterOk()) this.playCustom(s.sel);
    } else if (ch && /^[1-9]$/.test(ch)) {
      if (Number(ch) - 1 < n) this.playCustom(Number(ch) - 1);
    } else if (ch === 'f') {
      if (this.customUsable()) {
        this.customMessage = null;
        this.state = { kind: 'custom-file', input: new LineInput(), error: null, failedSource: null };
      }
    } else if (ch === 'p') {
      if (this.customUsable()) this.openEditor(null);
    } else if (ch === 'n') {
      if (!this.customUsable()) return;
      if (this.draft.isEmpty) this.draft.setText(TEMPLATE_LUA);
      this.openEditor(this.draft.text === TEMPLATE_LUA ? null : 'Your draft is still here. Ctrl+X clears it, then Ctrl+N loads the example.');
    } else if (ch === 'r') {
      if (!this.customUsable()) return;
      this.scanCustomFolder();
      s.sel = Math.min(s.sel, Math.max(0, this.customGames.length - 1));
      this.customMessage = { text: `Reloaded ${this.customGames.length} game${this.customGames.length === 1 ? '' : 's'} from the folder.`, tone: 'info' };
    } else if (ch === 'x' && n) {
      const def = this.customGames[s.sel];
      if (!s.confirmDelete) {
        s.confirmDelete = true;
        return;
      }
      s.confirmDelete = false;
      if (def.custom?.file) deleteScript(def.custom.file);
      this.customGames = this.customGames.filter((g) => g !== def);
      s.sel = Math.min(s.sel, Math.max(0, this.customGames.length - 1));
      this.customMessage = { text: `Deleted "${def.name}".`, tone: 'info' };
    }
  }

  private playCustom(i: number): void {
    this.customMessage = null;
    this.toBriefing(this.newSession({ gameId: this.customGames[i].id }));
  }

  private openEditor(error: string | null): void {
    this.customMessage = null;
    this.state = { kind: 'custom-editor', error, confirmClear: false };
  }

  private customFileKey(s: Extract<State, { kind: 'custom-file' }>, key: Key): void {
    if (key.name === 'escape') return this.toCustomList();
    if (key.ctrl && key.ch === 'e' && s.failedSource !== null) {
      // Open the broken file in the editor, at the line with the error.
      this.draft.setText(s.failedSource);
      const line = /^Line (\d+):/.exec(s.error ?? '');
      if (line) this.draft.goToLine(Number(line[1]));
      this.openEditor(s.error);
      return;
    }
    if (key.name === 'enter') {
      if (this.enterOk()) this.loadFromPath(s);
      return;
    }
    if (s.input.handleKey(key)) {
      s.error = null;
      s.failedSource = null;
    }
  }

  private loadFromPath(s: Extract<State, { kind: 'custom-file' }>): void {
    const raw = s.input.value.trim();
    if (!raw) {
      s.error = 'Type or paste a path first.';
      return;
    }
    let source: string;
    try {
      source = readScript(normalizeInputPath(raw));
    } catch (err) {
      s.error = errText(err);
      return;
    }
    const r = compileCustomGame(source, this.customRuntime!);
    if (!r.ok) {
      s.error = r.line ? `Line ${r.line}: ${r.error.replace(/^game:\d+:\s*/, '')}` : r.error;
      s.failedSource = source;
      return;
    }
    this.installCustom(source, r.def, r.meta, 'Loaded');
  }

  private customEditorKey(s: Extract<State, { kind: 'custom-editor' }>, key: Key): void {
    const ctrl = key.ctrl ? key.ch : undefined;
    if (ctrl !== 'x') s.confirmClear = false;
    if (key.name === 'escape') return this.toCustomList();
    if (ctrl === 's') {
      const r = compileCustomGame(this.draft.text, this.customRuntime!);
      if (!r.ok) {
        s.error = r.line ? `Line ${r.line}: ${r.error.replace(/^game:\d+:\s*/, '')}` : r.error;
        if (r.line) this.draft.goToLine(r.line);
        return;
      }
      this.draft.dirty = false;
      this.installCustom(this.draft.text, r.def, r.meta, 'Added');
      return;
    }
    if (ctrl === 'n') {
      if (this.draft.isEmpty) {
        this.draft.setText(TEMPLATE_LUA);
        s.error = null;
      } else s.error = 'The editor is not empty. Press Ctrl+X twice to clear it first.';
      return;
    }
    if (ctrl === 'x') {
      if (s.confirmClear) {
        this.draft.clear();
        s.confirmClear = false;
        s.error = null;
      } else s.confirmClear = true;
      return;
    }
    if (this.draft.handleKey(key)) s.error = null;
    else if (key.name === 'paste' || (key.name === 'char' && !key.ctrl)) s.error = 'The script is too long (128 KB max).';
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
        case 'themes': lines = this.renderThemes(this.state); break;
        case 'custom': lines = this.renderCustom(this.state); break;
        case 'custom-file': lines = this.renderCustomFile(this.state); break;
        case 'custom-editor': lines = this.renderEditor(this.state); break;
      }
      // Ambient particles fill empty space on menu-like screens, never on a game board.
      const specs = activeTheme().particles;
      if (specs && this.save.settings.animations && this.state.kind !== 'playing') {
        lines = overlayParticles(lines, particleCells(specs, columns, rows, this.animMs), columns, rows);
      }
    }
    this.screen.draw(lines);
  }

  /** One-line agent status, fitted to `width`. Empty when there is nothing to show. */
  agentLine(width: number, withAge = true): string {
    const v = this.agentSnap?.primary;
    if (!v) return '';
    const inferred = v.certainty === 'inferred';
    const label = STATUS_LABEL[v.status] + (inferred ? '?' : '');
    const spin = ['|', '/', '-', '\\'][Math.floor(this.animMs / 150) % 4];
    let badge: string;
    if (inferred) badge = theme.muted(`AI ${label}`);
    else if (v.status === 'WORKING' || v.status === 'THINKING') badge = theme.primary(c.bold(`AI ${label}`)) + ' ' + theme.muted(spin);
    else if (v.status === 'WAITING_FOR_INPUT' || v.status === 'ERROR') {
      const paint = v.status === 'ERROR' ? theme.bad : theme.gold;
      const blink = this.agentFlash > 0 && Math.floor(this.animMs / 300) % 2 === 0;
      badge = blink ? c.inverse(paint(c.bold(` AI ${label} `))) : paint(c.bold(`AI ${label}`));
    } else if (v.status === 'COMPLETED') {
      const blink = this.agentFlash > 0 && Math.floor(this.animMs / 300) % 2 === 0;
      badge = blink ? c.inverse(theme.good(' AI DONE - check it ')) : theme.good(c.bold('AI DONE'));
    } else badge = theme.muted(`AI ${label}`);

    const more = this.agentSnap!.others.filter((o) => o.status !== 'IDLE').length;
    const where = [v.project, v.sessionId.slice(0, 6)].filter(Boolean).join(' ');
    const age = withAge ? `${fmtAgo(this.wallNow() - v.activityAt)} ago` : '';
    const right = theme.muted([where, age].filter(Boolean).join(' · ') + (more ? ` · +${more} more` : ''));
    // Detail gets whatever room is left; it is the first thing to go.
    const room = width - visibleWidth(badge) - visibleWidth(right) - 5;
    const detail = room >= 8 ? theme.muted(truncateText(v.detail, room)) : '';
    const left = badge + (detail ? '  ' + detail : '');
    if (visibleWidth(left) + visibleWidth(right) + 2 > width) return left;
    return spread(left, right, width);
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
    body.push(theme.muted(activeTheme().tagline) + theme.primary(cursor));
    body.push('');
    MENU_ITEMS.forEach((it, i) => {
      const sel = i === s.sel;
      const label = `[${it.key}] ${it.label}`;
      body.push(sel ? theme.primary('> ') + c.inverse(c.bold(` ${label} `)) + ' ' + theme.muted(it.hint) : '   ' + label + ' ');
    });
    body.push('');
    body.push(this.footerLevel() + theme.muted(`   ${fmt(this.save.rounds)} rounds`));
    const ai = this.agentLine(Math.min(columns - 4, 76));
    if (ai) body.push(ai);
    if (this.notice) body.push(theme.gold(this.notice));
    body.push('');
    body.push(keyHint([['Up/Down', 'select'], ['Enter', 'go'], ['1-6', 'shortcut'], ['Q', 'quit']]));
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
    const custom = this.isCustom(s.session);
    body.push(
      s.session.daily ? theme.gold(c.bold(`DAILY CHALLENGE ${s.session.daily}`)) + theme.muted('  same for everyone today')
        : custom ? theme.accent('CUSTOM GAME') + theme.muted('  no XP, best score is kept')
          : theme.muted('NEXT UP'),
    );
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
    if (!s.session.daily) hints.push(['R', custom ? 'new seed' : 'reroll']);
    hints.push(['Esc', custom ? 'back' : 'menu']);
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
    let fb = g.feedback();
    if (!fb && tl <= 5000 && !s.paused) fb = { text: `Round ends in ${Math.ceil(tl / 1000)}...`, tone: 'bad' };
    const feedback = fb ? tone(fb.tone)(c.bold(fb.text)) : '';

    const body: string[] = [];
    body.push(header);
    body.push(hud);
    body.push(rule(width, this.animMs));
    const area = centerBlock(gameLines, width);
    body.push(...area);
    body.push(rule(width, this.animMs));
    body.push(spread(feedback, keyHint([['Esc', 'pause'], ['Ctrl+C', 'exit']]), width));
    // Own row, so status updates never shift or overwrite the board.
    if (this.agent) body.push(this.agentLine(width) || theme.muted('AI status: no agent activity seen (vibebreak doctor)'));
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
    if (s.note) {
      body.push(theme.bad('Script error: ') + theme.muted(s.note));
      body.push('');
    }
    const lp = levelProgress(this.save.xp);
    if (s.def.custom) body.push(theme.muted('Custom game: no XP or achievements. Your best score is kept.'));
    else body.push(
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
    const ai = this.agentLine(Math.min(columns - 4, 76));
    if (ai) body.push('', ai);
    body.push('');
    body.push(keyHint([['Enter', s.session.daily ? 'retry daily' : 'replay'], ['N', 'play another'], ['M', s.def.custom ? 'my games' : 'menu'], ['Q', 'quit to shell']]));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderThemes(s: Extract<State, { kind: 'themes' }>): string[] {
    const { columns, rows } = this.io;
    const ids = themeIds();
    const body: string[] = [];
    // The logo previews the highlighted theme (it is applied live).
    if (rows >= 30) body.push(...logo(columns, this.animMs / 180), '');
    body.push(theme.title('THEMES') + theme.muted('  preview live, Enter to keep'));
    body.push('');
    ids.forEach((id, i) => {
      const sel = i === s.sel;
      const t = id === SEASONAL ? null : THEMES.find((x) => x.id === id)!;
      const name = `[${i + 1}] ${t ? t.name : 'Seasonal'}`;
      const saved = id === this.save.settings.theme ? theme.gold(' *') : '  ';
      const sw = swatch(t ?? resolveTheme(SEASONAL));
      const label = padRight(sel ? c.inverse(c.bold(` ${name} `)) : ` ${name} `, 20);
      body.push((sel ? theme.primary('> ') : '  ') + label + sw + saved);
      const desc = t ? t.description : `Christmas in December, Halloween from Oct 15, Classic otherwise (now: ${themeLabel(seasonalTheme())}).`;
      if (sel) body.push('     ' + theme.muted(desc));
    });
    body.push('');
    body.push(theme.muted('Ambient animation ') + (this.save.settings.animations ? theme.good('on') : theme.muted('off')) +
      theme.muted('   * = saved   colours: ') + theme.muted(getColorDepthLabel()));
    body.push(keyHint([['Up/Down', 'preview'], ['Enter', 'keep'], ['A', 'animation on/off'], ['Esc', 'cancel']]));
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
  private renderCustom(s: Extract<State, { kind: 'custom' }>): string[] {
    const { columns, rows } = this.io;
    const w = Math.min(columns - 2, 76);
    const body: string[] = [theme.title('CUSTOM GAMES'), theme.muted('Your own Lua games. No XP or achievements; best scores are kept.'), ''];
    const games = this.customGames;
    if (this.customStatus === 'loading' || this.customStatus === 'idle') body.push(theme.muted('Loading the Lua runtime...'));
    else if (this.customStatus === 'unavailable') body.push(theme.bad(this.customReason));
    else if (!games.length) {
      body.push(theme.muted('No custom games yet.'));
      body.push(theme.muted('Press ') + theme.key('N') + theme.muted(' to start from a working example, or ') + theme.key('P') + theme.muted(' to paste code.'));
    } else {
      // Show a window of the list around the selection so it fits short terminals.
      const fit = Math.max(2, Math.floor((rows - 16) / 2));
      const start = Math.min(Math.max(0, s.sel - Math.floor(fit / 2)), Math.max(0, games.length - fit));
      games.slice(start, start + fit).forEach((g, j) => {
        const i = start + j;
        const sel = i === s.sel;
        const best = this.save.customScores[g.id]?.score;
        const name = `[${i < 9 ? i + 1 : ' '}] ${g.name}`;
        const line = padRight(sel ? c.inverse(c.bold(` ${name} `)) : ` ${name} `, 30) + padRight(theme.muted(g.genre), 20) + theme.muted('best ') + (best ? theme.gold(fmt(best)) : theme.muted('-'));
        body.push((sel ? theme.primary('> ') : '  ') + line);
        body.push('    ' + (sel ? theme.text(g.tagline) : theme.muted(g.tagline)));
      });
      if (games.length > fit) body.push(theme.muted(`    ${games.length} games, scroll with Up/Down`));
    }
    for (const p of this.customProblems.slice(0, 3)) body.push(theme.bad('! ') + theme.muted(`${p.file}: ${p.error}`));
    if (this.customProblems.length > 3) body.push(theme.muted(`  ...and ${this.customProblems.length - 3} more files with errors`));
    body.push('');
    if (s.confirmDelete) body.push(theme.bad(c.bold(`Press X again to delete "${games[s.sel]?.name}". Any other key cancels.`)));
    else if (this.customMessage) {
      const paint = tone(this.customMessage.tone);
      for (const l of wrapText(this.customMessage.text, w).slice(0, 3)) body.push(paint(l));
    }
    body.push(keyHint([['Enter', 'play'], ['F', 'load file'], ['P', 'paste code'], ['N', 'new from example']]));
    body.push(keyHint([['R', 'reload folder'], ['X', 'delete'], ['Esc', 'back']]));
    body.push(theme.muted(`Folder: ${this.customDir}`));
    return centerVertically(centerBlock(body.map((l) => truncate(l, w)), columns), rows);
  }

  private renderCustomFile(s: Extract<State, { kind: 'custom-file' }>): string[] {
    const { columns, rows } = this.io;
    const w = Math.min(columns - 2, 76);
    const body: string[] = [
      theme.title('LOAD A GAME FILE'),
      theme.muted('Type or paste the path to a .lua file. Dragging the file'),
      theme.muted('into this window works too. It is checked, then copied'),
      theme.muted('to your custom games folder.'),
      '',
      theme.primary('> ') + s.input.view(w - 4),
      '',
    ];
    if (s.error) {
      for (const l of wrapText(s.error, w)) body.push(theme.bad(l));
    } else body.push(theme.muted(truncate(`Relative paths start from ${process.cwd()}`, w)));
    body.push('');
    const hints: Array<[string, string]> = [['Enter', 'load']];
    if (s.failedSource !== null) hints.push(['Ctrl+E', 'fix it in the editor']);
    hints.push(['Esc', 'back']);
    body.push(keyHint(hints));
    return centerVertically(centerBlock(body, columns), rows);
  }

  private renderEditor(s: Extract<State, { kind: 'custom-editor' }>): string[] {
    const { columns, rows } = this.io;
    const w = Math.min(columns - 2, 110);
    const ed = this.draft;
    const pos = theme.muted(`line ${ed.row + 1}/${ed.lines.length}  col ${ed.col + 1}`);
    const body: string[] = [];
    body.push(spread(theme.title('PASTE OR WRITE A GAME') + theme.muted('  Lua'), pos, w));
    body.push(rule(w, this.animMs));
    body.push(...ed.view(w, Math.max(3, rows - 6)));
    body.push(rule(w, this.animMs));
    if (s.confirmClear) body.push(theme.bad(c.bold('Press Ctrl+X again to clear everything. Any other key cancels.')));
    else if (s.error) body.push(theme.bad(truncate(s.error, w)));
    else if (ed.isEmpty) body.push(theme.muted('Paste your script here (Ctrl+V or right-click), or press Ctrl+N for an example.'));
    else body.push(theme.muted('Ctrl+S checks the script and adds it to your games. Esc keeps the draft.'));
    body.push(keyHint([['Ctrl+S', 'check & save'], ['Ctrl+N', 'example'], ['Ctrl+X', 'clear'], ['Esc', 'back']]));
    return centerBlock(body.map((l) => truncate(l, w)), columns);
  }
}

const STATUS_LABEL: Record<AiStatus, string> = {
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  WORKING: 'WORKING',
  WAITING_FOR_INPUT: 'NEEDS YOU',
  COMPLETED: 'DONE',
  ERROR: 'ERROR',
  UNKNOWN: 'UNKNOWN',
};

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function truncateText(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + '~';
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

function themeLabel(id: string): string {
  return id === SEASONAL ? 'Seasonal' : THEMES.find((t) => t.id === id)?.name ?? id;
}

/** A row of colour chips showing a theme's palette. */
function swatch(t: ThemeDef): string {
  const roles = ['primary', 'accent', 'good', 'gold', 'bad', 'muted'] as const;
  return roles.map((r) => paint(t.palette[r])('##')).join('');
}

function getColorDepthLabel(): string {
  return getColorDepth() === 256 ? '256' : '16 (basic)';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = '';
    }
    line = line ? `${line} ${word}` : word.slice(0, width);
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}
