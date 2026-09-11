import { describe, it, expect } from 'vitest';
import { formatReviewComment } from '../src/output-formatter';
import { parseSections, parseStateBlock } from '../src/review-state';
import type { ComparisonResult, ChangeItem } from '../src/api-client';

// The PR bot's "SUGGESTED FIXES BEFORE MERGING" block is collapsed into <details> (2026-09-11).
// Measured on 14 real comments on appsmithorg/kite: that section is 30% of the bytes and collapsing
// it hides 53% of every line a reviewer scrolls past (11,705 -> 5,445). Improve mode is deliberately
// NOT collapsed - see the two "without details" assertions in output-formatter.test.ts.
//
// The load-bearing properties, each of which was a real way to break this:
//  - open and close tags in the SAME file section, so composeComment's tail truncation cannot
//    orphan an unclosed <details>;
//  - the block sits INSIDE the <!-- hosho-file --> fence, so an unchanged file's section - which is
//    re-emitted verbatim from the previous comment - keeps its own toggle;
//  - parseSections/parseStateBlock still round-trip a comment containing it.

const fix = (over: Partial<ChangeItem> = {}): ChangeItem => ({
  change: 'Removed the preservation rules',
  impact: 'lost constraints',
  effect: 'negative',
  severity: 'suggestion',
  revert: 'Restore the §4 preservation constraints',
  revertDetail: {
    currentCode: '### Pre-submission checklist:\n1. Verify assets',
    startLine: 100,
    endLine: 106,
    suggestedFix: 'Re-add the three preservation rules as a standalone section.',
    rewrittenCode: '## 4) Preservation rules\n- keep the header',
  },
  ...over,
} as ChangeItem);

const comp = (changeSummary: ChangeItem[], promptFile = 'prompts/a.md'): ComparisonResult => ({
  promptFile,
  isNewFile: false,
  diffSnippet: '-old line\n+new line',
  changeSummary,
  synthesis: { promptName: promptFile, promptFile, overallScore: 'N/A', factorInsights: [] },
} as unknown as ComparisonResult);

describe('review comment - suggested fixes are collapsed', () => {
  it('wraps the fixes in exactly one balanced <details> and names the count', () => {
    const md = formatReviewComment([comp([fix(), fix({ revertDetail: { ...fix().revertDetail!, startLine: 200, endLine: 200 } })])], 42, 'org/repo');
    expect((md.match(/<details>/g) || []).length).toBe(1);
    expect((md.match(/<\/details>/g) || []).length).toBe(1);
    expect(md).toContain('<summary><b>Suggested fixes before merging (2)</b></summary>');
    expect(md).not.toContain('### SUGGESTED FIXES BEFORE MERGING');
  });

  it('reads naturally for a single fix', () => {
    const md = formatReviewComment([comp([fix()])], 42, 'org/repo');
    expect(md).toContain('<summary><b>Suggested fix before merging (1)</b></summary>');
  });

  it('keeps the fix content intact inside the block - nothing is dropped by collapsing', () => {
    const md = formatReviewComment([comp([fix()])], 42, 'org/repo');
    const inner = md.slice(md.indexOf('<details>'), md.indexOf('</details>'));
    expect(inner).toContain('Restore the §4 preservation constraints');
    expect(inner).toContain('**Problematic text:**');
    expect(inner).toContain('### Pre-submission checklist:');
    expect(inner).toContain('**Suggested fix:**');
    expect(inner).toContain('## 4) Preservation rules');
    expect(inner).toContain('*(line 100-106)*');
  });

  it('emits a blank line after </summary> so stricter renderers still parse the fences', () => {
    const md = formatReviewComment([comp([fix()])], 42, 'org/repo');
    expect(md).toContain('</summary>\n\n');
  });

  it('a file with no fixes emits no <details> at all', () => {
    const md = formatReviewComment([comp([{ change: 'Added XML tags', impact: 'clearer', effect: 'positive' } as ChangeItem])], 42, 'org/repo');
    expect(md).not.toContain('<details>');
    expect(md).toContain('**Verdict:**');
  });

  // The <!-- hosho-file --> fences only appear when a carry supplies the per-file hashes, which is
  // what src/index.ts always does. Without it parseSections returns nothing and any assertion that
  // loops over sections passes vacuously - so these two build the production shape explicitly.
  const carryFor = (paths: string[]) => ({
    order: paths,
    carried: new Map<string, { sha: string; markdown: string }>(),
    hashes: new Map(paths.map((p, i) => [p, String(i + 1).repeat(64).slice(0, 64)])),
  });

  it('open and close live in the SAME file section, so truncation cannot orphan the tag', () => {
    const paths = ['prompts/a.md', 'prompts/b.md'];
    const md = formatReviewComment([comp([fix()], paths[0]), comp([fix()], paths[1])], 42, 'org/repo', undefined, carryFor(paths));
    const secs = parseSections(md);
    expect([...secs.keys()].sort()).toEqual(paths);
    for (const [, sec] of secs) {
      expect(sec.markdown).toContain('<details>');
      expect((sec.markdown.match(/<details>/g) || []).length).toBe((sec.markdown.match(/<\/details>/g) || []).length);
    }
  });

  it('the carry parser still round-trips a comment containing the block', () => {
    const md = formatReviewComment([comp([fix()])], 42, 'org/repo', undefined, carryFor(['prompts/a.md']));
    const secs = parseSections(md);
    expect([...secs.keys()]).toEqual(['prompts/a.md']);
    expect(parseStateBlock(md)?.size).toBe(1);
    // …and re-emitting that carried markdown parses again, which is exactly what an UNCHANGED file
    // does on the next push: its section is spliced back in verbatim, collapsible and all.
    const sha = secs.get('prompts/a.md')!.sha;
    const reemitted = `<!-- prompt-factor-reviewer-api -->\n<!-- hosho-state v1 {"prompts/a.md":"${sha}"} -->\n<!-- hosho-file "prompts/a.md" ${sha} -->\n${secs.get('prompts/a.md')!.markdown}<!-- /hosho-file -->\n`;
    const again = parseSections(reemitted).get('prompts/a.md');
    expect(again?.sha).toBe(sha);
    expect(again?.markdown).toContain('<details>');
  });
});
