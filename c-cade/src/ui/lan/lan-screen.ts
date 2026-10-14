import type { Key } from '../../core/types.js';
import { LanServer, type ServerOptions } from '../../net/server.js';
import { LanClient, type ClientOptions } from '../../net/client.js';
import { scanRooms, type FoundRoom } from '../../net/discovery.js';
import { DEFAULT_PORT, PROTOCOL_VERSION, type ChatLine, type LobbyState } from '../../net/protocol.js';
import { lanInterfaces, parseHostPort } from '../../net/address.js';
import { cleanName, wrapText as wrap } from '../../net/sanitize.js';
import { MP_GAMES, RANDOM_GAME } from '../../mp/registry.js';
import type { CustomPrompt, Standing } from '../../mp/types.js';
import { c, padRight, theme, truncate, visibleWidth } from '../style.js';
import { centerBlock, centerVertically, keyHint, rule, spread } from '../layout.js';
import { TextField, countdown, lower, optionLabel, scoreboard } from './widgets.js';
import { createGameUi } from './game-uis.js';
import type { MpGameUi } from './types.js';

/**
 * The LAN part of the arcade: host/join setup, lobby, match and results.
 *
 * It is driven entirely by the App's single loop (tick/onKey/render): the
 * network delivers messages into LanClient state asynchronously, and the
 * next frame renders it. Nothing here writes to the terminal directly, so
 * network events can never corrupt the display or fight over stdin.
 */

export type LanStart =
  | {
      mode: 'host';
      gameId?: string;
      party?: boolean;
      name?: string;
      port?: number;
      bind?: string;
      maxPlayers?: number;
      allowPublic?: boolean;
      options?: Record<string, unknown>;
      prompts?: CustomPrompt[];
      /** Open the lobby straight away (CLI `c-cade host`), skipping the setup form. */
      immediate?: boolean;
      spectate?: boolean;
    }
  | { mode: 'join'; host?: string; port?: number; name?: string; spectate?: boolean; immediate?: boolean };

interface MatchRecord {
  gameId: string;
  matchId: string;
  rank: number;
  players: number;
  won: boolean;
  stats: Record<string, number>;
}

export interface LanDeps {
  defaultName: string;
  /** Resolve --bind style specs to an address. */
  resolveBind: (spec: string | undefined) => string;
  startHost?: (opts: ServerOptions) => Promise<LanServer>;
  createClient?: (opts: ClientOptions) => LanClient;
  scan?: () => Promise<FoundRoom[]>;
  /** Remember the display name for next time. */
  saveName?: (name: string) => void;
  /** Persist a finished match for the local player. */
  recordMatch?: (rec: MatchRecord) => void;
  agentLine?: (width: number) => string;
}

type Screen =
  | { kind: 'setup'; focus: number }
  | { kind: 'connecting'; label: string }
  | { kind: 'room' }
  | { kind: 'closed'; reason: string };

type Overlay =
  | { kind: 'none' }
  | { kind: 'menu'; sel: number }
  | { kind: 'chat'; field: TextField }
  | { kind: 'options'; sel: number }
  | { kind: 'confirm'; text: string; action: () => void };

export class LanScreen {
  private screen: Screen;
  private overlay: Overlay = { kind: 'none' };
  private readonly nameField: TextField;
  private readonly addrField: TextField;
  private gameIdx = 0;
  private rooms: FoundRoom[] = [];
  private scanning = false;
  private roomSel = 0;
  private server: LanServer | null = null;
  private client: LanClient | null = null;
  private gameUi: MpGameUi | null = null;
  private gameUiMatch = '';
  private memberSel = 0;
  private toast: { text: string; ttl: number; tone: 'bad' | 'info' | 'good' } | null = null;
  private forceUntil = 0;
  private recorded = new Set<string>();
  private anim = 0;
  private finished = false;
  private hostInfo: { addresses: string[]; port: number; discoverable: boolean } | null = null;

  constructor(private readonly start: LanStart, private readonly deps: LanDeps) {
    this.nameField = new TextField(start.name ?? deps.defaultName, 16);
    this.addrField = new TextField(start.mode === 'join' && start.host ? `${start.host}${start.port && start.port !== DEFAULT_PORT ? `:${start.port}` : ''}` : '', 60);
    const choices = this.gameChoices();
    if (start.mode === 'host') {
      const want = start.party ? RANDOM_GAME : start.gameId;
      const i = choices.findIndex((g) => g.id === want);
      this.gameIdx = i >= 0 ? i : 0;
    }
    this.screen = { kind: 'setup', focus: start.mode === 'join' && start.host ? 1 : 0 };
    if (start.immediate) {
      if (start.mode === 'host') void this.openHost();
      else if (start.host) void this.joinAddress(this.addrField.value);
    }
    if (start.mode === 'join' && !start.immediate) this.rescan();
  }

  /** True once the player has left LAN mode (back to the arcade menu). */
  get done(): boolean {
    return this.finished;
  }

  /** For tests. */
  get lanClient(): LanClient | null {
    return this.client;
  }

  get lanServer(): LanServer | null {
    return this.server;
  }

  get screenKind(): Screen['kind'] {
    return this.screen.kind;
  }

  private gameChoices(): Array<{ id: string; name: string; label: string }> {
    return [
      ...MP_GAMES.map((g) => ({ id: g.id, name: g.name, label: `${g.kind === 'versus' ? 'versus' : 'party'}, ${g.playersLabel}` })),
      { id: RANDOM_GAME, name: 'Party Mix', label: 'random game each match' },
    ];
  }

  private say(text: string, tone: 'bad' | 'info' | 'good' = 'info', ms = 4000): void {
    this.toast = { text, ttl: ms, tone };
  }

  /* ------------------------------------------------------- lifecycle */

  private name(): string {
    const n = cleanName(this.nameField.value, '');
    return n || this.deps.defaultName;
  }

  private async openHost(): Promise<void> {
    const s = this.start;
    if (s.mode !== 'host') return;
    const name = this.name();
    this.deps.saveName?.(name);
    const gameId = this.gameChoices()[this.gameIdx].id;
    this.screen = { kind: 'connecting', label: 'Starting the host...' };
    try {
      const bind = this.deps.resolveBind(s.bind);
      const opts: ServerOptions = {
        bind,
        port: s.port ?? DEFAULT_PORT,
        allowPublic: !!s.allowPublic,
        discovery: true,
        lobby: {
          gameId,
          party: gameId === RANDOM_GAME || !!s.party,
          roomName: `${name}'s room`,
          ...(s.maxPlayers ? { maxPlayers: s.maxPlayers } : {}),
          ...(s.options ? { options: s.options } : {}),
          ...(s.prompts?.length ? { content: { prompts: s.prompts } } : {}),
        },
      };
      this.server = await (this.deps.startHost ?? defaultStartHost)(opts);
      if (this.finished) { void this.server.close(); return; }
      const addresses = this.server.address === '0.0.0.0' ? lanInterfaces().map((i) => i.address) : [this.server.address];
      this.hostInfo = { addresses: addresses.length ? addresses : ['127.0.0.1'], port: this.server.port, discoverable: this.server.discoverable };
      const connectTo = this.server.address === '0.0.0.0' ? '127.0.0.1' : this.server.address;
      await this.connect({ host: connectTo, port: this.server.port, name, hostKey: this.server.hostKey, ...(s.spectate ? { spectate: true } : {}) });
    } catch (e) {
      void this.server?.close();
      this.server = null;
      this.screen = { kind: 'closed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async joinAddress(text: string): Promise<void> {
    const t = parseHostPort(text, DEFAULT_PORT);
    if ('error' in t) {
      this.say(t.error, 'bad');
      return;
    }
    const name = this.name();
    this.deps.saveName?.(name);
    this.screen = { kind: 'connecting', label: `Connecting to ${t.host}:${t.port}...` };
    try {
      await this.connect({ host: t.host, port: t.port, name, ...(this.start.mode === 'join' && this.start.spectate ? { spectate: true } : {}) });
    } catch (e) {
      this.screen = { kind: 'closed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async connect(opts: ClientOptions): Promise<void> {
    const client = (this.deps.createClient ?? ((o) => new LanClient(o)))(opts);
    this.client = client;
    client.on('notice', (t: string) => this.say(t, 'info'));
    client.on('ack', (a: { ok: boolean; code?: string; message?: string }) => {
      if (a.ok) return;
      if (a.code === 'NOT_READY') this.forceUntil = this.anim + 5000;
      this.say(a.message ?? 'Not allowed.', 'bad');
    });
    client.on('view', (v: { matchId: string; gameId: string; view: unknown }) => this.onView(v));
    client.on('event', (e: { matchId: string; data: unknown }) => {
      if (this.gameUi && e.matchId === this.gameUiMatch) this.gameUi.onEvent(e.data);
    });
    client.on('lobby', (s: LobbyState) => this.onLobby(s));
    client.on('closed', (reason: string) => {
      if (this.client !== client) return;
      if (this.finished) return;
      this.gameUi = null;
      // The host process loses its lobby along with its own connection.
      void this.server?.close(reason);
      this.screen = { kind: 'closed', reason };
      this.overlay = { kind: 'none' };
    });
    await client.connect();
    if (this.finished) { client.close(); return; }
    this.screen = { kind: 'room' };
  }

  private onView(v: { matchId: string; gameId: string; view: unknown }): void {
    if (!this.gameUi || this.gameUiMatch !== v.matchId) {
      this.gameUi = createGameUi(v.gameId, {
        you: () => this.client?.playerId ?? null,
        send: (action) => { this.client?.sendAction(action); },
        serverNow: () => this.client?.serverNow() ?? Date.now(),
        isHost: () => !!this.client?.isHost,
        anim: () => this.anim,
      });
      this.gameUiMatch = v.matchId;
    }
    this.gameUi?.setView(v.view);
  }

  private onLobby(s: LobbyState): void {
    if (s.phase === 'lobby' || s.phase === 'intro') {
      if (this.overlay.kind === 'options' && s.phase === 'intro') this.overlay = { kind: 'none' };
    }
    if (s.phase === 'results' && s.results && !this.recorded.has(s.results.matchId)) {
      this.recorded.add(s.results.matchId);
      const you = this.client?.playerId;
      const st = s.results.standings.find((x) => x.playerId === you);
      if (st && !s.results.incomplete) {
        this.deps.recordMatch?.({
          gameId: s.results.gameId,
          matchId: s.results.matchId,
          rank: st.rank,
          players: s.results.standings.length,
          won: st.rank === 1,
          stats: s.results.stats?.[st.playerId] ?? {},
        });
      }
    }
    if (this.memberSel >= s.members.length) this.memberSel = Math.max(0, s.members.length - 1);
  }

  /** Leave LAN mode: leave/close the lobby, back to the arcade menu. */
  exit(): void {
    if (this.finished) return;
    this.finished = true;
    this.client?.leave();
    if (this.server) {
      const srv = this.server;
      // Give the goodbye a moment to reach other players.
      setTimeout(() => void srv.close('The host closed the lobby.'), 100).unref?.();
    }
  }

  /** Immediate teardown (process exit). Idempotent. */
  dispose(): void {
    this.finished = true;
    this.client?.close();
    void this.server?.close('The host quit C-Cade.');
  }

  /* ------------------------------------------------------------ input */

  tick(dt: number): void {
    this.anim += dt;
    if (this.toast) {
      this.toast.ttl -= dt;
      if (this.toast.ttl <= 0) this.toast = null;
    }
    this.gameUi?.tick(dt);
  }

  onKey(key: Key): void {
    if (this.finished) return;
    switch (this.screen.kind) {
      case 'setup': return this.setupKey(this.screen, key);
      case 'connecting':
        if (key.name === 'escape') this.exit();
        return;
      case 'closed':
        if (key.name === 'enter' || key.name === 'escape' || lower(key) === 'q') this.exit();
        else if (lower(key) === 'r' && this.start.mode === 'join') {
          this.client = null;
          this.screen = { kind: 'setup', focus: 1 };
        }
        return;
      case 'room': return this.roomKey(key);
    }
  }

  private setupKey(s: Extract<Screen, { kind: 'setup' }>, key: Key): void {
    const isHost = this.start.mode === 'host';
    const fields = isHost ? 2 : 3;
    if (key.name === 'escape') return this.exit();
    if (key.name === 'tab') { s.focus = (s.focus + 1) % fields; return; }
    if (key.name === 'down') {
      if (s.focus === 2) this.roomSel = Math.min(Math.max(0, this.rooms.length - 1), this.roomSel + 1);
      else s.focus = Math.min(fields - 1, s.focus + 1);
      return;
    }
    if (key.name === 'up') {
      if (s.focus === 2 && this.roomSel > 0) this.roomSel--;
      else s.focus = Math.max(0, s.focus - 1);
      return;
    }
    if (key.name === 'enter') {
      if (isHost) { void this.openHost(); return; }
      if (s.focus === 2 && this.rooms[this.roomSel]) {
        const r = this.rooms[this.roomSel];
        void this.joinAddress(`${r.connectTo.includes(':') ? `[${r.connectTo}]` : r.connectTo}:${r.port}`);
        return;
      }
      void this.joinAddress(this.addrField.value);
      return;
    }
    if (s.focus === 0) { this.nameField.onKey(key); return; }
    if (isHost && s.focus === 1) {
      const n = this.gameChoices().length;
      if (key.name === 'left') this.gameIdx = (this.gameIdx + n - 1) % n;
      else if (key.name === 'right' || key.name === 'space') this.gameIdx = (this.gameIdx + 1) % n;
      return;
    }
    if (!isHost && s.focus === 1) { this.addrField.onKey(key); return; }
    if (!isHost && s.focus === 2 && lower(key) === 'r') this.rescan();
  }

  private rescan(): void {
    if (this.scanning) return;
    this.scanning = true;
    (this.deps.scan ?? (() => scanRooms()))().then(
      (rooms) => { this.rooms = rooms; this.roomSel = 0; this.scanning = false; },
      () => { this.scanning = false; },
    );
  }

  private roomKey(key: Key): void {
    const client = this.client;
    const lobby = client?.lobby;
    if (!client || !lobby) return;
    const o = this.overlay;
    if (o.kind === 'menu') return this.menuKey(o, key);
    if (o.kind === 'confirm') {
      if (lower(key) === 'y' || key.name === 'enter') { this.overlay = { kind: 'none' }; o.action(); }
      else this.overlay = { kind: 'none' };
      return;
    }
    if (o.kind === 'chat') {
      if (key.name === 'escape') { this.overlay = { kind: 'none' }; return; }
      if (key.name === 'enter') {
        if (o.field.value.trim()) client.sendChat(o.field.value);
        this.overlay = { kind: 'none' };
        return;
      }
      o.field.onKey(key);
      return;
    }
    if (o.kind === 'options') return this.optionsKey(o, key, lobby);

    const ch = lower(key);
    const inGame = lobby.phase === 'match' || lobby.phase === 'results';
    if (key.name === 'escape') {
      // A game UI may use Esc to cancel its own input first.
      if (inGame && this.gameUi?.capturing() && this.gameUi.onKey(key)) return;
      this.overlay = { kind: 'menu', sel: 0 };
      return;
    }
    if (lobby.phase === 'match') {
      this.gameUi?.onKey(key);
      return;
    }
    if (lobby.phase === 'results') {
      if (client.isHost) {
        if (ch === 'r') { client.sendHost({ cmd: 'rematch' }); return; }
        if (ch === 'n' && lobby.party) { client.sendHost({ cmd: 'next' }); return; }
        if (ch === 'l') { client.sendHost({ cmd: 'lobby' }); return; }
      }
      if (ch === 't') { this.overlay = { kind: 'chat', field: new TextField('', 120) }; return; }
      this.gameUi?.onKey(key);
      return;
    }
    if (lobby.phase === 'intro') {
      if (client.isHost && ch === 'c') client.sendHost({ cmd: 'end' });
      return;
    }
    // Lobby.
    const me = lobby.members.find((m) => m.id === client.playerId);
    if (key.name === 'up') { this.memberSel = Math.max(0, this.memberSel - 1); return; }
    if (key.name === 'down') { this.memberSel = Math.min(lobby.members.length - 1, this.memberSel + 1); return; }
    if (ch === 't' || key.name === 'tab') { this.overlay = { kind: 'chat', field: new TextField('', 120) }; return; }
    if (ch === 'r') { client.setReady(!me?.ready); return; }
    if (ch === 'v') { client.setSpectate(!me?.spectator); return; }
    if (!client.isHost) return;
    const ids = [...lobby.games.map((g) => g.id), RANDOM_GAME];
    if (ch === 'g' || key.name === 'right' || key.name === 'left') {
      const i = Math.max(0, ids.indexOf(lobby.gameId));
      const next = ids[(i + (key.name === 'left' ? ids.length - 1 : 1)) % ids.length];
      client.sendHost({ cmd: 'select-game', gameId: next });
      return;
    }
    if (ch === 'o') {
      if (lobby.gameId === RANDOM_GAME) this.say('Pick a specific game (G) to change its options.', 'info');
      else this.overlay = { kind: 'options', sel: 0 };
      return;
    }
    if (ch === '+' || ch === '=') { client.sendHost({ cmd: 'set-max', max: lobby.maxPlayers + 1 }); return; }
    if (ch === '-' || ch === '_') { client.sendHost({ cmd: 'set-max', max: lobby.maxPlayers - 1 }); return; }
    if (ch === 's' || key.name === 'enter') {
      client.sendHost({ cmd: 'start', force: this.anim < this.forceUntil });
      return;
    }
    if (ch === 'k') {
      const target = lobby.members[this.memberSel];
      if (!target || target.id === client.playerId) { this.say('Select another player (Up/Down) to kick.', 'info'); return; }
      this.overlay = { kind: 'confirm', text: `Kick ${target.name}? (Y/N)`, action: () => client.sendHost({ cmd: 'kick', playerId: target.id }) };
    }
  }

  private menuItems(): Array<{ label: string; run: () => void }> {
    const client = this.client!;
    const lobby = client.lobby!;
    const items: Array<{ label: string; run: () => void }> = [{ label: 'Resume', run: () => { /* close menu */ } }];
    if (client.isHost) {
      if (lobby.phase === 'match') items.push({ label: 'End match (no winner)', run: () => client.sendHost({ cmd: 'end' }) });
      if (lobby.phase === 'match' || lobby.phase === 'results') items.push({ label: 'Everyone back to the lobby', run: () => client.sendHost({ cmd: 'lobby' }) });
      items.push({ label: 'Close lobby (disconnects everyone)', run: () => this.exit() });
    } else {
      items.push({ label: lobby.phase === 'match' ? 'Leave match (you may forfeit)' : 'Leave lobby', run: () => this.exit() });
    }
    return items;
  }

  private menuKey(o: Extract<Overlay, { kind: 'menu' }>, key: Key): void {
    const items = this.menuItems();
    if (key.name === 'escape') { this.overlay = { kind: 'none' }; return; }
    if (key.name === 'up') { o.sel = (o.sel + items.length - 1) % items.length; return; }
    if (key.name === 'down' || key.name === 'tab') { o.sel = (o.sel + 1) % items.length; return; }
    if (key.name === 'enter' || key.name === 'space') {
      this.overlay = { kind: 'none' };
      items[o.sel]?.run();
    }
  }

  private optionsKey(o: Extract<Overlay, { kind: 'options' }>, key: Key, lobby: LobbyState): void {
    const g = lobby.games.find((x) => x.id === lobby.gameId);
    if (!g || key.name === 'escape' || key.name === 'enter' || lower(key) === 'o') { this.overlay = { kind: 'none' }; return; }
    const n = g.options.length;
    if (key.name === 'up') { o.sel = (o.sel + n - 1) % n; return; }
    if (key.name === 'down' || key.name === 'tab') { o.sel = (o.sel + 1) % n; return; }
    if (key.name === 'left' || key.name === 'right' || key.name === 'space') {
      const spec = g.options[o.sel];
      const cur = lobby.options[spec.key];
      const i = Math.max(0, spec.values.findIndex((v) => v === cur));
      const next = spec.values[(i + (key.name === 'left' ? spec.values.length - 1 : 1)) % spec.values.length];
      this.client!.sendHost({ cmd: 'set-option', key: spec.key, value: next });
    }
  }

  /* ----------------------------------------------------------- render */

  render(columns: number, rows: number): string[] {
    const width = Math.min(columns - 2, 100);
    let body: string[];
    let hints: Array<[string, string]> = [];
    switch (this.screen.kind) {
      case 'setup': [body, hints] = this.renderSetup(this.screen); break;
      case 'connecting':
        body = ['', theme.primary(c.bold(this.screen.label)) + ' ' + theme.muted(['|', '/', '-', '\\'][Math.floor(this.anim / 150) % 4])];
        hints = [['Esc', 'cancel']];
        break;
      case 'closed':
        body = this.renderClosed(this.screen, width);
        hints = [['Enter', 'back to menu']];
        if (this.start.mode === 'join') hints.push(['R', 'try again']);
        break;
      case 'room': [body, hints] = this.renderRoom(width, rows - 6); break;
    }
    const header = this.header(width);
    const toast = this.toast ? (this.toast.tone === 'bad' ? theme.bad : this.toast.tone === 'good' ? theme.good : theme.gold)(this.toast.text) : '';
    const out = [header, rule(width, this.anim)];
    const room = Math.max(4, rows - 6);
    out.push(...body.slice(0, room));
    out.push(rule(width, this.anim));
    const hintLine = fitHints(hints, width);
    out.push(toast || hintLine);
    if (toast && rows >= 20) out.push(hintLine);
    const ai = this.deps.agentLine?.(width);
    if (ai) out.push(ai);
    return centerVertically(centerBlock(out, columns), rows);
  }

  private header(width: number): string {
    const left = theme.accent(c.bold('C-CADE')) + theme.muted(' > ') + theme.primary(c.bold('LAN'));
    const client = this.client;
    const lobby = client?.lobby;
    if (!lobby || this.screen.kind !== 'room') {
      return spread(left + theme.muted(this.start.mode === 'host' ? ' > HOST' : ' > JOIN'), theme.muted('local network only'), width);
    }
    const status = client!.status === 'online' ? theme.good('● online') : client!.status === 'reconnecting' ? theme.gold(c.bold('● reconnecting...')) : theme.bad('● offline');
    const room = theme.muted(' > room ') + theme.gold(c.bold(lobby.code));
    const players = lobby.members.filter((m) => !m.spectator).length;
    return spread(left + room, theme.muted(`${players}/${lobby.maxPlayers} players  `) + status, width);
  }

  private renderSetup(s: Extract<Screen, { kind: 'setup' }>): [string[], Array<[string, string]>] {
    const isHost = this.start.mode === 'host';
    const blink = Math.floor(this.anim / 500) % 2 === 0;
    const label = (i: number, text: string) => (s.focus === i ? theme.primary('> ') + c.bold(text) : '  ' + theme.muted(text));
    const lines: string[] = [theme.title(isHost ? 'HOST A LAN GAME' : 'JOIN A LAN GAME'), ''];
    lines.push(padRight(label(0, 'Your name'), 14) + this.nameField.render(30, s.focus === 0, blink));
    if (isHost) {
      const g = this.gameChoices()[this.gameIdx];
      lines.push(padRight(label(1, 'Game'), 14) + theme.muted('< ') + c.bold(theme.primary(g.name)) + theme.muted(' >  ') + theme.muted(g.label));
      const def = MP_GAMES.find((x) => x.id === g.id);
      lines.push(' '.repeat(14) + theme.muted(def ? def.tagline : 'Battleship, Prompt Panic and Doodle Protocol, picked at random.'));
      lines.push('');
      const ifs = lanInterfaces();
      const addr = this.start.bind ? this.deps.resolveBind(this.start.bind) : ifs[0]?.address ?? '127.0.0.1';
      lines.push(padRight('  ' + theme.muted('Address'), 14) + c.bold(addr) + theme.muted(`  port ${this.start.port ?? DEFAULT_PORT}`) + (ifs[0] && !this.start.bind ? theme.muted(`  (${ifs[0].name})`) : ''));
      if (addr === '127.0.0.1') lines.push(' '.repeat(14) + theme.gold('No LAN connection found: only this computer can join.'));
      lines.push('');
      lines.push(theme.muted('Friends join with "c-cade join <address>" or [J] in their menu.'));
      lines.push(theme.muted('If your firewall asks, allow Node.js on PRIVATE networks only.'));
      return [lines, [['Up/Down', 'field'], ['Left/Right', 'game'], ['Enter', 'open lobby'], ['Esc', 'back']]];
    }
    lines.push(padRight(label(1, 'Host address'), 14) + this.addrField.render(30, s.focus === 1, blink) + (s.focus === 1 && !this.addrField.value ? theme.muted('  e.g. 192.168.1.42 or 192.168.1.42:7777') : ''));
    lines.push('');
    lines.push(label(2, 'Rooms on your network') + theme.muted(this.scanning ? '  scanning...' : `  ${this.rooms.length} found`));
    if (!this.rooms.length && !this.scanning) {
      lines.push(theme.muted('    None found. Broadcast discovery is often blocked on guest/office Wi-Fi;'));
      lines.push(theme.muted('    type the host\'s address instead (it is shown on their screen).'));
    }
    this.rooms.slice(0, 8).forEach((r, i) => {
      const sel = s.focus === 2 && i === this.roomSel;
      const text = `${padRight(r.name, 20)} ${padRight(r.game, 16)} ${r.players}/${r.max}  ${r.connectTo}:${r.port}` + (r.joinable ? '' : '  (full)') + (r.protocol !== PROTOCOL_VERSION ? '  (other version)' : '');
      lines.push((sel ? theme.primary('  > ') + c.inverse(text) : '    ' + (r.joinable ? text : theme.muted(text))));
    });
    return [lines, [['Up/Down', 'field'], ['Enter', 'join'], ['R', 'rescan (rooms list)'], ['Esc', 'back']]];
  }

  private renderClosed(s: Extract<Screen, { kind: 'closed' }>, width: number): string[] {
    const lines = ['', theme.title('DISCONNECTED'), ''];
    for (const l of wrap(s.reason, Math.min(width, 70))) lines.push(theme.text(l));
    lines.push('');
    if (/firewall|Timed out|Nothing is accepting/.test(s.reason)) {
      lines.push(theme.muted('Checklist: same network? host shows "LAN" lobby? port right? host firewall'));
      lines.push(theme.muted('allows Node.js on private networks? Try: c-cade rooms'));
    }
    return lines;
  }

  private renderRoom(width: number, height: number): [string[], Array<[string, string]>] {
    const client = this.client!;
    const lobby = client.lobby;
    if (!lobby) return [[theme.muted('Joining...')], []];
    let lines: string[];
    let hints: Array<[string, string]>;
    switch (lobby.phase) {
      case 'lobby': [lines, hints] = this.renderLobby(lobby, width, height); break;
      case 'intro': [lines, hints] = this.renderIntro(lobby, width); break;
      case 'match':
        lines = this.gameUi?.render(width, height) ?? [theme.muted('Loading the match...')];
        hints = [...(this.gameUi?.hints() ?? []), ['Esc', 'menu']];
        break;
      case 'results': [lines, hints] = this.renderResults(lobby, width, height); break;
    }
    const o = this.overlay;
    if (o.kind === 'menu') {
      const items = this.menuItems();
      lines = ['', theme.title('MENU'), '', ...items.map((it, i) => (i === o.sel ? theme.primary('> ') + c.inverse(c.bold(` ${it.label} `)) : `   ${it.label}`)), ''];
      hints = [['Up/Down', 'select'], ['Enter', 'choose'], ['Esc', 'resume']];
    } else if (o.kind === 'chat') {
      lines = [...lines.slice(0, Math.max(0, height - 2)), theme.muted('Say: ') + o.field.render(Math.min(width - 6, 80), true, Math.floor(this.anim / 500) % 2 === 0)];
      hints = [['Enter', 'send'], ['Esc', 'cancel']];
    } else if (o.kind === 'confirm') {
      lines = [...lines.slice(0, Math.max(0, height - 2)), theme.gold(c.bold(o.text))];
      hints = [['Y', 'yes'], ['N', 'no']];
    }
    return [lines, hints];
  }

  private renderLobby(lobby: LobbyState, width: number, height: number): [string[], Array<[string, string]>] {
    const client = this.client!;
    const lines: string[] = [];
    const host = client.isHost;
    const where = this.hostInfo
      ? this.hostInfo.addresses.map((a) => `${a}${this.hostInfo!.port !== DEFAULT_PORT ? ` --port ${this.hostInfo!.port}` : ''}`).join('  or  ')
      : `${lobby.address}${lobby.port !== DEFAULT_PORT ? ` --port ${lobby.port}` : ''}`;
    lines.push(theme.title(lobby.roomName.toUpperCase()) + theme.muted('   code ') + theme.gold(c.bold(lobby.code)));
    lines.push(theme.muted('Join: ') + theme.primary(`c-cade join ${where}`) + (this.hostInfo && !this.hostInfo.discoverable ? theme.muted('  (discovery off)') : ''));
    lines.push('');

    const g = lobby.games.find((x) => x.id === lobby.gameId);
    const gameName = g ? g.name : 'Party Mix (random each match)';
    lines.push(theme.muted('GAME     ') + (host ? theme.muted('< ') : '') + theme.primary(c.bold(gameName)) + (host ? theme.muted(' >') : '') + theme.muted('  ' + (g ? `${g.kind}, ${g.playersLabel}` : 'Battleship / Prompt Panic / Doodle Protocol')));
    if (g) {
      lines.push(theme.muted('         ' + g.tagline));
      // Pack "label value" pairs into as few lines as fit.
      const parts = g.options.map((o) => `${o.label.toLowerCase()} ${optionLabel(lobby.options[o.key], o.unit)}`);
      let row = '';
      let first = true;
      for (const part of parts) {
        if (row && 9 + row.length + 3 + part.length > width) {
          lines.push((first ? theme.muted('OPTIONS  ') : '         ') + row);
          first = false;
          row = part;
        } else row = row ? `${row} · ${part}` : part;
      }
      if (row) lines.push((first ? theme.muted('OPTIONS  ') : '         ') + row);
    }
    if (lobby.notice) lines.push(theme.gold(lobby.notice));
    lines.push('');

    const players = lobby.members.filter((m) => !m.spectator).length;
    lines.push(theme.muted(`PLAYERS ${players}/${lobby.maxPlayers}`) + (host ? theme.muted('  (+/- to change)') : ''));
    const now = client.serverNow();
    lobby.members.forEach((m, i) => {
      const sel = host && i === this.memberSel;
      const me = m.id === client.playerId;
      const name = padRight((m.host ? theme.gold('★ ') : '  ') + (me ? theme.primary(c.bold(m.name)) : m.name) + (me ? theme.muted(' (you)') : ''), 26);
      const role = padRight(m.spectator ? theme.muted('spectator') : m.ready ? theme.good('READY') : theme.muted('not ready'), 12);
      const conn = m.connected ? '' : theme.gold(`reconnecting${m.dropAt ? ` ${countdown(m.dropAt, now)}` : ''}`);
      lines.push((sel ? theme.primary('> ') : '  ') + name + role + conn);
    });

    if (lobby.partyScores.length) {
      lines.push('');
      lines.push(theme.muted('PARTY STANDINGS'));
      lines.push(...lobby.partyScores.slice(0, 4).map((p, i) => theme.muted(`${i + 1}. `) + padRight(p.name, 18) + theme.gold(`${p.points} pts`) + theme.muted(`  ${p.wins} win${p.wins === 1 ? '' : 's'}`)));
    }

    // Chat fills what is left.
    const chatRoom = height - lines.length - 3;
    if (chatRoom >= 2) {
      lines.push('');
      lines.push(theme.muted('CHAT'));
      lines.push(...client.chat.slice(-(chatRoom - 1)).map((l) => chatLine(l, width)));
    }

    if (this.overlay.kind === 'options' && g) {
      const sel = this.overlay.sel;
      lines.splice(4, lines.length, '', theme.title(`${g.name.toUpperCase()} OPTIONS`), '',
        ...g.options.map((o, i) => (i === sel ? theme.primary('> ') : '  ') + padRight(o.label, 22) + (i === sel ? c.inverse(` ${optionLabel(lobby.options[o.key], o.unit)} `) : optionLabel(lobby.options[o.key], o.unit))));
      return [lines, [['Up/Down', 'option'], ['Left/Right', 'change'], ['Enter', 'done']]];
    }

    const hints: Array<[string, string]> = host
      ? [['S', 'start'], ['G', 'game'], ['O', 'options'], ['K', 'kick'], ['T', 'chat'], ['V', 'spectate'], ['Esc', 'menu']]
      : [['R', 'ready'], ['T', 'chat'], ['V', 'spectate'], ['Esc', 'leave']];
    return [lines, hints];
  }

  private renderIntro(lobby: LobbyState, width: number): [string[], Array<[string, string]>] {
    const g = lobby.games.find((x) => x.id === lobby.activeGameId);
    const secs = lobby.introEndsAt ? Math.max(0, Math.ceil((lobby.introEndsAt - this.client!.serverNow()) / 1000)) : 0;
    const lines = ['', theme.muted(lobby.gameId === RANDOM_GAME ? 'THE WHEEL HAS SPOKEN. NEXT GAME:' : 'GET READY'), '', theme.title(`>> ${(g?.name ?? '').toUpperCase()} <<`), theme.muted(g?.tagline ?? ''), ''];
    for (const r of g?.rules ?? []) lines.push(...wrap(r, Math.min(width, 76)).map((l) => '  ' + l));
    const playing = lobby.members.filter((m) => m.playing).map((m) => m.name);
    lines.push('', theme.muted('Players: ') + playing.join(', '));
    const me = lobby.members.find((m) => m.id === this.client!.playerId);
    if (me && !me.playing) lines.push(theme.gold('You are spectating this one.'));
    lines.push('', theme.primary(c.bold(`Starting in ${secs}...`)));
    return [lines, this.client!.isHost ? [['C', 'cancel'], ['Esc', 'menu']] : [['Esc', 'menu']]];
  }

  private renderResults(lobby: LobbyState, width: number, height: number): [string[], Array<[string, string]>] {
    const res = lobby.results!;
    const you = this.client!.playerId;
    const board = res.standings.map((s: Standing) => ({ id: s.playerId, name: `${s.rank === 1 ? '★ ' : ''}${s.name}`, score: s.score }));
    const summary: string[] = [
      theme.title('RESULTS') + '  ' + theme.gold(c.bold(res.headline)),
      ...(res.gameId === 'battleship' ? [] : scoreboard(board, you, 40, 4)),
    ];
    const gameLines = this.gameUi?.render(width, Math.max(6, height - summary.length - 1)) ?? [];
    const lines = [...summary, ...gameLines];
    const hints: Array<[string, string]> = this.client!.isHost
      ? [['R', 'rematch'], ...(lobby.party ? [['N', 'next random game'] as [string, string]] : []), ['L', 'lobby'], ['T', 'chat'], ['Esc', 'menu']]
      : [['T', 'chat'], ['Esc', 'menu']];
    if (!this.client!.isHost) lines.push(theme.muted('Waiting for the host: rematch or back to the lobby.'));
    return [lines, hints];
  }
}

/** Key hints that fit on one line: drop from the end, but always keep Esc. */
function fitHints(hints: Array<[string, string]>, width: number): string {
  const list = [...hints];
  while (list.length > 1 && visibleWidth(keyHint(list)) > width) {
    const esc = list.findIndex((h) => h[0] === 'Esc');
    list.splice(esc === list.length - 1 ? list.length - 2 : list.length - 1, 1);
  }
  return keyHint(list);
}

function chatLine(l: ChatLine, width: number): string {
  return truncate(l.system ? theme.muted(`* ${l.text}`) : theme.primary(l.name) + theme.muted(': ') + l.text, width);
}

async function defaultStartHost(opts: ServerOptions): Promise<LanServer> {
  const s = new LanServer(opts);
  await s.start();
  return s;
}

