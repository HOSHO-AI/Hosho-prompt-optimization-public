import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { bundleSkillsForPrompt, planSkillBundle } from '../src/file-fetcher';
import { assessPipeline } from '../src/api-client';

// The 100 KB skill cap is first-fit in reference order and used to run independently per side.
// When a PR grew one skill, a later skill that fitted BEFORE no longer fitted AFTER, and every
// reviewer model saw a whole `## Skill: <name>` section vanish while the prompt still referenced
// it - a spurious "removed skill" finding on every model in the 2026-09-04 review-model lab.
// planSkillBundle decides the set once, charging each skill at its larger size across the two
// commits, so a skill the cap drops is dropped on BOTH sides.

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosho-bundle-plan-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@hosho.local', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git commit -q --allow-empty -m "init"', { cwd: dir });
  return dir;
}
function commit(repo: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git add -A', { cwd: repo });
  execSync('git commit -q -m fixture', { cwd: repo });
  return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
}

const KB = 1024;
const body = (tag: string, kb: number) => `${tag} ` + 'x'.repeat(kb * KB);

describe('planSkillBundle - one cap decision for both sides', () => {
  let repo: string; let origCwd: string; let baseSha: string; let headSha: string;
  const prompt = 'Load `big-skill`, then `late-skill`, then `tiny-skill`.';

  beforeAll(() => {
    origCwd = process.cwd(); repo = makeRepo(); process.chdir(repo);
    // BEFORE: big 60 KB + late 30 KB + tiny 1 KB = 91 KB, all three fit under 100 KB.
    baseSha = commit(repo, {
      'skills/big-skill/SKILL.md': body('BIG', 60),
      'skills/late-skill/SKILL.md': body('LATE', 30),
      'skills/tiny-skill/SKILL.md': body('TINY', 1),
    });
    // AFTER: the PR grows big-skill to 75 KB. Per-side first-fit now drops late-skill on the
    // after side only (75 + 30 > 100) while before still carries it.
    headSha = commit(repo, { 'skills/big-skill/SKILL.md': body('BIG', 75) });
  });
  afterAll(() => { process.chdir(origCwd); rmSync(repo, { recursive: true, force: true }); });

  it('per-side caps (the old behaviour) bundle late-skill before and not after - the assembly artifact', () => {
    const before = bundleSkillsForPrompt(prompt, baseSha, ['skills']);
    const after = bundleSkillsForPrompt(prompt, headSha, ['skills']);
    expect(before.bundled).toEqual(['big-skill', 'late-skill', 'tiny-skill']);
    expect(after.bundled).toEqual(['big-skill', 'tiny-skill']);
  });

  it('the plan drops late-skill on BOTH sides and keeps the rest', () => {
    const plan = planSkillBundle(prompt, baseSha, prompt, headSha, ['skills']);
    expect([...plan.allow]).toEqual(['big-skill', 'tiny-skill']);
    expect(plan.dropped).toEqual(['late-skill']);
    const before = bundleSkillsForPrompt(prompt, baseSha, ['skills'], plan.allow);
    const after = bundleSkillsForPrompt(prompt, headSha, ['skills'], plan.allow);
    expect(before.bundled).toEqual(after.bundled);
    expect(before.assembled).not.toContain('## Skill: late-skill');
    expect(after.assembled).not.toContain('## Skill: late-skill');
    expect(after.assembled).toContain('## Skill: big-skill');
    expect(after.assembled).toContain('## Skill: tiny-skill');
  });

  it('a skill referenced on one side only still bundles on that side only (a real change)', () => {
    const plan = planSkillBundle('Load `tiny-skill`.', baseSha, 'Load `tiny-skill` and `late-skill`.', headSha, ['skills']);
    expect([...plan.allow].sort()).toEqual(['late-skill', 'tiny-skill']);
    expect(bundleSkillsForPrompt('Load `tiny-skill`.', baseSha, ['skills'], plan.allow).bundled).toEqual(['tiny-skill']);
    expect(bundleSkillsForPrompt('Load `tiny-skill` and `late-skill`.', headSha, ['skills'], plan.allow).bundled).toEqual(['tiny-skill', 'late-skill']);
  });

  it('new file (no before) plans from the after side alone; tokens that resolve nowhere are ignored', () => {
    const plan = planSkillBundle(null, baseSha, 'Use `tiny-skill` and `not-a-skill`.', headSha, ['skills']);
    expect([...plan.allow]).toEqual(['tiny-skill']);
    expect(plan.dropped).toEqual([]);
  });

  it('no skills dir ⇒ empty plan, and bundling without a plan is unchanged', () => {
    expect(planSkillBundle(prompt, baseSha, prompt, headSha, []).allow.size).toBe(0);
    expect(bundleSkillsForPrompt(prompt, headSha, []).assembled).toBe(prompt);
  });
});

describe('assessPipeline - what the action does with the engine stage status', () => {
  it('no pipeline field (older engine) ⇒ nothing changes', () => {
    expect(assessPipeline({})).toEqual({ failed: false, warnings: [] });
    expect(assessPipeline(undefined)).toEqual({ failed: false, warnings: [] });
  });
  it('main failed ⇒ the file is NOT reviewed (no section, no hash stamp)', () => {
    expect(assessPipeline({ pipeline: { coverage: 'ok', enumerate: 'ok', main: 'failed' } }).failed).toBe(true);
  });
  it('a failed supporting stage is a warning, not a failure', () => {
    const r = assessPipeline({ pipeline: { coverage: 'failed', enumerate: 'empty', main: 'ok', customPrinciples: 'failed' } });
    expect(r.failed).toBe(false);
    expect(r.warnings).toEqual(['coverage stage failed; the review ran without it', 'customPrinciples stage failed; the review ran without it']);
  });
  it('all ok / skipped ⇒ clean', () => {
    expect(assessPipeline({ pipeline: { coverage: 'ok', enumerate: 'skipped', main: 'ok', customPrinciples: 'skipped' } })).toEqual({ failed: false, warnings: [] });
  });
});
