import { describe, it, expect } from 'vitest';
import {
  parseAssemblyConfig,
  promptReferencesPath,
  checkRequiredReferences,
  resolveSharedReferences,
  buildSegmentManifest,
  EMPTY_ASSEMBLY_CONFIG,
} from '../src/file-fetcher';

// Build a blob exactly as the bundlers do: main + appended `## Skill:` + `## Reference:`.
const MAIN = '# Role\nYou are an agent.\nFollow rules in `docs/rules/yy.md`.';
const WITH_SKILL = MAIN + `\n\n---\n\n## Skill: xx\n\n` + 'Skill xx line 1\nSkill xx BADLINE here' + '\n';
const BLOB = WITH_SKILL + `\n\n---\n\n## Reference: docs/rules/yy.md\n\n` + 'yy line 1\nyy DANGER line' + '\n';

describe('buildSegmentManifest (provenance: which line is in which file)', () => {
  it('maps each bundled section to the exact blob line where its body begins', () => {
    const segs = buildSegmentManifest(BLOB, 'system-prompt.md', new Set(['xx', 'docs/rules/yy.md']));
    expect(segs).toEqual([
      { source: 'system-prompt.md', kind: 'main', blobStartLine: 1, sourceStartLine: 1 },
      { source: 'xx', kind: 'skill', blobStartLine: 9, sourceStartLine: 1 },
      { source: 'docs/rules/yy.md', kind: 'reference', blobStartLine: 17, sourceStartLine: 1 },
    ]);
    // Independent proof the blobStartLines are right: that line IS each body's first line.
    const lines = BLOB.split('\n');
    expect(lines[9 - 1]).toBe('Skill xx line 1');
    expect(lines[17 - 1]).toBe('yy line 1');
    expect(lines[1 - 1]).toBe('# Role');
  });

  it('ignores a phantom header inside a body that was not actually bundled', () => {
    // A skill body that itself contains text resembling a section header.
    const tricky = MAIN + `\n\n---\n\n## Skill: real\n\n` + 'body\n\n---\n\n## Skill: phantom\n\nnot a real section' + '\n';
    const segs = buildSegmentManifest(tricky, 'system-prompt.md', new Set(['real']));
    expect(segs.map(s => s.source)).toEqual(['system-prompt.md', 'real']);
  });

  it('records the resolved repo PATH in Segment.source when sourcePaths is supplied (G1 parity)', () => {
    // The skill header carries the bare display name `xx`; the bundler-supplied
    // name→path map makes Segment.source the real repo path — matching the
    // Python port so a downstream consumer can re-read source as a file path.
    const segs = buildSegmentManifest(
      BLOB,
      'system-prompt.md',
      new Set(['xx', 'docs/rules/yy.md']),
      { xx: 'backend/app/llm/skills/xx/SKILL.md' },
    );
    expect(segs).toEqual([
      { source: 'system-prompt.md', kind: 'main', blobStartLine: 1, sourceStartLine: 1 },
      { source: 'backend/app/llm/skills/xx/SKILL.md', kind: 'skill', blobStartLine: 9, sourceStartLine: 1 },
      // Reference header is already a path → unchanged by the map.
      { source: 'docs/rules/yy.md', kind: 'reference', blobStartLine: 17, sourceStartLine: 1 },
    ]);
  });
});

describe('parseAssemblyConfig', () => {
  it('parses inject_when_referenced + require_reference', () => {
    const cfg = parseAssemblyConfig(`
# Exception list
inject_when_referenced:
  - backend/docs/rules/agent-security.md
  - backend/docs/rules/error-handling.md

require_reference:
  - file: backend/docs/rules/agent-security.md
    for: "backend/app/llm/**/*prompt*.md"
    severity: critical
`);
    expect(cfg.injectWhenReferenced).toEqual([
      'backend/docs/rules/agent-security.md',
      'backend/docs/rules/error-handling.md',
    ]);
    expect(cfg.requireReference).toHaveLength(1);
    expect(cfg.requireReference[0]).toEqual({
      file: 'backend/docs/rules/agent-security.md',
      for: 'backend/app/llm/**/*prompt*.md',
      severity: 'critical',
    });
  });

  it('strips quotes and trailing comments; defaults severity to critical and for to **', () => {
    const cfg = parseAssemblyConfig(`
inject_when_referenced:
  - 'docs/a.md'   # a shared doc
require_reference:
  - file: docs/a.md
`);
    expect(cfg.injectWhenReferenced).toEqual(['docs/a.md']);
    expect(cfg.requireReference[0]).toEqual({ file: 'docs/a.md', for: '**', severity: 'critical' });
  });

  it('handles multiple require_reference items and suggestion severity', () => {
    const cfg = parseAssemblyConfig(`
require_reference:
  - file: docs/a.md
    for: "**/*.md"
    severity: suggestion
  - file: docs/b.md
    for: "src/**/*prompt*.md"
    severity: critical
`);
    expect(cfg.requireReference).toHaveLength(2);
    expect(cfg.requireReference[0].severity).toBe('suggestion');
    expect(cfg.requireReference[1].file).toBe('docs/b.md');
  });

  it('returns empty config for empty/blank input', () => {
    expect(parseAssemblyConfig('')).toEqual(EMPTY_ASSEMBLY_CONFIG);
    expect(parseAssemblyConfig('   \n  \n')).toEqual(EMPTY_ASSEMBLY_CONFIG);
  });

  it('ignores unknown top-level keys', () => {
    const cfg = parseAssemblyConfig(`
unknown_key:
  - whatever
inject_when_referenced:
  - docs/a.md
`);
    expect(cfg.injectWhenReferenced).toEqual(['docs/a.md']);
  });
});

describe('promptReferencesPath', () => {
  it('matches a repo-relative config path against a shorter in-prompt reference (suffix)', () => {
    const content = 'Follow the shared security rules in `docs/rules/agent-security.md`.';
    expect(promptReferencesPath(content, 'backend/docs/rules/agent-security.md')).toBe(true);
  });

  it('matches the bare basename as a last resort', () => {
    expect(promptReferencesPath('see agent-security.md for details', 'backend/docs/rules/agent-security.md')).toBe(true);
  });

  it('returns false when the prompt does not reference the file', () => {
    expect(promptReferencesPath('no security here', 'backend/docs/rules/agent-security.md')).toBe(false);
  });
});

describe('checkRequiredReferences', () => {
  const cfg = parseAssemblyConfig(`
require_reference:
  - file: backend/docs/rules/agent-security.md
    for: "backend/app/llm/**/*prompt*.md"
    severity: critical
`);

  it('flags a matching prompt that omits the required reference', () => {
    const violations = checkRequiredReferences(
      '# Role\nYou are an agent.\n',
      'backend/app/llm/orchestrator_agent/system-prompt.md',
      cfg,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('backend/docs/rules/agent-security.md');
    expect(violations[0].severity).toBe('critical');
  });

  it('passes a matching prompt that contains the reference', () => {
    const violations = checkRequiredReferences(
      'See `docs/rules/agent-security.md` for the policy.',
      'backend/app/llm/orchestrator_agent/system-prompt.md',
      cfg,
    );
    expect(violations).toHaveLength(0);
  });

  it('does not apply to prompts outside the for-glob', () => {
    const violations = checkRequiredReferences(
      '# unrelated\n',
      'frontend/src/components/Foo.tsx',
      cfg,
    );
    expect(violations).toHaveLength(0);
  });
});

describe('resolveSharedReferences', () => {
  it('is a no-op when no config', () => {
    const r = resolveSharedReferences('content', 'HEAD', EMPTY_ASSEMBLY_CONFIG);
    expect(r).toEqual({ assembled: 'content', injected: [] });
  });

  it('is a no-op when the prompt does not reference any configured file (no git access needed)', () => {
    const cfg = parseAssemblyConfig(`
inject_when_referenced:
  - backend/docs/rules/agent-security.md
`);
    const r = resolveSharedReferences('a prompt with no references', 'HEAD', cfg);
    expect(r.injected).toEqual([]);
    expect(r.assembled).toBe('a prompt with no references');
  });
});
