import dgram from 'node:dgram';
import { isObj } from '../mp/types.js';
import { isPrivateAddress, lanInterfaces } from './address.js';
import { PROTOCOL_VERSION, TokenBucket, randomId } from './protocol.js';
import { cleanText } from './sanitize.js';

/**
 * LAN room discovery over UDP broadcast.
 *
 * `c-cade rooms` broadcasts one small probe on the local subnet(s); only
 * machines running a C-Cade host answer, with a short room summary. No
 * port scanning, nothing is sent beyond the local broadcast domain, and
 * nobody else's devices are contacted. Hosts only answer probes from
 * private addresses and rate-limit replies.
 *
 * Broadcast is often blocked (guest Wi-Fi, client isolation, some
 * firewalls), so discovery is a convenience: joining by IP always works.
 */

const DISCOVERY_PORT = 7777;
// Wire identifier from before the C-Cade rename, kept so older builds still find each other.
const MAGIC = 'vibebreak';

interface RoomInfo {
  code: string;
  name: string;
  host: string;
  game: string;
  players: number;
  max: number;
  phase: string;
  joinable: boolean;
  port: number;
  address: string;
}

export interface FoundRoom extends RoomInfo {
  /** Where to connect (the advertised address, or the reply's source). */
  connectTo: string;
  /** Protocol version the host speaks. */
  protocol: number;
}

export class DiscoveryResponder {
  private sock: dgram.Socket | null = null;
  private readonly buckets = new Map<string, TokenBucket>();

  /**
   * `bindAddress`: '0.0.0.0' to hear LAN broadcasts (Linux only delivers
   * them to wildcard sockets), or '127.0.0.1' for a this-computer-only host.
   */
  constructor(private readonly info: () => RoomInfo, private readonly opts: { port?: number; allowPublic: boolean; bindAddress?: string }) {}

  get port(): number {
    return (this.sock?.address() as { port: number } | undefined)?.port ?? 0;
  }

  /** Resolves false if the UDP port cannot be bound (discovery is then just off). */
  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.once('error', () => {
        try { sock.close(); } catch { /* ignore */ }
        resolve(false);
      });
      sock.on('message', (buf, rinfo) => this.onProbe(buf, rinfo));
      sock.bind(this.opts.port ?? DISCOVERY_PORT, this.opts.bindAddress ?? '0.0.0.0', () => {
        sock.removeAllListeners('error');
        sock.on('error', () => { /* keep serving */ });
        this.sock = sock;
        resolve(true);
      });
    });
  }

  private onProbe(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!this.sock || buf.length > 256) return;
    if (!this.opts.allowPublic && !isPrivateAddress(rinfo.address)) return;
    let msg: unknown;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!isObj(msg) || msg.vb !== MAGIC || msg.t !== 'probe' || typeof msg.nonce !== 'string' || msg.nonce.length > 32) return;
    const now = Date.now();
    let b = this.buckets.get(rinfo.address);
    if (!b) {
      if (this.buckets.size > 256) this.buckets.clear();
      this.buckets.set(rinfo.address, (b = new TokenBucket(5, 2, now)));
    }
    if (!b.take(now)) return;
    const reply = JSON.stringify({ vb: MAGIC, t: 'room', v: PROTOCOL_VERSION, nonce: msg.nonce, room: this.info() });
    this.sock.send(reply, rinfo.port, rinfo.address);
  }

  stop(): void {
    try { this.sock?.close(); } catch { /* ignore */ }
    this.sock = null;
  }
}

/** Parse and sanitise a room reply. */
function parseRoomReply(buf: Buffer, nonce: string, from: string): FoundRoom | null {
  if (buf.length > 2048) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(msg) || msg.vb !== MAGIC || msg.t !== 'room' || msg.nonce !== nonce || !isObj(msg.room)) return null;
  const r = msg.room;
  const port = Number(r.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const advertised = typeof r.address === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(r.address) ? r.address : '';
  const connectTo = advertised && advertised !== '0.0.0.0' && advertised !== '::' ? advertised : from;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(99, Math.round(v))) : 0);
  return {
    code: cleanText(r.code, 8),
    name: cleanText(r.name, 24),
    host: cleanText(r.host, 16),
    game: cleanText(r.game, 24),
    players: num(r.players),
    max: num(r.max),
    phase: cleanText(r.phase, 10),
    joinable: r.joinable === true,
    port,
    address: advertised || from,
    connectTo,
    protocol: typeof msg.v === 'number' ? msg.v : 0,
  };
}

interface ScanOptions {
  timeoutMs?: number;
  port?: number;
  /** Extra unicast targets (e.g. 127.0.0.1 for a host on this machine). */
  targets?: string[];
}

/** Broadcast a probe and collect room replies for `timeoutMs`. */
export function scanRooms(opts: ScanOptions = {}): Promise<FoundRoom[]> {
  const port = opts.port ?? DISCOVERY_PORT;
  const nonce = randomId(12);
  const probe = Buffer.from(JSON.stringify({ vb: MAGIC, t: 'probe', v: PROTOCOL_VERSION, nonce }));
  const found = new Map<string, FoundRoom>();
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4' });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };
    sock.on('error', finish);
    sock.on('message', (buf, rinfo) => {
      const room = parseRoomReply(buf, nonce, rinfo.address);
      if (room) found.set(`${room.connectTo}:${room.port}`, room);
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch { /* some platforms refuse; unicast targets still work */ }
      const targets = new Set(['255.255.255.255', ...lanInterfaces().map((i) => i.broadcast), ...(opts.targets ?? [])]);
      for (const t of targets) sock.send(probe, port, t, () => { /* send errors are expected on some interfaces */ });
      // A second probe shortly after, in case the first was dropped.
      setTimeout(() => {
        if (!done) for (const t of targets) sock.send(probe, port, t, () => {});
      }, Math.min(400, (opts.timeoutMs ?? 1500) / 3));
    });
    setTimeout(finish, opts.timeoutMs ?? 1500);
  });
}
