import { describe, it, expect } from 'vitest';
import { parseModelsConfig, resolveModel } from '../src/models-config';

// Deterministic per-prompt model resolution from .github/hosho/models.yaml — replaces the LLM
// fuzzy-match that drifted and mis-scored a prompt's provider. Pins: parse tolerance (bad lines
// skipped, never thrown), family/class validation, and most-specific-glob-wins resolution.

describe('parseModelsConfig', () => {
  it('parses "glob": family/class, defaults class to standard', () => {
    const { rules, warnings } = parseModelsConfig(`
      # models for our repo
      "backend/app/llm/orchestrator_agent/**": openai/reasoning
      "backend/app/llm/brand_analyzer_agent/**": gemini
      "**/*prompt*.md": Claude
    `);
    expect(warnings).toEqual([]);
    expect(rules).toEqual([
      { glob: 'backend/app/llm/orchestrator_agent/**', family: 'openai', modelClass: 'reasoning' },
      { glob: 'backend/app/llm/brand_analyzer_agent/**', family: 'gemini', modelClass: 'standard' },
      { glob: '**/*prompt*.md', family: 'claude', modelClass: 'standard' }, // family lowercased
    ]);
  });

  it('skips (does not throw on) unknown families, bad classes, and junk — with warnings', () => {
    const { rules, warnings } = parseModelsConfig(`
      "a/**": mistral
      "b/**": openai/turbo
      this is not a rule
      "c/**": gemini
    `);
    expect(rules).toEqual([{ glob: 'c/**', family: 'gemini', modelClass: 'standard' }]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/mistral/);
    expect(warnings.join(' ')).toMatch(/turbo/);
  });

  it('ignores YAML scaffolding headers (version/defaults/models)', () => {
    const { rules } = parseModelsConfig(`version: 1\ndefaults:\nmodels:\n"x/**": qwen`);
    expect(rules).toEqual([{ glob: 'x/**', family: 'qwen', modelClass: 'standard' }]);
  });
});

describe('resolveModel — most-specific glob wins', () => {
  const { rules } = parseModelsConfig(`
    "**/*.md": gemini
    "backend/app/llm/**": openai
    "backend/app/llm/orchestrator_agent/**": openai/reasoning
  `);

  it('picks the longest literal-prefix match, regardless of file order', () => {
    // orchestrator matches all three; the most specific (longest literal prefix) wins.
    expect(resolveModel('backend/app/llm/orchestrator_agent/system-prompt.md', rules)).toEqual({
      family: 'openai',
      modelClass: 'reasoning',
    });
    // under /llm/ but not orchestrator → the /llm/** rule.
    expect(resolveModel('backend/app/llm/content_agent/system-prompt.md', rules)).toEqual({
      family: 'openai',
      modelClass: 'standard',
    });
    // a stray top-level .md → only the catch-all matches.
    expect(resolveModel('docs/notes.md', rules)).toEqual({ family: 'gemini', modelClass: 'standard' });
  });

  it('returns null when nothing matches (falls back to the existing inference)', () => {
    expect(resolveModel('src/app.ts', parseModelsConfig('"prompts/**": claude').rules)).toBeNull();
  });

  it('matches dotfiles paths (dot:true)', () => {
    expect(resolveModel('.github/hosho/x-prompt.md', parseModelsConfig('"**/*prompt*.md": kimi').rules)).toEqual({
      family: 'kimi',
      modelClass: 'standard',
    });
  });
});
