import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NodeTerminal } from '../src/ui/terminal.js';

/** Just enough of process.stdin / stdout to watch what the terminal driver does. */
function fakeStreams() {
  const raw: boolean[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => raw.push(on),
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
  });
  let written = '';
  const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, write: (s: string) => { written += s; return true; } });
  return { stdin, stdout, raw, out: () => written };
}

describe('terminal setup and restore (shared by every interface)', () => {
  it('start enters raw mode and the alternate screen; stop restores everything, exactly once', () => {
    const f = fakeStreams();
    const exitListeners = process.listenerCount('exit');
    const t = new NodeTerminal(f.stdin as unknown as NodeJS.ReadStream, f.stdout as unknown as NodeJS.WriteStream);
    t.start();
    t.start(); // idempotent
    expect(f.raw).toEqual([true]);
    expect(f.out()).toContain('\x1b[?1049h'); // alternate screen
    expect(f.out()).toContain('\x1b[?25l'); // cursor hidden
    expect(process.listenerCount('exit')).toBe(exitListeners + 1); // restores even on a hard exit
    expect(f.stdin.listenerCount('data')).toBe(1);

    t.stop();
    const afterStop = f.out();
    expect(afterStop).toContain('\x1b[?25h'); // cursor back
    expect(afterStop).toContain('\x1b[?1049l'); // main screen back
    expect(afterStop).toContain('\x1b[?2004l'); // bracketed paste off
    expect(f.raw).toEqual([true, false]);
    expect(f.stdin.listenerCount('data')).toBe(0);
    expect(f.stdout.listenerCount('resize')).toBe(0);
    expect(process.listenerCount('exit')).toBe(exitListeners);

    // Crash handler, signal handler and normal quit may all call stop: only the first acts.
    t.stop();
    t.stop();
    expect(f.out()).toBe(afterStop);
    expect(f.raw).toEqual([true, false]);
  });

  it('keys and resizes reach the app; non-TTY input is not put in raw mode', () => {
    const f = fakeStreams();
    f.stdin.isTTY = false;
    const t = new NodeTerminal(f.stdin as unknown as NodeJS.ReadStream, f.stdout as unknown as NodeJS.WriteStream);
    const keys: string[] = [];
    let resized = 0;
    t.onData((d) => keys.push(d));
    t.onResize(() => resized++);
    t.start();
    f.stdin.emit('data', 'w');
    f.stdout.emit('resize');
    expect(keys).toEqual(['w']);
    expect(resized).toBe(1);
    expect(f.raw).toEqual([]);
    t.stop();
    f.stdin.emit('data', 'x'); // nothing arrives after stop
    expect(keys).toEqual(['w']);
  });

  it('a stdout that is already closed does not stop the restore', () => {
    const f = fakeStreams();
    const t = new NodeTerminal(f.stdin as unknown as NodeJS.ReadStream, f.stdout as unknown as NodeJS.WriteStream);
    t.start();
    f.stdout.write = () => { throw new Error('EPIPE'); };
    expect(() => t.stop()).not.toThrow();
    expect(f.raw).toEqual([true, false]);
  });
});
