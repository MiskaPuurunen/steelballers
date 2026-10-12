import type { Key } from '../../core/types.js';
import { ANSWER_MAX, type PromptPanicView } from '../../games/multiplayer/prompt-panic.js';
import { wrapText } from '../../net/sanitize.js';
import { c, padRight, theme, truncate } from '../style.js';
import { TextField, countdownStyled, frame, lower, scoreboard } from './widgets.js';
import type { GameUiCtx, MpGameUi } from './types.js';

/** Prompt Panic client: type an answer, vote anonymously, watch the reveal. */
export class PromptPanicUi implements MpGameUi {
  private view: PromptPanicView | null = null;
  private readonly field = new TextField('', ANSWER_MAX);
  private sel = 0;
  private sentRound = -1;
  /** Tried to vote for your own answer (shown until the selection moves). */
  private ownPick = false;

  constructor(private readonly ctx: GameUiCtx) {}

  setView(view: unknown): void {
    const v = view as PromptPanicView;
    if (this.view && (this.view.round !== v.round || this.view.phase !== v.phase)) {
      this.sel = 0;
      if (this.view.round !== v.round) this.field.clear();
    }
    const enteringVote = v.phase === 'vote' && this.view?.phase !== 'vote';
    this.view = v;
    if (v.entries && (enteringVote || this.sel >= v.entries.length)) {
      // Start on the first answer you are allowed to vote for.
      this.sel = Math.max(0, v.entries.findIndex((e) => !e.yours));
    }
  }

  onEvent(): void { /* everything arrives in views */ }

  tick(): void { /* deadlines come from the server */ }

  private isPlayer(): boolean {
    const you = this.ctx.you();
    return !!this.view && this.view.players.some((p) => p.id === you);
  }

  capturing(): boolean {
    const v = this.view;
    return !!v && v.phase === 'answer' && this.isPlayer() && v.yourAnswer === null && this.sentRound !== v.round;
  }

  onKey(key: Key): boolean {
    const v = this.view;
    if (!v) return false;
    const ch = lower(key);
    if (this.capturing()) {
      if (key.name === 'enter') {
        if (this.field.value.trim()) {
          this.ctx.send({ kind: 'answer', text: this.field.value });
          this.sentRound = v.round;
        }
        return true;
      }
      return this.field.onKey(key);
    }
    if (this.ctx.isHost() && ch === 'n' && v.phase !== 'final') {
      this.ctx.send({ kind: 'advance' });
      return true;
    }
    if (v.phase === 'vote' && v.entries) {
      const n = v.entries.length;
      if (this.ctx.isHost() && ch === 'x') {
        const e = v.entries[this.sel];
        if (e) this.ctx.send({ kind: 'veto', key: e.key });
        return true;
      }
      if (!this.isPlayer() || v.yourVote) return false;
      if (key.name === 'up') { this.sel = (this.sel + n - 1) % n; this.ownPick = false; return true; }
      if (key.name === 'down' || key.name === 'tab') { this.sel = (this.sel + 1) % n; this.ownPick = false; return true; }
      const byLetter = ch ? v.entries.findIndex((e) => e.key.toLowerCase() === ch) : -1;
      if (byLetter >= 0) { this.sel = byLetter; this.ownPick = false; return true; }
      if (key.name === 'enter' || key.name === 'space') {
        const e = v.entries[this.sel];
        if (e && e.yours) this.ownPick = true;
        else if (e) this.ctx.send({ kind: 'vote', key: e.key });
        return true;
      }
    }
    return false;
  }

  render(width: number, height: number): string[] {
    const v = this.view;
    if (!v) return [theme.muted('Waiting for the server...')];
    const w = Math.min(width, 74);
    const inner = w - 4;
    const now = this.ctx.serverNow();
    const you = this.ctx.you();
    const lines: string[] = [];
    const time = countdownStyled(v.deadline, now);
    const roundLabel = `ROUND ${v.round} / ${v.rounds}` + (v.multiplier > 1 ? theme.gold(c.bold('  DOUBLE POINTS')) : '');
    lines.push(padRight(c.bold(roundLabel), inner - 14) + theme.muted('PLAYERS: ') + c.bold(String(v.players.length)));
    lines.push(theme.muted(`${v.category} · ${v.absurdity}`));
    lines.push('');

    const promptLines = wrapText(v.prompt, inner).map((l) => c.bold(theme.text(l)));
    if (v.phase === 'answer' || v.phase === 'vote') {
      lines.push(theme.muted(v.phase === 'answer' ? 'YOUR PROMPT:' : 'THE PROMPT WAS:'));
      lines.push(...promptLines);
      if (v.twist) lines.push(theme.accent('Twist: ' + v.twist));
      lines.push('');
    }

    if (v.phase === 'answer') {
      if (this.capturing()) {
        lines.push(theme.muted('Your response:') + theme.muted(`  ${[...this.field.value].length}/${ANSWER_MAX}`));
        const cursorOn = Math.floor(this.ctx.anim() / 500) % 2 === 0;
        // Wrap the input so long answers stay readable.
        const shown = wrapText(this.field.value || ' ', inner - 2);
        shown.forEach((l, i) => lines.push((i === 0 ? theme.primary('> ') : '  ') + l + (i === shown.length - 1 ? (cursorOn ? theme.primary('_') : ' ') : '')));
      } else if (this.isPlayer()) {
        lines.push(theme.good('Answer locked in:'));
        for (const l of wrapText(v.yourAnswer ?? (this.field.value || '...'), inner - 2)) lines.push('  ' + theme.text(l));
      } else {
        lines.push(theme.muted('Players are writing their answers...'));
      }
      lines.push('');
      lines.push(this.progress(v, 'answered'));
    } else if (v.phase === 'vote') {
      const canVote = this.isPlayer() && !v.yourVote;
      lines.push(theme.muted(canVote ? 'VOTE FOR YOUR FAVOURITE:' : v.yourVote ? `You voted for ${v.yourVote}. Waiting for others...` : 'Players are voting...'));
      v.entries!.forEach((e, i) => {
        const sel = canVote && i === this.sel;
        const tag = e.yours ? theme.muted(' (yours)') : v.yourVote === e.key ? theme.good(' (your vote)') : '';
        const wrapped = wrapText(e.text, inner - 6);
        wrapped.forEach((l, j) => {
          const head = j === 0 ? (sel ? theme.primary('> ') : '  ') + (sel ? c.inverse(c.bold(` ${e.key} `)) : theme.key(` ${e.key} `)) + ' ' : '      ';
          lines.push(head + (e.yours ? theme.muted(l) : l) + (j === wrapped.length - 1 ? tag : ''));
        });
      });
      if (this.ownPick && canVote) lines.push(theme.bad("That one is yours: you can't vote for your own answer."));
      lines.push('');
      lines.push(this.progress(v, 'voted'));
    } else {
      const rows = v.results ?? [];
      // Budget: frame (2) + header (3) + results (2 each) + scores + timer.
      const roomy = height >= 13 + rows.length * 2 + v.scores.length;
      lines.push(theme.muted(v.phase === 'final' ? 'FINAL ROUND RESULTS' : 'RESULTS'));
      if (roomy) lines.push(...promptLines.map((l) => theme.muted(l)), '');
      for (const r of rows) {
        const bar = theme.gold('#'.repeat(Math.min(10, r.votes)));
        const badge = (r.sweep ? theme.gold(c.bold(' CLEAN SWEEP!')) : '') + (r.jinx ? theme.accent(' JINX!') : '');
        lines.push(theme.key(` ${r.key} `) + ' ' + c.bold(truncate(r.text, inner - 5)));
        lines.push('     ' + theme.muted('by ') + theme.primary(r.authors.join(' & ')) + theme.muted(`  ${r.votes} vote${r.votes === 1 ? '' : 's'} `) + bar + theme.good(`  +${r.points}`) + badge);
      }
      if (!rows.length) lines.push(theme.muted('No answers this round.'));
      if (v.note) lines.push(theme.gold(v.note));
      if (roomy) {
        lines.push('', theme.muted('SCOREBOARD'), ...scoreboard(v.scores, you, Math.min(inner, 40)));
      } else {
        lines.push('', theme.muted('SCORES  ') + v.scores.map((x) => `${x.id === you ? theme.primary(c.bold(x.name)) : x.name} ${theme.gold(String(x.score))}`).join(theme.muted(' · ')));
      }
    }
    if (v.note && v.phase !== 'reveal' && v.phase !== 'final') lines.push(theme.gold(v.note));
    lines.push('');
    lines.push(time ? theme.muted('TIME REMAINING: ') + time : '');

    return frame(theme.title('PROMPT PANIC'), lines.slice(0, Math.max(6, height - 2)), w);
  }

  private progress(v: PromptPanicView, what: 'answered' | 'voted'): string {
    return v.players.map((p) => {
      const done = what === 'answered' ? p.answered : p.voted;
      const mark = !p.connected ? theme.muted('?') : done ? theme.good('✓') : theme.muted('·');
      return mark + ' ' + (done ? theme.text(p.name) : theme.muted(p.name));
    }).join('  ');
  }

  hints(): Array<[string, string]> {
    const v = this.view;
    if (!v) return [];
    const h: Array<[string, string]> = [];
    if (this.capturing()) h.push(['Enter', 'submit answer']);
    else if (v.phase === 'vote' && this.isPlayer() && !v.yourVote) h.push(['Up/Down or A-H', 'choose'], ['Enter', 'vote']);
    if (this.ctx.isHost() && v.phase !== 'final' && !this.capturing()) {
      h.push(['N', v.phase === 'reveal' ? 'next round' : 'skip timer']);
      if (v.phase === 'vote') h.push(['X', 'remove selected answer']);
    }
    return h;
  }
}
