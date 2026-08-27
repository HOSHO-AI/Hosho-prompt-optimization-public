import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveMergeBase, gitShowFile } from '../src/file-fetcher';
import { fileHash } from '../src/review-state';

// The before-side ref. `pr.base.sha` is the base branch's TIP, which moves under every open PR:
// appsmith-v2's main takes ~36 commits/day, 26 of them in 4 days touching bundled skills. That made
// the before-side content churn for commits the PR never made — busting the dedupe hash (cost) and,
// worse, letting the bot show a PR as reverting an edit someone else landed (correctness).
//
// These run against a REAL git repo in tmp, because merge-base semantics are git's, not ours.

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosho-mergebase-test-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email test@hosho.local', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  return dir;
}

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git add -A', { cwd: repo });
  execSync(`git commit -q -m "${message}"`, { cwd: repo });
  return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
}
const sha = (repo: string, ref: string) =>
  execSync(`git rev-parse ${ref}`, { cwd: repo, encoding: 'utf-8' }).trim();

describe('resolveMergeBase — the divergence point, not the base tip', () => {
  let repo: string;
  let origCwd: string;
  let divergence: string;
  let mainTip: string;
  let headSha: string;

  beforeAll(() => {
    origCwd = process.cwd();
    repo = makeRepo();
    process.chdir(repo);

    // The world the PR branched from.
    divergence = commit(repo, {
      'prompts/agent-prompt.md': 'You are an agent.\n',
      'skills/writer.md': 'Use active voice.\n',
    }, 'base');

    // The PR: edits ONE prompt.
    execSync('git checkout -q -b feature', { cwd: repo });
    headSha = commit(repo, { 'prompts/agent-prompt.md': 'You are a careful agent.\n' }, 'pr edit');

    // Meanwhile main advances — someone else edits a bundled skill and an unrelated prompt.
    execSync('git checkout -q main', { cwd: repo });
    mainTip = commit(repo, {
      'skills/writer.md': 'Use passive voice.\n',
      'prompts/other-prompt.md': 'Unrelated.\n',
    }, 'someone else lands on main');
    execSync('git checkout -q feature', { cwd: repo });
  });

  afterAll(() => {
    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns the divergence commit, not the advanced base tip', () => {
    expect(mainTip).not.toBe(divergence);              // main really did move
    expect(resolveMergeBase(mainTip, headSha)).toBe(divergence);
  });

  it('reads the before-side skill as it was when the PR branched', () => {
    const base = resolveMergeBase(mainTip, headSha);
    expect(gitShowFile(base, 'skills/writer.md')).toBe('Use active voice.\n');
    // The bug: at the base TIP the same read returns someone else's edit, and the review reports a
    // skill change this PR did not make.
    expect(gitShowFile(mainTip, 'skills/writer.md')).toBe('Use passive voice.\n');
  });

  it('keeps the dedupe hash STABLE when main advances but the PR does not — the cost fix', () => {
    const after = gitShowFile(headSha, 'prompts/agent-prompt.md')!;
    const hashAtMergeBase = () =>
      fileHash(gitShowFile(resolveMergeBase(sha(repo, 'main'), headSha), 'skills/writer.md'), after);
    const before = hashAtMergeBase();

    // Main advances again — on MAIN, leaving the feature branch untouched (this is the whole
    // scenario: a push to main, no push to the PR).
    execSync('git checkout -q main', { cwd: repo });
    const newMainTip = commit(repo, { 'skills/writer.md': 'Use whatever voice.\n' }, 'main moves again');
    execSync('git checkout -q feature', { cwd: repo });
    expect(sha(repo, 'main')).toBe(newMainTip);
    expect(newMainTip).not.toBe(mainTip);              // main really moved…
    expect(hashAtMergeBase()).toBe(before);            // …and no re-review is billed

    // Sanity: the old base-tip behaviour WOULD have busted the hash on that same push.
    expect(fileHash(gitShowFile(newMainTip, 'skills/writer.md'), after)).not.toBe(before);
  });

  it('a same-commit PR (no divergence) resolves to that commit', () => {
    expect(resolveMergeBase(divergence, divergence)).toBe(divergence);
  });

  // FAIL OPEN — every failure must return the base tip and restore today's behaviour.
  it('falls back to the base sha when the commits share no history', () => {
    execSync('git checkout -q --orphan detached', { cwd: repo });
    const orphan = commit(repo, { 'x.md': 'x\n' }, 'orphan');
    expect(resolveMergeBase(mainTip, orphan)).toBe(mainTip);
    execSync('git checkout -q feature', { cwd: repo });
  });

  it('falls back to the base sha when a ref does not exist (shallow clone / unfetched base)', () => {
    expect(resolveMergeBase(mainTip, '0'.repeat(40))).toBe(mainTip);
  });
});
