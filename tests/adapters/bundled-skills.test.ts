import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import adapter from '../../src/adapters/claude-code.js';
import { buildSetupContext, installBundledSkill, resolvePackageRoot, AWM_INSTRUCTION_CONTENT } from '../../src/adapters/common.js';

const SHIPPED = join(resolvePackageRoot(), 'plugin', 'skills', 'awm-learn');
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'awm-skills-'));
  savedHome = process.env.AWM_SETUP_HOME; process.env.AWM_SETUP_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.AWM_SETUP_HOME; else process.env.AWM_SETUP_HOME = savedHome;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

const skillsDir = () => join(home, '.claude', 'skills');
const installed = (f: string) => join(skillsDir(), 'awm-learn', f);

describe('awm setup installs the awm-learn skill', () => {
  it('the guidance names the skill it installs', () => {
    expect(AWM_INSTRUCTION_CONTENT).toContain('awm-learn');
    expect(AWM_INSTRUCTION_CONTENT).toContain('/awm-learn');
  });

  it('a global setup writes the skill byte for byte, with its ledger script', () => {
    const ctx = buildSetupContext({ isGlobal: true, dbPath: join(home, 'db', 'memory.db'), existingEnv: null });
    const msg = adapter.writeInstructions(ctx, false);
    expect(msg).toMatch(/Skills: awm-learn: 2 file\(s\) written/);
    expect(readFileSync(installed('SKILL.md'), 'utf-8')).toBe(readFileSync(join(SHIPPED, 'SKILL.md'), 'utf-8'));
    expect(readFileSync(installed('scripts/ledger.mjs'), 'utf-8')).toBe(readFileSync(join(SHIPPED, 'scripts', 'ledger.mjs'), 'utf-8'));
    // and a second run changes nothing
    expect(adapter.writeInstructions(ctx, false)).toMatch(/awm-learn: up to date/);
  });

  it('--no-instructions leaves the skills folder alone', () => {
    const ctx = buildSetupContext({ isGlobal: true, dbPath: join(home, 'db', 'memory.db'), existingEnv: null });
    adapter.writeInstructions(ctx, true);
    expect(existsSync(installed('SKILL.md'))).toBe(false);
  });

  it('upgrades a copy it wrote, but never overwrites one the owner edited', () => {
    const src = mkdtempSync(join(tmpdir(), 'awm-skill-src-'));
    try {
      mkdirSync(join(src, 'demo'));
      writeFileSync(join(src, 'demo', 'SKILL.md'), 'v1');
      expect(installBundledSkill(skillsDir(), 'demo', '1.0.0', src)).toMatch(/1 file\(s\) written/);

      writeFileSync(join(src, 'demo', 'SKILL.md'), 'v2');                 // a new release
      expect(installBundledSkill(skillsDir(), 'demo', '1.0.1', src)).toMatch(/1 file\(s\) written/);
      expect(readFileSync(join(skillsDir(), 'demo', 'SKILL.md'), 'utf-8')).toBe('v2');

      writeFileSync(join(skillsDir(), 'demo', 'SKILL.md'), 'my notes');    // the owner edits it
      writeFileSync(join(src, 'demo', 'SKILL.md'), 'v3');
      expect(installBundledSkill(skillsDir(), 'demo', '1.0.2', src)).toMatch(/left as it is — SKILL\.md changed locally/);
      expect(readFileSync(join(skillsDir(), 'demo', 'SKILL.md'), 'utf-8')).toBe('my notes');
    } finally { rmSync(src, { recursive: true, force: true }); }
  });

  it('a hand-made copy with no install record is left alone unless it already matches', () => {
    const src = mkdtempSync(join(tmpdir(), 'awm-skill-src-'));
    try {
      mkdirSync(join(src, 'demo'));
      writeFileSync(join(src, 'demo', 'SKILL.md'), 'shipped');
      mkdirSync(join(skillsDir(), 'demo'), { recursive: true });
      writeFileSync(join(skillsDir(), 'demo', 'SKILL.md'), 'hand-made');
      expect(installBundledSkill(skillsDir(), 'demo', '1.0.0', src)).toMatch(/left as it is/);

      writeFileSync(join(skillsDir(), 'demo', 'SKILL.md'), 'shipped');      // identical: adopted
      expect(installBundledSkill(skillsDir(), 'demo', '1.0.0', src)).toMatch(/up to date/);
      expect(existsSync(join(skillsDir(), 'demo', '.awm-skill.json'))).toBe(true);
    } finally { rmSync(src, { recursive: true, force: true }); }
  });
});
