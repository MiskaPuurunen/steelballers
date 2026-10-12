import os from 'node:os';

/**
 * Network exposure policy. By default a host binds to one LAN interface
 * (never 0.0.0.0) and only talks to private, loopback or link-local peers,
 * so a laptop on a public Wi-Fi with a public IP is not an open game server.
 */

function ipv4Parts(addr: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Loopback, RFC 1918, link-local, or IPv6 loopback / link-local / unique-local. */
export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  let addr = raw.toLowerCase();
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct);
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  const v4 = ipv4Parts(addr);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return addr === '::1' || addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd');
}

export function isLoopback(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

export interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
  score: number;
}

// Hypervisor, container and VPN adapters are private too, but usually not where your friends are.
const VIRTUAL = /vethernet|virtual|vbox|vmware|vmnet|docker|wsl|hyper-v|loopback|tailscale|zerotier|utun|tun\d|tap\d|br-|veth|npcap|hamachi/i;

export function broadcastFor(address: string, netmask: string): string {
  const a = ipv4Parts(address);
  const m = ipv4Parts(netmask);
  if (!a || !m) return '255.255.255.255';
  return a.map((p, i) => (p | (~m[i] & 255)) & 255).join('.');
}

/** Private IPv4 interfaces, best guess for "the LAN" first. */
export function lanInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivateAddress(i.address) || i.address.startsWith('169.254.')) continue;
      let score = 0;
      if (i.address.startsWith('192.168.')) score += 3;
      else if (i.address.startsWith('10.')) score += 2;
      else score += 1;
      if (VIRTUAL.test(name)) score -= 10;
      if (/wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i.test(name)) score += 2;
      out.push({ name, address: i.address, netmask: i.netmask, broadcast: broadcastFor(i.address, i.netmask), score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** The address a host binds to by default; loopback when no LAN is found. */
export function defaultBindAddress(ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
  return lanInterfaces(ifaces)[0]?.address ?? '127.0.0.1';
}

/** Interpret --bind: "lan" (default), "local", "all", or a literal address. */
export function resolveBind(spec: string | undefined): string {
  if (!spec || spec === 'lan') return defaultBindAddress();
  if (spec === 'local' || spec === 'localhost') return '127.0.0.1';
  if (spec === 'all' || spec === '*') return '0.0.0.0';
  return spec;
}

/** "host", "host:port", "[v6]:port" -> parts. Port falls back to `defPort`. */
export function parseHostPort(input: string, defPort: number): { host: string; port: number } | { error: string } {
  const s = input.trim();
  if (!s) return { error: 'Enter the host address, e.g. 192.168.1.42 or 192.168.1.42:7777' };
  let host = s;
  let portStr: string | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1];
    portStr = v6[2];
  } else if ((s.match(/:/g) ?? []).length === 1) {
    [host, portStr] = s.split(':');
  }
  if (!/^[A-Za-z0-9.\-:%]{1,253}$/.test(host)) return { error: `"${host}" is not a valid host name or address` };
  const port = portStr === undefined || portStr === '' ? defPort : Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `Invalid port "${portStr}" (1-65535)` };
  return { host, port };
}
