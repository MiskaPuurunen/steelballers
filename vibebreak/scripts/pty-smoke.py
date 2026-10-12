#!/usr/bin/env python3
"""
Real-terminal smoke test: runs VibeBreak inside a pseudo-terminal, sends
keystrokes, renders the output with a VT100 emulator (pyte) and checks what
is on screen. Also verifies the terminal is restored on exit.

Usage: python3 scripts/pty-smoke.py [--dump DIR]
Requires: pip install pyte ; npm run build
"""
import os, pty, select, sys, time, signal, tempfile, json

import pyte

COLS, ROWS = 100, 34
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = sys.argv[sys.argv.index('--dump') + 1] if '--dump' in sys.argv else None


class Session:
    def __init__(self, args, home):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b''
        pid, fd = pty.fork()
        if pid == 0:
            env = dict(os.environ, VIBEBREAK_HOME=home, TERM='xterm-256color', COLUMNS=str(COLS), LINES=str(ROWS))
            os.execvpe('node', ['node', os.path.join(ROOT, 'dist/cli/index.js'), *args], env)
        self.pid, self.fd = pid, fd
        import fcntl, termios, struct
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.02)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.raw += data
                self.stream.feed(data)

    def send(self, s, wait=0.25):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)
        self.pump(wait)

    def text(self):
        return '\n'.join(line.rstrip() for line in self.screen.display)

    def has(self, s):
        return s in self.text()

    def wait_exit(self, timeout=3):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.05)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
        os.kill(self.pid, signal.SIGKILL)
        return None


failures = []
def check(cond, msg, sess=None):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        failures.append(msg)
        if sess:
            print(sess.text())

def dump(sess, name):
    if DUMP:
        os.makedirs(DUMP, exist_ok=True)
        with open(os.path.join(DUMP, name + '.txt'), 'w') as f:
            f.write(sess.text())


home = tempfile.mkdtemp(prefix='vibebreak-smoke-')

print('menu -> quick play -> pause -> end round -> results -> quit')
s = Session([], home)
s.pump(1.0)
check(s.has('QUICK PLAY') and s.has('DAILY CHALLENGE'), 'main menu renders', s)
check(s.has("YOUR AI IS THINKING"), 'tagline renders', s)
dump(s, 'menu')
s.send('1', 0.4)
check(s.has('NEXT UP') and s.has('Seed'), 'briefing shows game/modifier/seed', s)
dump(s, 'briefing')
s.send('\r', 0.8)
check(s.has('SCORE') and s.has('TIME'), 'game HUD renders', s)
dump(s, 'playing')
s.send('\x1b', 0.4)
check(s.has('PAUSED'), 'Esc pauses', s)
s.send('q', 1.0)
check(s.has('ROUND ENDED EARLY') and s.has('XP'), 'ending round shows results with XP', s)
dump(s, 'results')
s.send('q', 0.2)
code = s.wait_exit()
check(code == 0, f'quit exits with code 0 (got {code})')
check(b'\x1b[?1049l' in s.raw[-200:] and b'\x1b[?25h' in s.raw[-200:], 'alt screen left and cursor restored')
check(os.path.exists(os.path.join(home, 'save.json')), 'save file written')
save = json.load(open(os.path.join(home, 'save.json')))
check(save['rounds'] == 1, 'one round recorded')
check('back-to-work' in save['achievements'], 'Back to Work achievement on quit')

print('play --game snake --no-timer')
s = Session(['play', '--game', 'snake', '--no-timer', '--seed', 'SMOKE-U'], home)
s.pump(0.8)
check(s.has('Timer') and s.has('none'), 'untimed: briefing says there is no timer', s)
s.send('\r', 0.6)
check(s.has('NO TIMER') and not s.has('TIME 0:'), 'untimed: HUD has no countdown', s)
s.send('\x03', 0.3)
check(s.wait_exit() == 0, 'untimed: Ctrl+C exits cleanly')

for game, keys in [
    ('bugbash', 'qweasdzxc' * 3),
    ('snake', ['\x1b[B', '\x1b[C', '\x1b[A']),
    ('ski', ['a', 'a', '\x1b[C', 'w', 's', ' ']),
    ('stack', '    '),
    ('dungeon', ['\x1b[C', '\x1b[C', '\x1b[B', 'd', 'd', 's']),
    ('crossy', ['\x1b[A', 'w', 'a', 'd']),
    ('tetris', ['\x1b[D', '\x1b[A', 'z', 's', ' ', 'd', ' ']),
]:
    print(f'play --game {game}')
    s = Session(['play', '--game', game, '--duration', '15', '--seed', 'SMOKE-1'], home)
    s.pump(0.8)
    check(s.has('Seed') and s.has('SMOKE-1'), f'{game}: briefing shows seed', s)
    s.send('\r', 0.6)
    check(s.has('SCORE'), f'{game}: playing', s)
    for k in keys:
        s.send(k, 0.15)
    s.pump(0.5)
    dump(s, f'game-{game}')
    check(s.has('SCORE') or s.has('GAME OVER'), f'{game}: still rendering after input', s)
    s.send('\x03', 0.1)   # Ctrl+C exits instantly
    code = s.wait_exit()
    check(code == 0, f'{game}: Ctrl+C exits cleanly (code {code})')
    check(b'\x1b[?25h' in s.raw[-200:], f'{game}: cursor restored')

print('time limit ends a round on its own')
s = Session(['play', '--game', 'stack', '--duration', '15', '--seed', 'TIMER'], home)
s.pump(0.6)
s.send('\r', 0.3)
# Never drop: stack only ends on time.
s.pump(16.5)
check(s.has("TIME'S UP"), 'round ends at the time limit', s)
s.send('q', 0.2)
check(s.wait_exit() == 0, 'exit after timed round')

print('resize to tiny terminal')
s = Session(['play', '--game', 'snake', '--seed', 'RESIZE'], home)
s.pump(0.6)
s.send('\r', 0.3)
import fcntl, termios, struct
s.screen.resize(20, 50)
fcntl.ioctl(s.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 50, 0, 0))
s.pump(0.8)
check('too small' in s.text().lower(), 'too-small notice after resize', s)
s.send('\x03', 0.1)
check(s.wait_exit() == 0, 'exit after resize')

print('daily challenge')
s = Session(['daily'], home)
s.pump(0.8)
check(s.has('DAILY CHALLENGE'), 'daily briefing', s)
s.send('\x03', 0.1)
s.wait_exit()

print('corrupted save is recovered')
with open(os.path.join(home, 'save.json'), 'w') as f:
    f.write('{ not json')
s = Session([], home)
s.pump(0.8)
check(s.has('unreadable'), 'menu shows recovery notice', s)
s.send('q', 0.2)
check(s.wait_exit() == 0, 'exit after recovery')
check(any(n.startswith('save.json.corrupt-') for n in os.listdir(home)), 'corrupt file backed up')

print('AI status: real hook processes -> live HUD, no key pressed')
import subprocess
def hook(payload):
    env = dict(os.environ, VIBEBREAK_HOME=home)
    p = subprocess.run(['node', os.path.join(ROOT, 'dist/cli/index.js'), 'hook'], input=json.dumps(payload).encode(),
                       env=env, capture_output=True, timeout=10)
    return p.returncode, p.stdout
s = Session(['play', '--game', 'tetris', '--duration', '60', '--seed', 'AI-SMOKE'], home)
s.pump(0.6)
s.send('\r', 0.6)
check(s.has('no agent activity seen'), 'status line shows "no activity" before any event', s)
base = {'session_id': 'smoke-session-1', 'cwd': '/home/dev/myproject', 'transcript_path': '/nonexistent'}
code, out = hook({**base, 'hook_event_name': 'UserPromptSubmit', 'prompt': 'SECRET PROMPT', 'prompt_id': 'p1'})
check(code == 0 and out == b'', f'hook exits 0 with no stdout (code {code}, {len(out)} bytes)')
s.pump(1.0)
check(s.has('AI THINKING') and s.has('myproject'), 'THINKING shown within 1s', s)
hook({**base, 'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_use_id': 'tu1', 'tool_input': {'command': 'npm test'}})
s.pump(1.0)
check(s.has('AI WORKING') and s.has('running Bash'), 'WORKING (running Bash) shown', s)
hook({**base, 'hook_event_name': 'PermissionRequest', 'tool_name': 'Edit'})
s.pump(1.0)
check(s.has('NEEDS YOU'), 'permission request shows NEEDS YOU', s)
hook({**base, 'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'tool_use_id': 'tu1'})
hook({**base, 'hook_event_name': 'Stop'})
s.pump(1.0)
check(s.has('AI DONE'), 'Stop shows DONE', s)
dump(s, 'ai-status')
check(s.has('NEXT') and s.has('LINES'), 'Tetris board intact alongside status line', s)
s.send('p', 0.4)
check(s.has('PAUSED'), 'Tetris: P pauses', s)
s.send('p', 0.4)
check(not s.has('PAUSED'), 'Tetris: P resumes', s)
s.send('q', 1.0)
check(s.has('ROUND ENDED EARLY'), 'Tetris: Q ends the round', s)
s.send('q', 0.2)
check(s.wait_exit() == 0, 'exit after AI status run')
stored = ''.join(open(os.path.join(dp, f)).read() for dp, _, fs in os.walk(home) for f in fs if not f.endswith('.json') or 'agent' in dp)
check('SECRET PROMPT' not in stored and 'npm test' not in stored, 'no prompt text or tool input stored')
doc = subprocess.run(['node', os.path.join(ROOT, 'dist/cli/index.js'), 'doctor'], env=dict(os.environ, VIBEBREAK_HOME=home, NO_COLOR='1'), capture_output=True, timeout=10).stdout.decode()
check('Receiving    yes' in doc and 'smoke-se' in doc, 'doctor reports events received and the session', None)
if 'Receiving    yes' not in doc: print(doc)

print('themes')
s = Session(['--theme', 'christmas'], home)
s.pump(1.2)
check(s.has('WRAPPING PRESENTS'), 'christmas tagline via --theme', s)
check(b'38;5;' in s.raw, '256-colour shades used in a 256-colour terminal')
dump(s, 'theme-christmas')
s.send('5', 0.4)
check(s.has('THEMES') and s.has('Frutiger Aero'), 'THEMES screen opens', s)
s.send('4', 0.4)
s.send('\r', 0.6)
check(s.has('SYNCING TO THE CLOUD'), 'picking Frutiger Aero applies it', s)
dump(s, 'theme-aero')
s.send('q', 0.2)
check(s.wait_exit() == 0, 'exit after theme change')
save = json.load(open(os.path.join(home, 'save.json')))
check(save['settings'].get('theme') == 'frutiger-aero', 'theme saved to settings')
out = subprocess.run(['node', os.path.join(ROOT, 'dist/cli/index.js'), 'theme', 'halloween'], env=dict(os.environ, VIBEBREAK_HOME=home), capture_output=True, timeout=10)
check(out.returncode == 0 and json.load(open(os.path.join(home, 'save.json')))['settings']['theme'] == 'halloween', 'vibebreak theme <id> saves')
bad = subprocess.run(['node', os.path.join(ROOT, 'dist/cli/index.js'), 'play', '--theme', 'nope'], env=dict(os.environ, VIBEBREAK_HOME=home), capture_output=True, timeout=10)
check(bad.returncode == 2 and b'unknown theme' in bad.stderr, 'unknown --theme is rejected')

print()
if failures:
    print(f'{len(failures)} smoke check(s) FAILED')
    sys.exit(1)
print('All smoke checks passed.')
