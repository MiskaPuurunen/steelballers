import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, theme } from '../ui/style.js';

/**
 * CODE SPRINT — typing under pressure.
 *
 * All challenge content is inert text: it is displayed and compared
 * character by character, never parsed, evaluated or executed.
 */

export const SNIPPETS: readonly (readonly string[])[] = [
  // Tier 0: dev vocabulary and short commands
  [
    'git status', 'npm install', 'ls -la', 'cd ..', 'git push', 'null pointer',
    'merge conflict', 'stack trace', 'pull request', 'localhost', 'segfault',
    'rubber duck', 'docker ps', 'pip install', 'cargo build', 'hotfix',
    'race condition', 'off by one', 'works on my machine', 'git pull --rebase',
    'npm test', 'code review', 'tech debt', 'it compiles', 'sudo !!',
  ],
  // Tier 1: commands and one-line syntax
  [
    'git commit -m "fix: typo"', 'git rebase -i HEAD~3', 'npm run build',
    'const items = [];', 'if (err) return;', 'SELECT * FROM users;',
    'grep -rn TODO src/', 'docker compose up -d', 'git checkout -b feat/arcade',
    'console.log("here");', 'chmod +x run.sh', 'ssh dev@localhost',
    'for i in range(10):', 'export PATH=$PATH:~/bin', 'git stash pop',
    'let total = 0;', 'return null;', 'import os, sys', 'npx tsc --noEmit',
    'curl -I localhost:3000', 'git diff --staged', 'kubectl get pods -A',
  ],
  // Tier 2: real-looking code fragments
  [
    'const add = (a, b) => a + b;',
    'arr.map((x) => x * 2).filter(Boolean);',
    'fn main() { println!("hi"); }',
    'def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)',
    'SELECT id FROM bugs WHERE fixed = false;',
    'try { await deploy(); } catch (e) { rollback(); }',
    'public static void main(String[] args) {}',
    '#include <stdio.h>',
    '{ "name": "vibebreak", "version": "1.0.0" }',
    'git log --oneline --graph | head -n 20',
    'type Result<T> = { ok: true; value: T } | { ok: false };',
    'while (!done) { done = tryAgain(); }',
    'const [state, setState] = useState(0);',
    'for (let i = 0; i < n; i++) sum += a[i];',
    'if __name__ == "__main__": main()',
  ],
];

export class CodeSprint extends BaseGame {
  readonly minSize = { width: 64, height: 12 };

  target = '';
  typed = '';
  golden = false;
  completed = 0;
  perfectSnippets = 0;
  streak = 0;
  bestStreak = 0;
  keystrokes = 0;
  correctKeys = 0;
  errors = 0;
  private snippetErrors = 0;
  private completedChars = 0;
  private tier: number;
  private decks: string[][];
  private capsNext = false;
  next = '';

  constructor(ctx: GameContext) {
    super(ctx);
    this.tier = this.level === 2 ? 1 : 0;
    this.decks = SNIPPETS.map((pool) => this.rng.shuffle(pool));
    this.next = this.draw();
    this.advance();
  }

  private maxTier(): number {
    return this.level === 0 ? 1 : 2;
  }

  private draw(): string {
    const deck = this.decks[this.tier];
    if (deck.length === 0) this.decks[this.tier] = this.rng.shuffle(SNIPPETS[this.tier]);
    return this.decks[this.tier].pop()!;
  }

  private advance(): void {
    this.target = this.capsNext ? this.next.toUpperCase() : this.next;
    this.capsNext = false;
    this.typed = '';
    this.snippetErrors = 0;
    this.golden = this.rng.chance(0.12 * this.effects.specialMult);
    if (this.completed > 0 && this.completed % 3 === 0 && this.tier < this.maxTier()) this.tier++;
    this.next = this.draw();
    if (this.effects.chaos && this.rng.chance(0.25)) {
      this.capsNext = true;
    }
  }

  protected tick(): void {
    /* Typing is input-driven; the round clock lives in BaseGame. */
  }

  protected onKey(key: Key): void {
    if (key.name === 'backspace') {
      if (this.typed.length) this.typed = this.typed.slice(0, -1);
      return;
    }
    const ch = key.name === 'space' ? ' ' : key.name === 'char' ? key.ch : undefined;
    if (!ch || ch.length !== 1 || key.ctrl) return;
    if (this.typed.length >= this.target.length) {
      this.flash('Fix the red characters (Backspace)', 'bad', 900);
      return;
    }
    const expected = this.target[this.typed.length];
    this.typed += ch;
    this.keystrokes++;
    if (ch === expected) {
      this.correctKeys++;
    } else {
      this.errors++;
      this.snippetErrors++;
      this.streak = 0;
      this.penalize(5);
      if (this.effects.lives !== null && this.errors >= this.effects.lives) {
        this.flash('Out of battery!', 'bad', 2000);
        this.end('gameover');
        return;
      }
    }
    if (this.typed === this.target) this.complete();
  }

  private complete(): void {
    this.completed++;
    this.completedChars += this.target.length;
    const tierMult = 1 + this.tierOf(this.target) * 0.5;
    let base = this.target.length * 10 * tierMult;
    if (this.golden) base *= 2 * this.effects.specialMult;
    const perfect = this.snippetErrors === 0;
    if (perfect) {
      this.perfectSnippets++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      base *= 1.5;
    }
    const pts = this.addScore(base);
    this.flash(perfect ? `CLEAN! +${pts}` : `+${pts}`, this.golden ? 'gold' : 'good', 800);
    this.advance();
    if (this.capsNext) this.flash('Heads up: CAPS LOCK incident next', 'gold', 1200);
  }

  private tierOf(s: string): number {
    const lower = s.toLowerCase();
    return SNIPPETS.findIndex((pool) => pool.some((p) => p.toLowerCase() === lower));
  }

  wpm(): number {
    const minutes = this.elapsedMs / 60000;
    if (minutes < 0.05) return 0;
    let current = 0;
    for (let i = 0; i < this.typed.length; i++) if (this.typed[i] === this.target[i]) current++;
    return Math.round((this.completedChars + current) / 5 / minutes);
  }

  accuracy(): number {
    return this.keystrokes ? Math.round((this.correctKeys / this.keystrokes) * 1000) / 10 : 100;
  }

  render(): string[] {
    let line = '';
    for (let i = 0; i < this.target.length; i++) {
      const want = this.target[i];
      if (i < this.typed.length) {
        const got = this.typed[i];
        line += got === want ? theme.good(want) : c.inverse(c.red(want === ' ' ? '_' : want));
      } else if (i === this.typed.length) {
        line += c.inverse(want);
      } else {
        line += (this.golden ? theme.gold : c.gray)(want);
      }
    }
    if (this.typed.length >= this.target.length && this.typed !== this.target) line += c.inverse(' ');
    const label = this.golden ? theme.gold(c.bold('* GOLDEN SNIPPET x2 *')) : theme.muted('type this:');
    return [
      '',
      label,
      '',
      '  ' + theme.primary('$ ') + line,
      '',
      '',
      theme.muted('next: ') + c.dim(this.next),
      '',
      theme.muted(`snippets ${this.completed}   clean ${this.perfectSnippets}   errors ${this.errors}`),
    ];
  }

  hud(): HudItem[] {
    const items: HudItem[] = [
      { label: 'WPM', value: String(this.wpm()) },
      { label: 'ACC', value: `${this.accuracy()}%`, tone: this.accuracy() >= 95 ? 'good' : this.accuracy() < 80 ? 'bad' : 'info' },
    ];
    if (this.effects.lives !== null) {
      items.push({ label: 'LIVES', value: String(Math.max(0, this.effects.lives - this.errors)), tone: 'bad' });
    }
    return items;
  }

  protected stats(): Record<string, number> {
    return {
      snippets: this.completed,
      wpm: this.wpm(),
      accuracy: this.accuracy(),
      errors: this.errors,
      cleanSnippets: this.perfectSnippets,
      bestStreak: this.bestStreak,
    };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Words per minute', String(this.wpm())],
      ['Accuracy', `${this.accuracy()}%`],
      ['Snippets', String(this.completed)],
      ['Clean snippets', String(this.perfectSnippets)],
      ['Best clean streak', String(this.bestStreak)],
    ];
  }

  protected isPerfect(): boolean {
    return this.errors === 0 && this.completed >= 3;
  }
}

export const codeSprintDef: GameDefinition = {
  id: 'codesprint',
  name: 'Code Sprint',
  genre: 'Typing under pressure',
  tagline: 'Type real-looking dev snippets fast and clean. Nothing is executed.',
  controls: [
    ['type', 'match the snippet'],
    ['Backspace', 'fix mistakes'],
  ],
  weight: 2,
  defaultDurationSec: 30,
  xpScale: 20,
  create: (ctx) => new CodeSprint(ctx),
};
