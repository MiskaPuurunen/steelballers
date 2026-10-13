import net from 'node:net';
import { Lobby, type ConnHandle, type LobbyOptions } from './lobby.js';
import {
  DEFAULT_PORT, LineDecoder, TokenBucket, decodeClient, encodeServer, randomId,
  type ByeCode, type ServerMessage,
} from './protocol.js';
import { isLoopback, isPrivateAddress } from './address.js';
import { DiscoveryResponder } from './discovery.js';

/**
 * The LAN host: a TCP server speaking the line-delimited JSON protocol,
 * with one Lobby behind it. Responsibilities kept here (and only here):
 * sockets, framing, size limits, handshake and idle timeouts, heartbeats,
 * flood protection and the private-network policy.
 */

export interface ServerOptions {
  /** Interface to bind (default 127.0.0.1; the CLI passes the LAN address). */
  bind?: string;
  /** Port to listen on; 0 picks a free one. If busy, the next ports are tried. */
  port?: number;
  /** How many successive ports to try when the first is taken. */
  portTries?: number;
  /** Accept peers outside private/loopback ranges (off by default). */
  allowPublic?: boolean;
  /** Respond to LAN discovery probes. */
  discovery?: boolean;
  discoveryPort?: number;
  helloTimeoutMs?: number;
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
  tickMs?: number;
  maxConnections?: number;
  lobby?: Omit<LobbyOptions, 'address' | 'port' | 'hostKey' | 'onCloseRequest'>;
  log?: (line: string) => void;
  /** Called once the server has fully closed (e.g. the host pressed "close lobby"). */
  onClosed?: (reason: string) => void;
}

interface Conn extends ConnHandle {
  socket: net.Socket;
  memberId: string | null;
  lastRx: number;
  bucket: TokenBucket;
  strikes: number;
  lastRateWarn: number;
  closing: boolean;
}

export class LanServer {
  readonly hostKey = randomId(32);
  lobby!: Lobby;
  address = '';
  port = 0;
  private server: net.Server | null = null;
  private readonly conns = new Set<Conn>();
  private timer: NodeJS.Timeout | null = null;
  private discovery: DiscoveryResponder | null = null;
  private closedPromise: Promise<void> | null = null;
  private readonly helloTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private lastPing = 0;

  constructor(private readonly opts: ServerOptions = {}) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 20_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 5000;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  /** Bind and start. Rejects with a friendly message if no port is available. */
  async start(): Promise<{ address: string; port: number }> {
    const bind = this.opts.bind ?? '127.0.0.1';
    const first = this.opts.port ?? DEFAULT_PORT;
    const tries = first === 0 ? 1 : this.opts.portTries ?? 10;
    let lastErr: NodeJS.ErrnoException | null = null;
    for (let i = 0; i < tries; i++) {
      const port = first === 0 ? 0 : first + i;
      try {
        this.server = await listen(bind, port, (s) => this.onSocket(s));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e as NodeJS.ErrnoException;
        if (lastErr.code !== 'EADDRINUSE') break;
      }
    }
    if (!this.server) {
      const e = lastErr!;
      if (e.code === 'EADDRINUSE') throw new Error(`Ports ${first}-${first + tries - 1} are all in use. Try --port <n>.`);
      if (e.code === 'EADDRNOTAVAIL') throw new Error(`Cannot bind to ${bind}: that address is not on this machine. Check --bind.`);
      if (e.code === 'EACCES') throw new Error(`Not allowed to listen on port ${first}. Pick a port above 1024 with --port.`);
      throw new Error(`Could not start the host: ${e.message}`);
    }
    const a = this.server.address() as net.AddressInfo;
    this.address = a.address;
    this.port = a.port;
    this.lobby = new Lobby({
      ...this.opts.lobby,
      address: this.address,
      port: this.port,
      hostKey: this.hostKey,
      onCloseRequest: () => void this.close('The host closed the lobby.'),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    this.schedule(this.opts.tickMs ?? 200);
    if (this.opts.discovery) {
      this.discovery = new DiscoveryResponder(() => ({ ...this.lobby.info(), port: this.port, address: this.address }), {
        port: this.opts.discoveryPort,
        allowPublic: !!this.opts.allowPublic,
        // A loopback-only host stays invisible to the network.
        bindAddress: isLoopback(this.address) ? '127.0.0.1' : '0.0.0.0',
      });
      const ok = await this.discovery.start();
      if (!ok) {
        this.log('LAN discovery unavailable (UDP port busy or blocked); players can still join by address.');
        this.discovery = null;
      }
    }
    this.log(`Listening on ${this.address}:${this.port} (room ${this.lobby.code})`);
    return { address: this.address, port: this.port };
  }

  get discoverable(): boolean {
    return this.discovery !== null;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  private onSocket(socket: net.Socket): void {
    const remote = socket.remoteAddress ?? '';
    if (!this.opts.allowPublic && !isPrivateAddress(remote)) {
      this.log(`Refused ${remote}: not a private/LAN address (use --allow-public to override)`);
      socket.destroy();
      return;
    }
    if (this.closedPromise || !this.lobby || this.lobby.isBanned(remote)) {
      socket.end(encodeServer({ type: 'bye', code: 'banned', reason: this.closedPromise ? 'The lobby is closed.' : 'You were removed from this lobby by the host.' }));
      socket.destroy();
      return;
    }
    if (this.conns.size >= (this.opts.maxConnections ?? 32)) {
      socket.end(encodeServer({ type: 'bye', code: 'full', reason: 'The host has too many connections.' }));
      return;
    }
    socket.setNoDelay(true);
    const now = Date.now();
    const decoder = new LineDecoder();
    const conn: Conn = {
      socket,
      remote,
      memberId: null,
      lastRx: now,
      bucket: new TokenBucket(60, 30, now),
      strikes: 0,
      lastRateWarn: 0,
      closing: false,
      send: (msg: ServerMessage) => this.write(conn, msg),
      close: (code: ByeCode, reason: string) => this.drop(conn, code, reason),
    };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.memberId) this.drop(conn, 'timeout', 'No hello received in time.');
    }, this.helloTimeoutMs);

    socket.on('data', (chunk: Buffer) => {
      conn.lastRx = Date.now();
      for (const line of decoder.push(chunk)) {
        if (conn.closing) return;
        this.onLine(conn, line);
      }
      if (decoder.overflowed) this.drop(conn, 'invalid', 'Message too large.');
    });
    socket.on('error', () => { /* reported via close */ });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      if (conn.memberId) this.lobby.disconnected(conn.memberId, conn);
    });
  }

  private onLine(conn: Conn, line: string): void {
    const now = Date.now();
    if (!conn.bucket.take(now)) {
      conn.strikes++;
      if (conn.strikes > 200) return this.drop(conn, 'flood', 'Too many messages.');
      if (now - conn.lastRateWarn > 1000) {
        conn.lastRateWarn = now;
        this.write(conn, { type: 'error', code: 'RATE_LIMITED', message: 'Slow down: too many messages.' });
      }
      return;
    }
    const d = decodeClient(line);
    if (!d.ok) {
      if (d.code === 'VERSION') return this.drop(conn, 'version', `${d.message}. Update VibeBreak on both machines.`);
      conn.strikes += 10;
      this.write(conn, { type: 'error', code: d.code, message: d.message });
      if (!conn.memberId || conn.strikes > 100) this.drop(conn, 'invalid', 'Invalid messages.');
      return;
    }
    const msg = d.msg;
    if (msg.type === 'ping') return this.write(conn, { type: 'pong', t: msg.t, serverNow: Date.now() });
    if (!conn.memberId) {
      if (msg.type !== 'hello') return this.drop(conn, 'invalid', 'Expected hello first.');
      conn.memberId = this.lobby.hello(conn, msg);
      return;
    }
    this.lobby.handle(conn.memberId, msg);
  }

  private write(conn: Conn, msg: ServerMessage): void {
    if (conn.closing || conn.socket.destroyed) return;
    // A peer that stops reading must not make us buffer without limit.
    if (conn.socket.writableLength > 1024 * 1024) {
      conn.socket.destroy();
      return;
    }
    conn.socket.write(encodeServer(msg, conn.memberId ?? undefined));
  }

  private drop(conn: Conn, code: ByeCode, reason: string): void {
    if (conn.closing) return;
    this.write(conn, { type: 'bye', code, reason });
    conn.closing = true;
    conn.socket.end();
    setTimeout(() => conn.socket.destroy(), 1000).unref();
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastPing >= this.pingIntervalMs) {
      this.lastPing = now;
      for (const c of this.conns) if (c.memberId) this.write(c, { type: 'ping', t: now, serverNow: now });
    }
    for (const c of this.conns) {
      if (now - c.lastRx > this.idleTimeoutMs) {
        this.log(`Connection from ${c.remote} timed out`);
        c.socket.destroy();
      }
    }
    this.lobby.tick();
    // Real-time games (racing) ask for a faster tick while their match runs.
    const base = this.opts.tickMs ?? 200;
    const want = Math.max(16, Math.min(base, this.lobby.desiredTickMs ?? base));
    if (want !== this.tickMs && this.timer) this.schedule(want);
  }

  private tickMs = 0;

  private schedule(ms: number): void {
    if (this.timer) clearInterval(this.timer);
    this.tickMs = ms;
    this.timer = setInterval(() => this.tick(), ms);
  }

  /** Close the lobby and the server. Idempotent; resolves when everything is shut. */
  close(reason = 'The host closed the lobby.'): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    this.closedPromise = new Promise<void>((resolve) => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.discovery?.stop();
      this.discovery = null;
      this.lobby?.close(reason);
      for (const c of this.conns) {
        if (!c.closing) this.drop(c, 'closed', reason);
      }
      const server = this.server;
      const finish = () => {
        for (const c of this.conns) c.socket.destroy();
        this.conns.clear();
        this.log('Host stopped.');
        this.opts.onClosed?.(reason);
        resolve();
      };
      if (!server) return finish();
      // Give goodbyes a moment to flush, then force-close stragglers.
      const force = setTimeout(() => {
        for (const c of this.conns) c.socket.destroy();
      }, 500);
      server.close(() => {
        clearTimeout(force);
        finish();
      });
    });
    return this.closedPromise;
  }
}

function listen(host: string, port: number, onSocket: (s: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onSocket);
    const onError = (e: Error) => {
      server.close();
      reject(e);
    };
    server.once('error', onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', onError);
      server.on('error', () => { /* runtime errors surface per socket */ });
      resolve(server);
    });
  });
}
