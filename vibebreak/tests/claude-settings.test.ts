import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isVibeBreakHandler, mergeVibeBreak, stripVibeBreak, updateClaudeSettings } from '../src/integrations/claude-settings.js';

const BASE = '"C:/Program Files/nodejs/node.exe" "C:/BALLS/vibebreak/dist/cli/index.js" hook';
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cs-')), 'settings.json');
const theirs = { type: 'command', command: 'npx prettier --write .' };

describe('Claude settings editing', () => {
  it('recognises only VibeBreak handlers', () => {
    expect(isVibeBreakHandler({ command: BASE })).toBe(true);
    expect(isVibeBreakHandler({ command: `${BASE} --launch` })).toBe(true);
    expect(isVibeBreakHandler({ command: 'vibebreak hook' })).toBe(true);
    expect(isVibeBreakHandler({ command: '"/usr/lib/node_modules/vibebreak-cli/dist/cli/index.js" hook' })).toBe(true);
    expect(isVibeBreakHandler(theirs)).toBe(false);
  });

  it('merges into existing settings without touching other keys or hooks', () => {
    const s = mergeVibeBreak({ model: 'opus', hooks: { Stop: [{ hooks: [theirs] }], PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] } }, BASE, `${BASE} --launch`);
    expect(s.model).toBe('opus');
    expect(s.hooks!.PreToolUse).toHaveLength(2);
    expect(s.hooks!.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [theirs] });
    expect(s.hooks!.Stop).toHaveLength(2);
    expect(s.hooks!.Stop[0].hooks![0]).toEqual(theirs);
    expect(s.hooks!.UserPromptSubmit[0].hooks![0]).toMatchObject({ command: `${BASE} --launch`, async: true });
  });

  it('is idempotent: re-installing replaces rather than duplicates', () => {
    let s = mergeVibeBreak({}, BASE, `${BASE} --launch`);
    s = mergeVibeBreak(s, BASE);
    expect(s.hooks!.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks!.UserPromptSubmit[0].hooks![0].command).toBe(BASE);
  });

  it('uninstall removes only VibeBreak entries', () => {
    const s = stripVibeBreak(mergeVibeBreak({ hooks: { Stop: [{ hooks: [theirs] }] } }, BASE));
    expect(s.hooks).toEqual({ Stop: [{ hooks: [theirs] }] });
    expect(stripVibeBreak(mergeVibeBreak({}, BASE))).toEqual({});
  });

  it('writes the file with a backup, and creates it when missing', () => {
    const f = file();
    expect(updateClaudeSettings((s) => mergeVibeBreak(s, BASE), f)).toMatchObject({ ok: true, backup: null });
    const r = updateClaudeSettings((s) => mergeVibeBreak(s, BASE, `${BASE} --launch`), f);
    expect(r).toMatchObject({ ok: true });
    expect(fs.existsSync(`${f}.vibebreak-backup`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    const f = file();
    fs.writeFileSync(f, '{ "model": "opus", // comment\n}');
    expect(updateClaudeSettings((s) => mergeVibeBreak(s, BASE), f).ok).toBe(false);
    expect(fs.readFileSync(f, 'utf8')).toContain('// comment');
  });
});
