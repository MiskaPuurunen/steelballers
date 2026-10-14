import { AgentMonitor, agentDir, debugEnabled, debugLogPath, readHealth, HOOK_VERSION } from '../integrations/agent-status.js';
import { inspectInstall, claudeSettingsPath, type InstallReport } from '../integrations/claude-settings.js';
import { theme, c } from '../ui/style.js';

/**
 * `c-cade doctor`: answers "why is the AI status wrong?" by separating
 * three questions: is the integration configured, are events arriving, and
 * what does C-Cade currently believe (and how sure is it)?
 */

interface DoctorReport {
  install: InstallReport;
  agentDir: string;
  receiving: boolean;
  lastHookAgoMs: number | null;
  health: ReturnType<typeof readHealth>;
  debug: boolean;
  sessions: Array<{
    session: string; project: string; status: string; certainty: string; detail: string;
    lastEvent: string; lastEventAgoMs: number; events: number; turns: number; tools: number;
    duplicates: number; outOfOrder: number; activeTools: number; ended: boolean;
  }>;
  primary: string | null;
  problems: string[];
}

/** Events within this window count as "receiving". */
const RECENT_MS = 24 * 3600_000;

export function buildReport(opts: { agent?: string; settingsFile?: string; now?: number } = {}): DoctorReport {
  const now = opts.now ?? Date.now();
  const agent = opts.agent ?? agentDir();
  const install = inspectInstall(opts.settingsFile ?? claudeSettingsPath());
  const health = readHealth(agent);
  const mon = new AgentMonitor(agent);
  mon.poll(now);
  const snap = mon.snapshot(now);
  const sessions = mon.sessions(now)
    .sort((a, b) => b.record.lastEventAt - a.record.lastEventAt)
    .map(({ record: r, view: v }) => ({
      session: r.sessionId, project: r.project, status: v.status, certainty: v.certainty, detail: v.detail,
      lastEvent: r.lastEvent, lastEventAgoMs: now - r.lastEventAt, ...r.counts,
      activeTools: Object.keys(r.activeTools).length, ended: r.ended,
    }));
  const lastHookAgoMs = health ? now - health.lastHookAt : null;
  const receiving = lastHookAgoMs !== null && lastHookAgoMs < RECENT_MS;

  const problems: string[] = [];
  if (!install.exists || install.installed.length === 0) {
    problems.push('No C-Cade hooks found in Claude Code settings. Run: c-cade hook install --write');
  } else {
    if (!install.readable) problems.push(`${install.file} is not valid JSON, so Claude Code may ignore it.`);
    if (install.missing.length) {
      problems.push(`Older install: no hooks for ${install.missing.join(', ')}, so tool activity, permission prompts or errors are invisible. Re-run: c-cade hook install --write${install.launch ? ' --launch' : ''}`);
    }
    for (const p of install.brokenPaths) problems.push(`A hook points at a file that doesn't exist: ${p}. Re-run hook install from the current install.`);
  }
  if (install.installed.length && !health) problems.push('Hooks are configured but no event has ever arrived. Restart Claude Code (settings load at startup) and send it a prompt.');
  else if (install.installed.length && !receiving) problems.push('No events in the last 24 hours. Is Claude Code running with these settings?');
  if (health?.lastError && health.lastErrorAt && now - health.lastErrorAt < RECENT_MS) {
    problems.push(`Last hook error ${ago(now - health.lastErrorAt)} ago: ${health.lastError}`);
  }
  if (health && health.hookVersion !== HOOK_VERSION) problems.push('Events were written by a different C-Cade version. Re-run hook install.');
  if (snap.unreadable) problems.push(`${snap.unreadable} session file(s) in ${agent} could not be read and are ignored.`);

  return {
    install, agentDir: agent, receiving, lastHookAgoMs, health, debug: debugEnabled(agent), sessions,
    primary: snap.primary?.sessionId ?? null, problems,
  };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

export function reportLines(r: DoctorReport): string[] {
  const ok = (b: boolean) => (b ? theme.good('yes') : theme.bad('no'));
  const L: string[] = [theme.title('C-CADE DOCTOR') + theme.muted('  AI status integration'), ''];
  L.push(theme.muted('Configured   ') + ok(r.install.installed.length > 0) +
    theme.muted(r.install.installed.length ? `  (${r.install.installed.length} events${r.install.launch ? ', auto-launch on' : ''})` : ''));
  L.push(theme.muted('  settings   ') + r.install.file);
  if (r.install.missing.length && r.install.installed.length) L.push(theme.muted('  missing    ') + theme.gold(r.install.missing.join(', ')));
  L.push(theme.muted('Receiving    ') + ok(r.receiving) + theme.muted(r.lastHookAgoMs !== null ? `  (last event ${ago(r.lastHookAgoMs)} ago: ${r.health?.lastEvent})` : '  (no event ever received)'));
  if (r.health) L.push(theme.muted(`  totals     ${r.health.received} events, ${r.health.malformed} malformed`));
  L.push(theme.muted('Event source ') + `${r.agentDir}`);
  L.push(theme.muted('Debug log    ') + (r.debug ? theme.good('on') + theme.muted(`  ${debugLogPath(r.agentDir)}`) : theme.muted('off (c-cade hook debug on)')));
  L.push('');
  if (r.sessions.length === 0) L.push(theme.muted('No agent sessions recorded.'));
  else {
    L.push(theme.muted('Sessions (newest first; * = shown in the HUD)'));
    for (const s of r.sessions.slice(0, 8)) {
      const mark = s.session === r.primary ? theme.primary('*') : ' ';
      const cert = s.certainty === 'inferred' ? theme.gold(' inferred') : theme.muted(' reported');
      L.push(`${mark} ${c.bold(s.status.padEnd(17))}${cert}  ${s.project || '?'} ${theme.muted(s.session.slice(0, 8))}`);
      L.push(theme.muted(`    ${s.detail}; last event ${s.lastEvent} ${ago(s.lastEventAgoMs)} ago; ${s.turns} turns, ${s.tools} tool calls` +
        (s.activeTools ? `, ${s.activeTools} running` : '') + (s.duplicates ? `, ${s.duplicates} dup` : '') + (s.outOfOrder ? `, ${s.outOfOrder} late` : '') + (s.ended ? ', ended' : '')));
    }
  }
  L.push('');
  if (r.problems.length === 0) L.push(theme.good('No problems found.'));
  else for (const p of r.problems) L.push(theme.bad('! ') + p);
  L.push('');
  L.push(theme.muted('Troubleshooting: settings are read when Claude Code starts, so restart it after'));
  L.push(theme.muted('installing. "Receiving: no" means Claude Code is not running the hooks. Esc'));
  L.push(theme.muted('interrupts fire no hook: the HUD shows the turn as quiet, then UNKNOWN.'));
  return L;
}
