import { describe, it, expect } from 'vitest';
import { parseModelsConfig, resolveModel } from '../src/models-config';

// Deterministic per-prompt model resolution from .github/hosho/models.md (a markdown table Hosho
// reads EXACTLY) — replaces the LLM fuzzy-match that drifted and mis-scored a prompt's provider.
// Pins: markdown-table parsing (first row = header, `| --- |` separator, prose all skipped), parse
// tolerance (bad rows skipped, never thrown), family/class validation, most-specific-glob-wins.

/** Wrap data rows in a canonical models.md table (heading + header + separator). */
const TABLE = (rows: string) => `# Models — which model each prompt runs on

| Prompt path (glob) | Model |
| --- | --- |
${rows}
`;

describe('parseModelsConfig — markdown table', () => {
  it('parses | glob | family/class | rows, defaults class to standard, ignores prose + header', () => {
    const { rules, warnings } = parseModelsConfig(
      TABLE(`| \`agents/router/**\` | openai/reasoning |
| \`agents/summarizer/**\` | gemini |
| \`**/*prompt*.md\` | Claude |`),
    );
    expect(warnings).toEqual([]);
    expect(rules).toEqual([
      { glob: 'agents/router/**', family: 'openai', modelClass: 'reasoning' },
      { glob: 'agents/summarizer/**', family: 'gemini', modelClass: 'standard' },
      { glob: '**/*prompt*.md', family: 'claude', modelClass: 'standard' }, // family lowercased
    ]);
  });

  it('skips (does not throw on) unknown families, bad classes, and malformed rows — with warnings', () => {
    const { rules, warnings } = parseModelsConfig(
      TABLE(`| \`a/**\` | mistral |
| \`b/**\` | openai/turbo |
| \`c/**\` |
| \`d/**\` | gemini |`),
    );
    expect(rules).toEqual([{ glob: 'd/**', family: 'gemini', modelClass: 'standard' }]);
    expect(warnings).toHaveLength(3); // unknown family, bad class, malformed one-column row
    expect(warnings.join(' ')).toMatch(/mistral/);
    expect(warnings.join(' ')).toMatch(/turbo/);
  });

  it('ignores prose and HTML comments around the table, and strips backtick/quote wrapping', () => {
    const { rules } = parseModelsConfig(`Some intro prose about our models — no pipes, ignored.

| Path | Model |
|------|-------|
| "x/**" | qwen |

<!-- a trailing note, also ignored -->`);
    expect(rules).toEqual([{ glob: 'x/**', family: 'qwen', modelClass: 'standard' }]);
  });
});

describe('resolveModel — most-specific glob wins', () => {
  const { rules } = parseModelsConfig(
    TABLE(`| \`**/*.md\` | gemini |
| \`agents/**\` | openai |
| \`agents/router/**\` | openai/reasoning |`),
  );

  it('picks the longest literal-prefix match, regardless of row order', () => {
    // router matches all three; the most specific (longest literal prefix) wins.
    expect(resolveModel('agents/router/system-prompt.md', rules)).toEqual({
      family: 'openai',
      modelClass: 'reasoning',
    });
    // under agents/ but not router → the agents/** rule.
    expect(resolveModel('agents/summarizer/system-prompt.md', rules)).toEqual({
      family: 'openai',
      modelClass: 'standard',
    });
    // a stray top-level .md → only the catch-all matches.
    expect(resolveModel('docs/notes.md', rules)).toEqual({ family: 'gemini', modelClass: 'standard' });
  });

  it('returns null when nothing matches (falls back to the existing inference)', () => {
    expect(resolveModel('src/app.ts', parseModelsConfig(TABLE('| `prompts/**` | claude |')).rules)).toBeNull();
  });

  it('matches dotfile paths (dot:true)', () => {
    expect(
      resolveModel('.github/hosho/x-prompt.md', parseModelsConfig(TABLE('| `**/*prompt*.md` | kimi |')).rules),
    ).toEqual({ family: 'kimi', modelClass: 'standard' });
  });
});
