import { describe, it, expect } from 'vitest';
import {
  fileHash, wrapSection, parseSections, partitionByHash,
  renderStateBlock, parseStateBlock, readPriorState,
} from '../src/review-state';
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
      ['p/a-prompt.md', fileHash(A, B)],
      ['p/b-prompt.md', 'stale'.padEnd(64, '0')],
    ]);
    const r = partitionByHash(files, carried);
    expect(r.changed.map(f => f.path)).toEqual(['p/b-prompt.md']);
    expect(r.unchanged.map(f => f.path)).toEqual(['p/a-prompt.md']);
  });

  it('force (slash command / dedupe:false) reviews everything regardless of state', () => {
    const carried = new Map(files.map(f => [f.path, fileHash(f.before, f.after)]));
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

// ── Truncation ────────────────────────────────────────────────────────────────────────────
// The defect these lock, measured live: PR #17312 (67,825 B) and #17467 (66,365 B) both carry the
// `Comment truncated` marker with ELEVEN `hosho-file` openers and TEN closers. The tail section was
// cut mid-way, its state was unreadable, and that file re-billed a full review on every push —
// forever, because the re-review landed in the same tail position and was cut again.
describe('state block survives what the inline delimiters cannot', () => {
  const shas = new Map([['a/one-prompt.md', 'a'.repeat(64)], ['b/two-prompt.md', 'b'.repeat(64)]]);

  it('round-trips every path/sha pair', () => {
    expect(parseStateBlock(renderStateBlock(shas))).toEqual(shas);
  });

  it('stays a rounding error against the 65,000-char budget at appsmith scale', () => {
    // 21 files is the widest real PR observed (#17312). Realistic path lengths; the sha is the
    // irreducible 64 chars. If this block could itself overflow, the fix would be circular.
    const many = new Map(Array.from({ length: 21 }, (_, i) =>
      [`backend/app/llm/agents/agent-${i}/system-prompt.md`, String(i % 10).repeat(64)]));
    const block = renderStateBlock(many);
    expect(block.length).toBeLessThan(3_000);          // ~2.5 KB — under 5% of the budget
    expect(parseStateBlock(block).size).toBe(21);      // and still fully readable at that size
  });

  it('renders nothing when there is no state (pre-dedupe callers stay byte-identical)', () => {
    expect(renderStateBlock(new Map())).toBe('');
  });

  it('survives a truncation that destroys every inline section', () => {
    const body = `<!-- prompt-factor-reviewer-api -->\n${renderStateBlock(shas)}## Header\n` +
      wrapSection('a/one-prompt.md', 'a'.repeat(64), 'A'.repeat(400)) +
      wrapSection('b/two-prompt.md', 'b'.repeat(64), 'B'.repeat(400));
    const truncated = body.slice(0, 300); // cuts deep into the first section

    expect(parseSections(truncated).size).toBe(0);            // markdown is genuinely gone…
    expect(parseStateBlock(truncated)).toEqual(shas);         // …but the skip decision is intact
  });

  // FAIL OPEN — a state block we cannot trust must mean "review everything", never a guess.
  it('yields nothing for a malformed or absent block', () => {
    expect(parseStateBlock(undefined).size).toBe(0);
    expect(parseStateBlock('<!-- hosho-state v1 {not json} -->').size).toBe(0);
    expect(parseStateBlock('<!-- hosho-state v1 {"p":"tooshort"} -->').size).toBe(0);
    expect(parseStateBlock('<!-- hosho-state v2 {"p":"' + 'a'.repeat(64) + '"} -->').size).toBe(0);
  });
});

describe('readPriorState', () => {
  it('reads shas from the top block and markdown from the sections', () => {
    const sha = 'c'.repeat(64);
    const body = renderStateBlock(new Map([['p/x-prompt.md', sha]])) +
      wrapSection('p/x-prompt.md', sha, 'VERDICT\n');
    const { shas, sections } = readPriorState(body);
    expect(shas.get('p/x-prompt.md')).toBe(sha);
    expect(sections.get('p/x-prompt.md')!.markdown).toBe('VERDICT\n');
  });

  it('falls back to inline shas for comments written before the block shipped', () => {
    // Without this every existing customer PR pays one full re-review the day this deploys.
    const sha = 'd'.repeat(64);
    const { shas } = readPriorState(wrapSection('p/x-prompt.md', sha, 'old\n'));
    expect(shas.get('p/x-prompt.md')).toBe(sha);
  });

  it('prefers the top block when a section disagrees (the block is authoritative)', () => {
    const body = renderStateBlock(new Map([['p/x-prompt.md', 'e'.repeat(64)]])) +
      wrapSection('p/x-prompt.md', 'f'.repeat(64), 'stale\n');
    expect(readPriorState(body).shas.get('p/x-prompt.md')).toBe('e'.repeat(64));
  });
});

describe('a comment that overflows GitHub stays complete where it counts', () => {
  // A file whose rendered verdict is genuinely large — 21 of these is how #17312 reached 67,825 B.
  const fat = (path: string): ComparisonResult => ({
    promptFile: path,
    isNewFile: false,
    synthesis: {
      promptName: path.split('/').pop()!, promptFile: path, promptDescription: 'x'.repeat(2_000),
      overallScore: 'Good', hasCriticalIssues: false,
      factorInsights: [{
        factorId: 'scope', factorName: 'Scope', score: 5, scoreLabel: 'Needs Work',
        findings: Array.from({ length: 14 }, (_, i) => ({
          title: `Finding ${i} ${'y'.repeat(200)}`, description: 'z'.repeat(600), severity: 'suggestion',
        })),
      }],
    } as never,
    factorResults: [], deltas: [], hasRegression: false, hasCriticalIssue: false,
  });

  const paths = Array.from({ length: 25 }, (_, i) => `backend/app/llm/agents/agent-${i}/system-prompt.md`);
  const hashes = new Map(paths.map((p, i) => [p, String(i % 10).repeat(64)]));
  const body = formatPRComment(paths.map(fat), 17312, 'appsmithorg/appsmith-v2', undefined, {
    order: paths, carried: new Map(), hashes,
  });

  it('the fixture genuinely overflows — otherwise this suite proves nothing', () => {
    // formatPRComment now always fits, so "did it overflow?" is read from the evidence it leaves:
    // sections were dropped and the marker was emitted.
    expect(body).toContain('**Comment truncated.**');
    expect(parseSections(body).size).toBeLessThan(paths.length);
    // And the raw material really was oversized: what survived is at the budget, not merely short.
    expect(body.length).toBeGreaterThan(60_000);
  });

  it('lands INSIDE GitHub\'s hard limit, footer and sign-off included', () => {
    // The old code truncated and THEN appended the footer, which is why both live comments measured
    // over the cap despite carrying the truncation marker.
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('*Hosho Bot*');
  });

  it('carries state for EVERY file, including the ones truncation dropped', () => {
    // This is the leak: a dropped file used to lose its state and re-bill on every push, forever.
    expect(parseStateBlock(body)).toEqual(hashes);
    expect(parseStateBlock(body).size).toBe(25);
  });

  it('leaves no half-written section behind — every surviving opener has its closer', () => {
    const openers = [...body.matchAll(/<!--\s*hosho-file\s/g)].length;
    const closers = [...body.matchAll(/<!-- \/hosho-file -->/g)].length;
    expect(openers).toBe(closers);                    // #17312 measured 11 vs 10
    expect(parseSections(body).size).toBe(openers);   // and every one is recoverable
  });

  it('names what it omitted rather than trailing off mid-sentence', () => {
    expect(body).toContain('**Comment truncated.**');
    expect(body).toMatch(/file\(s\) omitted here/);
    expect(body).toContain(paths[paths.length - 1]);  // the dropped tail file is named
  });

  it('re-renders an unchanged-but-dropped file as a placeholder, not a silent hole', () => {
    // Next push: the state block says these are unchanged (so no API call), but their markdown was
    // truncated away last time and cannot be carried. The file must still appear.
    const survived = parseSections(body);
    const droppedPath = paths.find(p => !survived.has(p))!;
    expect(droppedPath).toBeDefined();
    const next = formatPRComment([], 17312, 'appsmithorg/appsmith-v2', undefined, {
      order: paths, carried: survived, hashes,
    });
    expect(next).toContain(droppedPath);
    expect(next).toContain('Unchanged since the last review');
    expect(parseStateBlock(next).get(droppedPath)).toBe(hashes.get(droppedPath));
  });
});
