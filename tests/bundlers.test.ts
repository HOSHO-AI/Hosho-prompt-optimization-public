import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { bundleSkillsForPrompt, bundleSiblingsForPrompt } from '../src/file-fetcher';
import { formatBundledFooter } from '../src/output-formatter';

// Build a throwaway git repo in tmp so we can exercise the gitShowFile /
// git ls-tree code paths against real refs. Each test gets a fresh commit
// containing the fixture files it needs.
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosho-bundler-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@hosho.local', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git commit -q --allow-empty -m "init"', { cwd: dir });
  return dir;
}

function writeAndCommit(repo: string, files: Record<string, string>, message = 'fixture') {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git add -A', { cwd: repo });
  execSync(`git commit -q -m "${message}"`, { cwd: repo });
  return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
}

describe('bundleSkillsForPrompt', () => {
  let repo: string;
  let origCwd: string;

  beforeAll(() => {
    origCwd = process.cwd();
    repo = makeRepo();
    process.chdir(repo);
    writeAndCommit(repo, {
      'skills/copy-rules/SKILL.md': 'COPY RULES BODY',
      'skills/design-rules/SKILL.md': 'DESIGN RULES BODY',
      'skills/humanizer.md': 'HUMANIZER BODY',
    });
  });

  afterAll(() => {
    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns input unchanged when skillsDirs is empty', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled, bundled } = bundleSkillsForPrompt('Use `copy-rules`.', sha, []);
    expect(assembled).toBe('Use `copy-rules`.');
    expect(bundled).toEqual([]);
  });

  it('resolves backticked tokens to skill files in skills/<name>/SKILL.md', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled, bundled } = bundleSkillsForPrompt(
      'Use `copy-rules` and `design-rules` here.',
      sha,
      ['skills'],
    );
    expect(bundled.sort()).toEqual(['copy-rules', 'design-rules']);
    expect(assembled).toContain('## Skill: copy-rules');
    expect(assembled).toContain('COPY RULES BODY');
    expect(assembled).toContain('## Skill: design-rules');
    expect(assembled).toContain('DESIGN RULES BODY');
  });

  it('falls back to <name>.md when <name>/SKILL.md does not exist', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled, assembled } = bundleSkillsForPrompt('Use `humanizer`.', sha, ['skills']);
    expect(bundled).toEqual(['humanizer']);
    expect(assembled).toContain('HUMANIZER BODY');
  });

  it('ignores backticked tokens that do not resolve to any skill (no false positives)', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled, assembled } = bundleSkillsForPrompt(
      'Run `bash` or use `edit` and `rounded-lg`.',
      sha,
      ['skills'],
    );
    expect(bundled).toEqual([]);
    expect(assembled).toBe('Run `bash` or use `edit` and `rounded-lg`.');
  });

  it('deduplicates repeated references', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled } = bundleSkillsForPrompt(
      '`copy-rules` then again `copy-rules` and once more `copy-rules`.',
      sha,
      ['skills'],
    );
    expect(bundled).toEqual(['copy-rules']);
  });

  it('supports underscore→hyphen normalisation', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled } = bundleSkillsForPrompt('Use `copy_rules`.', sha, ['skills']);
    expect(bundled).toEqual(['copy_rules']);
  });

  it('searches multiple skillsDirs in order, first match wins', () => {
    const altRepo = makeRepo();
    process.chdir(altRepo);
    writeAndCommit(altRepo, {
      'a/skills/foo/SKILL.md': 'FROM A',
      'b/skills/foo/SKILL.md': 'FROM B',
    });
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled } = bundleSkillsForPrompt('Use `foo`.', sha, ['a/skills', 'b/skills']);
    expect(assembled).toContain('FROM A');
    expect(assembled).not.toContain('FROM B');
    process.chdir(repo);
    rmSync(altRepo, { recursive: true, force: true });
  });

  it('returns original content gracefully when commit ref is invalid', () => {
    const { assembled, bundled } = bundleSkillsForPrompt(
      'Use `copy-rules`.',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ['skills'],
    );
    // gitShowFile returns null on missing refs, so nothing inlined; safe no-op.
    expect(bundled).toEqual([]);
    expect(assembled).toBe('Use `copy-rules`.');
  });
});

describe('bundleSiblingsForPrompt', () => {
  let repo: string;
  let origCwd: string;

  beforeAll(() => {
    origCwd = process.cwd();
    repo = makeRepo();
    process.chdir(repo);
    writeAndCommit(repo, {
      'agents/coding/system-prompt.md': 'SYSTEM PROMPT BODY',
      'agents/coding/user-prompt.md': 'USER PROMPT BODY',
      'agents/coding/user-prompt-nextjs.md': 'NEXTJS USER PROMPT BODY',
      'agents/coding/draft-addendum.md': 'DRAFT ADDENDUM BODY',
      'agents/coding/README.md': 'README — should NOT be bundled',
      'agents/coding/agent.py': 'python — should NOT be bundled',
      'agents/coding/subdir/nested-prompt.md': 'nested — should NOT be bundled (non-recursive)',
    });
  });

  afterAll(() => {
    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns input unchanged when patterns is empty', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled, bundled } = bundleSiblingsForPrompt(
      'SYSTEM PROMPT',
      'agents/coding/system-prompt.md',
      sha,
      [],
    );
    expect(assembled).toBe('SYSTEM PROMPT');
    expect(bundled).toEqual([]);
  });

  it('bundles siblings matching *prompt*.md and *addendum*.md', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled, bundled } = bundleSiblingsForPrompt(
      'SYSTEM PROMPT',
      'agents/coding/system-prompt.md',
      sha,
      ['*prompt*.md', '*addendum*.md'],
    );
    expect(bundled.sort()).toEqual(['draft-addendum.md', 'user-prompt-nextjs.md', 'user-prompt.md']);
    expect(assembled).toContain('## Companion file: user-prompt.md');
    expect(assembled).toContain('USER PROMPT BODY');
    expect(assembled).toContain('NEXTJS USER PROMPT BODY');
    expect(assembled).toContain('DRAFT ADDENDUM BODY');
  });

  it('excludes the prompt being reviewed from its own bundle', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled } = bundleSiblingsForPrompt(
      'SYSTEM PROMPT',
      'agents/coding/system-prompt.md',
      sha,
      ['*prompt*.md'],
    );
    expect(bundled).not.toContain('system-prompt.md');
  });

  it('does not recurse into subdirectories', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled } = bundleSiblingsForPrompt(
      'SYSTEM PROMPT',
      'agents/coding/system-prompt.md',
      sha,
      ['*prompt*.md'],
    );
    expect(bundled).not.toContain('nested-prompt.md');
  });

  it('does not bundle non-matching files (README.md, agent.py)', () => {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { bundled } = bundleSiblingsForPrompt(
      'SYSTEM PROMPT',
      'agents/coding/system-prompt.md',
      sha,
      ['*prompt*.md', '*addendum*.md'],
    );
    expect(bundled).not.toContain('README.md');
    expect(bundled).not.toContain('agent.py');
  });

  it('returns input unchanged when directory has no matching siblings', () => {
    const altRepo = makeRepo();
    process.chdir(altRepo);
    writeAndCommit(altRepo, {
      'solo/system-prompt.md': 'ONLY ONE FILE',
    });
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const { assembled, bundled } = bundleSiblingsForPrompt(
      'ONLY ONE',
      'solo/system-prompt.md',
      sha,
      ['*prompt*.md'],
    );
    expect(bundled).toEqual([]);
    expect(assembled).toBe('ONLY ONE');
    process.chdir(repo);
    rmSync(altRepo, { recursive: true, force: true });
  });

  it('returns input unchanged when commit ref is invalid', () => {
    const { assembled, bundled } = bundleSiblingsForPrompt(
      'TEXT',
      'agents/coding/system-prompt.md',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ['*prompt*.md'],
    );
    expect(bundled).toEqual([]);
    expect(assembled).toBe('TEXT');
  });
});

describe('formatBundledFooter', () => {
  it('returns empty string for undefined or empty map', () => {
    expect(formatBundledFooter()).toBe('');
    expect(formatBundledFooter(new Map())).toBe('');
  });

  it('returns empty string when all entries have zero bundled content', () => {
    const m = new Map([['file.md', { skills: [], siblings: [] }]]);
    expect(formatBundledFooter(m)).toBe('');
  });

  it('formats a single-file single-skill footer inline (no paperclip emoji)', () => {
    const m = new Map([['a.md', { skills: ['copy-rules'], siblings: [] }]]);
    const out = formatBundledFooter(m);
    expect(out).toContain('copy-rules');
    expect(out).toContain('1 skill');
    expect(out).toContain('Bundled review context');
    expect(out).not.toContain('📎');
  });

  it('writes out all skill names (no "+N more" cap)', () => {
    const skills = Array.from({ length: 12 }, (_, i) => `skill${i}`);
    const m = new Map([['a.md', { skills, siblings: [] }]]);
    const out = formatBundledFooter(m);
    expect(out).not.toContain('more');
    expect(out).toContain('skill0');
    expect(out).toContain('skill11');
    expect(out).toContain('12 skills');
  });

  it('renders multi-file footers with per-file lines', () => {
    const m = new Map([
      ['a.md', { skills: ['copy-rules'], siblings: [] }],
      ['b.md', { skills: [], siblings: ['user-prompt.md'] }],
    ]);
    const out = formatBundledFooter(m);
    expect(out).toContain('`a.md`');
    expect(out).toContain('`b.md`');
    expect(out).toContain('1 skill');
    expect(out).toContain('1 sibling');
  });
});
