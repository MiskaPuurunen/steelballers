/**
 * Terminal I/O abstraction. The real implementation drives process.stdin /
 * process.stdout; tests use FakeTerminal. Everything that touches terminal
 * state lives here so restoring it is guaranteed in one place.
 */

export interface TerminalIO {
  readonly columns: number;
  readonly rows: number;
  write(s: string): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: () => void): void;
  /** Enter the alternate screen, hide cursor, enable raw input. */
  start(): void;
  /** Restore everything. Must be idempotent and safe to call from exit handlers. */
  stop(): void;
}

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H';
const LEAVE = '\x1b[0m\x1b[?25h\x1b[?1049l';

export class NodeTerminal implements TerminalIO {
  private started = false;
  private dataCb: ((d: string) => void) | null = null;
  private resizeCb: (() => void) | null = null;
  private readonly onStdinData = (d: Buffer | string) => this.dataCb?.(d.toString());
  private readonly onStdoutResize = () => this.resizeCb?.();
  private readonly onProcessExit = () => this.stop();

  constructor(
    private readonly stdin: NodeJS.ReadStream = process.stdin,
    private readonly stdout: NodeJS.WriteStream = process.stdout,
  ) {}

  get columns(): number {
    return this.stdout.columns || 80;
  }

  get rows(): number {
    return this.stdout.rows || 24;
  }

  write(s: string): void {
    this.stdout.write(s);
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    process.on('exit', this.onProcessExit);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.onStdinData);
    this.stdin.resume();
    this.stdout.on('resize', this.onStdoutResize);
    this.stdout.write(ENTER);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.stdout.write(LEAVE);
    } catch {
      /* stdout may already be closed */
    }
    this.stdin.off('data', this.onStdinData);
    this.stdout.off('resize', this.onStdoutResize);
    process.off('exit', this.onProcessExit);
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    this.stdin.pause();
  }
}

/** In-memory terminal for tests: records output and lets tests send keys. */
export class FakeTerminal implements TerminalIO {
  output = '';
  started = false;
  stopped = false;
  private dataCb: ((d: string) => void) | null = null;
  private resizeCb: (() => void) | null = null;

  constructor(public columns = 100, public rows = 32) {}

  write(s: string): void {
    this.output += s;
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  send(data: string): void {
    this.dataCb?.(data);
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resizeCb?.();
  }
}
