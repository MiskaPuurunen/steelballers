#!/usr/bin/env node
/**
 * LAN multiplayer demo: a dedicated host plus bot players, all as separate
 * processes talking over TCP on this machine. Plays one Battleship match
 * (2 players) and one Prompt Panic game (3 players), streaming every log.
 *
 * Usage: npm run build && node scripts/lan-demo.mjs [--port 17777] [--fast]
 *
 * To play yourself instead of watching bots, open three terminals:
 *   1) vibebreak host --game battleship --local
 *   2) vibebreak join 127.0.0.1
 *   (on other computers: vibebreak join <address shown in the lobby>)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist', 'cli', 'index.js');
if (!fs.existsSync(cli)) {
  console.error('Build first: npm run build');
  process.exit(1);
}
const argv = process.argv.slice(2);
const basePort = Number(argv[argv.indexOf('--port') + 1]) || 17777;
const fast = argv.includes('--fast');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibebreak-demo-'));
const colors = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m'];

function run(label, color, args) {
  const p = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, VIBEBREAK_HOME: home, ...(fast ? { VIBEBREAK_BOT_THINK_MS: '50-150' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `${color}${label.padEnd(6)}\x1b[0m │ `;
  const show = (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim() || / fire \d/.test(line)) continue;
      process.stdout.write(tag + line + '\n');
    }
  };
  p.stdout.on('data', show);
  p.stderr.on('data', show);
  return new Promise((resolve) => p.on('exit', (code) => resolve(code)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function match(title, port, hostArgs, players) {
  console.log(`\n\x1b[1m=== ${title} ===\x1b[0m  (host on 127.0.0.1:${port}, ${players.length} player processes)\n`);
  const host = run('HOST', colors[0], ['host', '--dedicated', '--local', '--port', String(port), ...hostArgs, '--autostart', String(players.length), '--matches', '1']);
  await wait(800);
  const bots = players.map((name, i) => run(name, colors[(i + 1) % colors.length], ['join', `127.0.0.1:${port}`, '--bot', '--name', name, '--matches', '1']));
  const codes = await Promise.all([host, ...bots]);
  console.log(`\nExit codes: ${codes.join(', ')} ${codes.every((c) => c === 0) ? '\x1b[32m(all clean)\x1b[0m' : '\x1b[31m(problem!)\x1b[0m'}`);
  return codes.every((c) => c === 0);
}

const ok1 = await match('BATTLESHIP: 2 players', basePort, ['--game', 'battleship'], ['Ada', 'Linus']);
const ok2 = await match('PROMPT PANIC: 3 players', basePort + 1, ['--game', 'prompt-panic', '--set', 'rounds=3', '--set', 'revealTime=5'], ['Grace', 'Alan', 'Ken']);
fs.rmSync(home, { recursive: true, force: true });
process.exit(ok1 && ok2 ? 0 : 1);
