import { describe, it, expect } from 'vitest';
import { resolveTemplateVariables } from '../src/file-fetcher';

// M1: stripping {# #} comments must NOT shift line numbers, or the provenance
// manifest (main segment is 1:1) makes the engine mis-cite findings for any
// prompt that has both {# #} comments and {{ }} placeholders (e.g. appsmith
// user-prompts). A bogus commit sha means no {{ }} resolves to a companion file,
// so only the comment-strip path runs — exactly the case that fires in practice.
describe('resolveTemplateVariables — line-count preservation (M1)', () => {
  it('blanks a single-line {# #} comment without shifting later lines', () => {
    const content = [
      'line 1',
      '{# a jinja comment #}',
      'line 3 uses {{ runtime_var }}',
      'line 4',
    ].join('\n');
    const out = resolveTemplateVariables(content, 'agents/x/user-prompt.md', 'deadbeef', []);
    expect(out.split('\n').length).toBe(content.split('\n').length); // line count preserved
    expect(out).not.toContain('jinja comment');                      // comment removed
    expect(out.split('\n')[2]).toContain('{{ runtime_var }}');       // runtime var untouched, same line
    expect(out.split('\n')[3]).toBe('line 4');                       // downstream line unshifted
  });

  it('preserves line count for a multi-line {# #} comment', () => {
    const content = 'a\n{# multi\nline\ncomment #}\nb {{ v }}\nc';
    const out = resolveTemplateVariables(content, 'agents/x/user-prompt.md', 'deadbeef', []);
    expect(out.split('\n').length).toBe(content.split('\n').length);
    expect(out).not.toContain('comment');
    expect(out.split('\n').at(-1)).toBe('c');
  });

  it('returns content unchanged when there are no {{ }} placeholders', () => {
    const content = 'just text\n{# a comment #}\nmore text';
    // No {{ }} → early return, content (incl. comment) returned verbatim.
    expect(resolveTemplateVariables(content, 'agents/x/user-prompt.md', 'deadbeef', [])).toBe(content);
  });
});
