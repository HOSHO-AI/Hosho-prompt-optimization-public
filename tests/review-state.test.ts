import { describe, it, expect } from 'vitest';
import { fileHash, wrapSection, parseSections, partitionByHash } from '../src/review-state';
import { formatPRComment } from '../src/output-formatter';
import { ComparisonResult } from '../src/types';

// Content-hash dedupe. The measured problem: appsmith-v2 billed 1,688 reviews in 8 days for 30 real
// prompt changes (17.8x), because `synchronize` re-fires on every push and GitHub applies the
// workflow `paths` filter to the PR's WHOLE diff. These tests lock the two properties that make the
// fix safe: the hash must move when anything we send moves, and every ambiguity must FAIL OPEN.

const A = 'You are an agent.\nDo the thing.\n';
const B = 'You are an agent.\nDo the thing differently.\n';

describe('fileHash', () => {
  it('is stable across calls for the same content pair', () => {
    expect(fileHash(A, B)).toBe(fileHash(A, B));
  });

  it('changes when the AFTER side changes', () => {
    expect(fileHash(A, B)).not.toBe(fileHash(A, B + 'x'));
  });

  it('changes when the BEFORE side changes — main advancing under the PR is a real diff change', () => {
    expect(fileHash(A, B)).not.toBe(fileHash(A + 'x', B));
  });

  it('distinguishes a new file (before=null) from an empty before', () => {
    expect(fileHash(null, B)).toBe(fileHash('', B)); // both empty-string semantics
    expect(fileHash(null, B)).not.toBe(fileHash(B, B));
  });

  it('cannot be fooled by moving content across the before/after boundary', () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide and a real edit would be skipped.
    expect(fileHash('ab', 'c')).not.toBe(fileHash('a', 'bc'));
  });

  it('changes when a bundled SKILL changes — the assembled content is what is hashed', () => {
    // The caller hashes apiFiles[].after, which is post-bundling. Simulate a skill body changing
    // inside the assembled text: this MUST bust the hash or a changed skill is silently skipped —
    // the one failure mode that costs the customer quality rather than costing us money.
    const withSkillV1 = `${B}\n## Skill: writer\nAlways use active voice.\n`;
    const withSkillV2 = `${B}\n## Skill: writer\nAlways use passive voice.\n`;
    expect(fileHash(A, withSkillV1)).not.toBe(fileHash(A, withSkillV2));
  });

  it('changes when a bundled SIBLING changes', () => {
    const withSiblingV1 = `${B}\n## Companion file: user-prompt.md\nSummarise.\n`;
    const withSiblingV2 = `${B}\n## Companion file: user-prompt.md\nSummarise briefly.\n`;
    expect(fileHash(A, withSiblingV1)).not.toBe(fileHash(A, withSiblingV2));
  });
});

describe('wrapSection / parseSections round-trip', () => {
  const sha = fileHash(A, B);

  it('recovers path, sha and the rendered markdown', () => {
    const body = `<!-- prompt-factor-reviewer-api -->\n` +
      wrapSection('backend/app/llm/coding/system-prompt.md', sha, '### coding\n\nverdict here\n');
    const got = parseSections(body);
    expect(got.size).toBe(1);
    const s = got.get('backend/app/llm/coding/system-prompt.md')!;
    expect(s.sha).toBe(sha);
    expect(s.markdown).toContain('verdict here');
  });

  it('recovers several files in one comment', () => {
    const body = wrapSection('a/one-prompt.md', fileHash(A, A), 'A\n') +
                 wrapSection('b/two-prompt.md', fileHash(B, B), 'B\n');
    const got = parseSections(body);
    expect([...got.keys()]).toEqual(['a/one-prompt.md', 'b/two-prompt.md']);
  });

  // FAIL-OPEN cases: every one of these must yield "no usable state" so the file is re-reviewed.
  it('returns empty for a missing body', () => {
    expect(parseSections(undefined).size).toBe(0);
    expect(parseSections('').size).toBe(0);
  });

  it('drops a section whose closing delimiter was lost to comment truncation', () => {
    const full = wrapSection('a/one-prompt.md', fileHash(A, B), 'A'.repeat(500));
    const truncated = full.slice(0, full.length - 40); // 65k limit ate the tail
    expect(parseSections(truncated).size).toBe(0);
  });

  it('ignores a malformed sha', () => {
    expect(parseSections('<!-- hosho-file "x-prompt.md" notasha -->\nmd\n<!-- /hosho-file -->\n').size).toBe(0);
  });
});

describe('partitionByHash', () => {
  const files = [
    { path: 'p/a-prompt.md', before: A, after: B },
    { path: 'p/b-prompt.md', before: A, after: A },
  ];

  it('first run (no prior state) reviews everything', () => {
    const r = partitionByHash(files, new Map());
    expect(r.changed).toHaveLength(2);
    expect(r.unchanged).toHaveLength(0);
  });

  it('skips only the files whose content pair is unchanged', () => {
    const carried = new Map([
      ['p/a-prompt.md', { sha: fileHash(A, B), markdown: 'a' }],
      ['p/b-prompt.md', { sha: 'stale'.padEnd(64, '0'), markdown: 'b' }],
    ]);
    const r = partitionByHash(files, carried);
    expect(r.changed.map(f => f.path)).toEqual(['p/b-prompt.md']);
    expect(r.unchanged.map(f => f.path)).toEqual(['p/a-prompt.md']);
  });

  it('force (slash command / dedupe:false) reviews everything regardless of state', () => {
    const carried = new Map(files.map(f => [f.path, { sha: fileHash(f.before, f.after), markdown: '' }]));
    expect(partitionByHash(files, carried).changed).toHaveLength(0);       // would skip…
    expect(partitionByHash(files, carried, true).changed).toHaveLength(2); // …but force overrides
  });
});

describe('partial re-review keeps the comment whole', () => {
  // Minimal-but-valid comparison: formatPRFileSection walks synthesis.factorInsights, so the mock
  // must carry that shape (a thinner stub throws inside mergeFindings).
  const mk = (path: string): ComparisonResult => ({
    promptFile: path,
    isNewFile: false,
    synthesis: {
      promptName: path.split('/').pop()!,
      promptFile: path,
      promptDescription: 'test',
      overallScore: 'Good',
      hasCriticalIssues: false,
      factorInsights: [{ factorId: 'scope', factorName: 'Scope', score: 9, scoreLabel: 'Excellent', findings: [] }],
    } as never,
    factorResults: [],
    deltas: [],
    hasRegression: false,
    hasCriticalIssue: false,
  });

  it('renders the fresh file AND carries the untouched one forward, with a truthful header', () => {
    const carried = new Map([['p/old-prompt.md', { sha: 'a'.repeat(64), markdown: '### old\n\nPREVIOUS VERDICT\n' }]]);
    const body = formatPRComment([mk('p/new-prompt.md')], 42, 'org/repo', undefined, {
      order: ['p/new-prompt.md', 'p/old-prompt.md'],
      carried,
      hashes: new Map([['p/new-prompt.md', 'b'.repeat(64)]]),
    });
    // nothing disappeared…
    expect(body).toContain('PREVIOUS VERDICT');
    // …the header counts BOTH files, not just the one re-reviewed…
    expect(body).toContain('2 prompt changes');
    // …and both sections carry state for the next run.
    const round = parseSections(body);
    expect([...round.keys()].sort()).toEqual(['p/new-prompt.md', 'p/old-prompt.md']);
    expect(round.get('p/old-prompt.md')!.sha).toBe('a'.repeat(64));
  });

  it('a normal full run still emits parseable state for every file', () => {
    const body = formatPRComment([mk('p/one-prompt.md'), mk('p/two-prompt.md')], 7, 'org/repo', undefined, {
      order: ['p/one-prompt.md', 'p/two-prompt.md'],
      carried: new Map(),
      hashes: new Map([['p/one-prompt.md', 'c'.repeat(64)], ['p/two-prompt.md', 'd'.repeat(64)]]),
    });
    expect(parseSections(body).size).toBe(2);
  });

  it('without carry (pre-dedupe callers) renders as before and emits no state', () => {
    const body = formatPRComment([mk('p/one-prompt.md')], 7, 'org/repo');
    expect(body).toContain('Hosho PR Review');
    expect(parseSections(body).size).toBe(0);
  });
});
