import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  LineDecoder, MAX_MESSAGE_BYTES, decodeServer, encodeClient,
  type ChatLine, type ClientMessage, type HostCommand, type LobbyState, type ServerMessage,
} from './protocol.js';
import { scrubDeep } from './sanitize.js';

/**
 * LAN client. Connects, joins, keeps the connection alive and transparently
 * reconnects (resuming the same seat with its token) when the network
 * blips. Unacknowledged actions are re-sent after a reconnect; the server
 * ignores ones it already applied, so nothing is applied twice.
 *
 * All strings from the server are scrubbed of control characters before
 * anything sees them, so even a modified host cannot inject terminal
 * escape sequences.
 *
 * Events: 'status' (ClientStatus), 'lobby' (LobbyState), 'view' (CurrentView),
 * 'event' ({matchId, data}), 'ack' (ack message), 'chat' (ChatLine),
 * 'notice' (string), 'closed' (reason string).
 */

type ClientStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface ClientOptions {
  host: string;
  port: number;
  name: string;
  hostKey?: string;
  spectate?: boolean;
  /** Keep trying to reconnect for this long after a drop (0 disables). */
  reconnectWindowMs?: number;
  connectTimeoutMs?: number;
  /** No traffic from the server for this long = dead connection. */
  idleTimeoutMs?: number;
}

export interface CurrentView {
  matchId: string;
  gameId: string;
  view: unknown;
}

export class LanClient extends EventEmitter {
  status: ClientStatus = 'connecting';
  playerId: string | null = null;
  token: string | null = null;
  isHost = false;
  lobby: LobbyState | null = null;
  view: CurrentView | null = null;
  chat: ChatLine[] = [];
  closedReason: string | null = null;
  lastError: string | null = null;

  private socket: net.Socket | null = null;
  private seq = 0;
  private lastServerSeq = 0;
  private readonly pending = new Map<number, ClientMessage>();
  private serverOffset = 0;
  private lastRx = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private dropAt = 0;
  private attempt = 0;
  private finished = false;
  private intentional = false;
  private readonly opts: Required<Omit<ClientOptions, 'hostKey' | 'spectate'>> & Pick<ClientOptions, 'hostKey' | 'spectate'>;

  constructor(opts: ClientOptions) {
    super();
    this.opts = { reconnectWindowMs: 60_000, connectTimeoutMs: 6000, idleTimeoutMs: 20_000, ...opts };
  }

  /** Resolves once joined; rejects with a human-readable error if the first attempt fails. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onWelcome = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
      const onClosed = (reason: string) => { if (!settled) { settled = true; cleanup(); reject(new Error(reason)); } };
      const cleanup = () => {
        this.off('welcome', onWelcome);
        this.off('closed', onClosed);
      };
      this.on('welcome', onWelcome);
      this.on('closed', onClosed);
      this.open(true);
    });
  }

  /** Server clock estimate (ms) for deadlines in views. */
  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  private setStatus(s: ClientStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  private open(first: boolean): void {
    if (this.finished) return;
    const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = sock;
    sock.setNoDelay(true);
    const decoder = new LineDecoder(MAX_MESSAGE_BYTES * 8);
    const connectTimer = setTimeout(() => {
      sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, this.opts.connectTimeoutMs);
    let connected = false;

    sock.on('connect', () => {
      clearTimeout(connectTimer);
      connected = true;
      this.lastRx = Date.now();
      this.write({
        type: 'hello',
        name: this.opts.name,
        client: 'c-cade',
        ...(this.token ? { token: this.token } : {}),
        ...(this.opts.hostKey ? { hostKey: this.opts.hostKey } : {}),
        ...(this.opts.spectate ? { spectate: true } : {}),
      });
      this.startIdleWatch();
    });
    sock.on('data', (chunk: Buffer) => {
      this.lastRx = Date.now();
      for (const line of decoder.push(chunk)) this.onLine(line);
      if (decoder.overflowed) sock.destroy();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      this.lastError = friendlyError(e, this.opts.host, this.opts.port);
    });
    sock.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== sock) return;
      this.socket = null;
      this.stopIdleWatch();
      if (this.finished) return;
      if (this.intentional) return this.finish(this.closedReason ?? 'Disconnected.');
      // A first attempt that never got in fails fast with the reason.
      if (first && !this.playerId) return this.finish(this.lastError ?? (connected ? 'The host closed the connection.' : `Could not connect to ${this.opts.host}:${this.opts.port}.`));
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.opts.reconnectWindowMs <= 0) return this.finish(this.lastError ?? 'Connection lost.');
    const now = Date.now();
    if (this.status !== 'reconnecting') {
      this.dropAt = now;
      this.attempt = 0;
      this.setStatus('reconnecting');
      this.emit('notice', 'Connection lost. Reconnecting...');
    }
    if (now - this.dropAt > this.opts.reconnectWindowMs) {
      return this.finish(`Lost connection to the host${this.lastError ? `: ${this.lastError}` : '.'}`);
    }
    const delay = Math.min(5000, 250 * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => this.open(false), delay);
  }

  private startIdleWatch(): void {
    this.stopIdleWatch();
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastRx > this.opts.idleTimeoutMs) {
        this.lastError = 'The host stopped responding.';
        this.socket?.destroy();
      }
    }, 1000);
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private onLine(line: string): void {
    const d = decodeServer(line);
    if (!d.ok) {
      if (d.code === 'VERSION') {
        this.closedReason = `The host runs a different C-Cade protocol (${d.message}). Update both machines.`;
        this.intentional = true;
        this.socket?.destroy();
      }
      return;
    }
    // Drop anything stale or replayed (server seqs only increase).
    if (d.seq !== undefined) {
      if (d.seq <= this.lastServerSeq) return;
      this.lastServerSeq = d.seq;
    }
    const msg = scrubDeep(d.msg) as ServerMessage;
    this.onMessage(msg);
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        const resumed = msg.resumed;
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.isHost = msg.host;
        this.serverOffset = msg.serverNow - Date.now();
        this.attempt = 0;
        this.setStatus('online');
        if (resumed) {
          this.emit('notice', 'Reconnected.');
          // Re-send anything the server may not have seen; duplicates are acked and ignored.
          for (const m of [...this.pending.values()]) this.write(m);
        } else {
          this.pending.clear();
          this.chat = [];
        }
        this.emit('welcome', resumed);
        break;
      }
      case 'lobby':
        this.lobby = msg.state;
        this.emit('lobby', msg.state);
        break;
      case 'view':
        this.view = { matchId: msg.matchId, gameId: msg.gameId, view: msg.view };
        this.emit('view', this.view);
        break;
      case 'event':
        this.emit('event', { matchId: msg.matchId, data: msg.data });
        break;
      case 'ack':
        this.pending.delete(msg.seq);
        this.emit('ack', msg);
        break;
      case 'chat':
        this.chat.push(msg.line);
        if (this.chat.length > 30) this.chat.shift();
        this.emit('chat', msg.line);
        break;
      case 'error':
        if (msg.code === 'UNKNOWN_SESSION') this.token = null;
        this.emit('notice', msg.message);
        break;
      case 'bye':
        // A goodbye is final: kicked, lobby closed, full... never auto-reconnect after it.
        this.closedReason = msg.reason;
        this.intentional = true;
        break;
      case 'ping':
        this.serverOffset = msg.serverNow - Date.now();
        this.write({ type: 'pong', t: msg.t });
        break;
      case 'pong':
        this.serverOffset = msg.serverNow - Date.now();
        break;
    }
  }

  private write(msg: ClientMessage): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    this.socket.write(encodeClient(msg));
  }

  /* ------------------------------------------------------------ actions */

  /** Send a game action for the current match. Returns its seq. */
  sendAction(action: Record<string, unknown>): number {
    const matchId = this.view?.matchId ?? this.lobby?.matchId;
    if (!matchId) return -1;
    const seq = ++this.seq;
    const msg: ClientMessage = { type: 'action', seq, matchId, action };
    this.pending.set(seq, msg);
    this.write(msg);
    return seq;
  }

  sendHost(command: HostCommand): number {
    const seq = ++this.seq;
    const msg: ClientMessage = { type: 'host', seq, command };
    this.pending.set(seq, msg);
    this.write(msg);
    return seq;
  }

  setReady(ready: boolean): void {
    this.write({ type: 'ready', ready });
  }

  setSpectate(spectate: boolean): void {
    this.write({ type: 'spectate', spectate });
  }

  sendChat(text: string): void {
    this.write({ type: 'chat', text });
  }

  /** Leave the lobby on purpose (frees the seat immediately). */
  leave(): void {
    if (this.finished) return;
    this.intentional = true;
    this.closedReason = 'You left the lobby.';
    this.write({ type: 'leave' });
    const s = this.socket;
    if (s) {
      s.end();
      setTimeout(() => s.destroy(), 300).unref();
    } else {
      this.finish(this.closedReason);
    }
  }

  /** Drop everything without ceremony (process exit). */
  close(): void {
    if (this.finished) return;
    this.intentional = true;
    this.closedReason ??= 'Disconnected.';
    this.socket?.destroy();
    this.finish(this.closedReason);
  }

  private finish(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopIdleWatch();
    this.socket?.destroy();
    this.socket = null;
    this.closedReason = reason;
    this.setStatus('closed');
    this.emit('closed', reason);
  }
}

/** Turn socket errors into something a player can act on. */
function friendlyError(e: NodeJS.ErrnoException, host: string, port: number): string {
  const where = `${host}:${port}`;
  switch (e.code) {
    case 'ECONNREFUSED':
      return `Nothing is accepting connections at ${where}. Is the host running, and is the port right?`;
    case 'ETIMEDOUT':
      return `Timed out reaching ${where}. Same network? The host's firewall may be blocking port ${port}.`;
    case 'EHOSTUNREACH': case 'ENETUNREACH':
      return `Can't reach ${host} from this network. Check you are on the same Wi-Fi/LAN.`;
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return `Unknown host "${host}". Use the IP address shown on the host's screen.`;
    case 'ECONNRESET': case 'EPIPE':
      return `The connection to ${where} was reset.`;
    default:
      return `Network error talking to ${where}: ${e.message}`;
  }
}

