// Deterministic per-prompt model resolution from a customer-maintained `.github/hosho/models.md`.
//
// Why: today, in CI, a prompt's target model is INFERRED — the Lambda hands the whole architecture
// prose doc to Haiku and asks it to fuzzy-match each changed path to a "- Model: …" line. That
// drifts (a real incident: a prompt reviewed as the wrong provider because the prose lagged the
// code), collides (every agent's file is `system-prompt.md`), and silently degrades to "model-fit
// N/A" on any failure. A customer file that maps path globs → {family, class} makes it exact: no
// LLM, no fuzzy matching, no silent drop.
//
// The file is a MARKDOWN doc (same `.md` convention as the customer's architecture doc, e.g.
// Kite_prompt_chain.md) with a table Hosho reads EXACTLY — never fed to an LLM. Each data row is
// `| <path-glob> | <family>[/<class>] |`:
//
//   # Models — which model each prompt runs on
//   | Prompt path (glob)   | Model            |
//   | -------------------- | ---------------- |
//   | `agents/router/**`   | openai/reasoning |
//   | `agents/**`          | claude           |
//   | `**/*prompt*.md`     | gemini            |
//
// Most-specific match wins (the rule with the longest literal, non-wildcard prefix), so order in
// the file doesn't matter. family must be one of the seven the scorer knows; class defaults to
// standard. Anything malformed is skipped with a warning, never throws — a bad file degrades to
// today's inference, it never fails the run. Any path the table doesn't cover falls through to that
// inference too, so the table is a pure overlay.

import { minimatch } from 'minimatch';

export const MODEL_FAMILIES = ['claude', 'openai', 'gemini', 'deepseek', 'qwen', 'kimi', 'glm'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export type ModelClass = 'standard' | 'reasoning';

export interface ModelRule {
  glob: string;
  family: ModelFamily;
  modelClass: ModelClass;
}

export interface ResolvedModel {
  family: ModelFamily;
  modelClass: ModelClass;
}

function stripComment(text: string): string {
  // Drop a trailing `# comment`. Globs and family names never contain `#`, so this is safe.
  const hash = text.indexOf('#');
  return hash === -1 ? text : text.slice(0, hash);
}

function isFamily(v: string): v is ModelFamily {
  return (MODEL_FAMILIES as readonly string[]).includes(v);
}

/** Split one markdown-table row into trimmed cells, dropping the outer pipes. */
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** A markdown separator row: every cell is dashes with optional alignment colons (`| --- | :--: |`). */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * Parse the file's markdown table into rules. Never throws — malformed rows are collected into
 * `warnings` and skipped, so a typo can't break the whole review. Prose, headings and HTML comments
 * (any line without a `|`) are ignored; the first table row is treated as the header and skipped, as
 * are `| --- |` separator rows.
 */
export function parseModelsConfig(raw: string): { rules: ModelRule[]; warnings: string[] } {
  const rules: ModelRule[] = [];
  const warnings: string[] = [];
  let headerSkipped = false;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes('|')) continue; // prose / headings / <!-- comments --> — ignored
    const cells = tableCells(line);
    if (isSeparatorRow(cells)) continue; // | --- | --- |
    if (!headerSkipped) {
      headerSkipped = true; // the first table row is the header (`| Prompt path | Model |`)
      continue;
    }
    // col 0 = path glob (may be wrapped in backticks or quotes); col 1 = family[/class].
    const glob = cells[0]?.replace(/^[`'"]+|[`'"]+$/g, '').trim() ?? '';
    const modelCell = cells.length > 1 ? stripComment(cells[1]).trim() : '';
    const m = modelCell.match(/^([A-Za-z]+)(?:\s*\/\s*([A-Za-z]+))?$/);
    if (!glob || !m) {
      warnings.push(`ignored malformed table row: ${rawLine.trim()}`);
      continue;
    }
    const family = m[1].toLowerCase();
    if (!isFamily(family)) {
      warnings.push(`ignored unknown model family "${m[1]}" for ${glob} (known: ${MODEL_FAMILIES.join(', ')})`);
      continue;
    }
    const cls = (m[2] ?? 'standard').toLowerCase();
    if (cls !== 'standard' && cls !== 'reasoning') {
      warnings.push(`ignored unknown class "${m[2]}" for ${glob} (use reasoning|standard)`);
      continue;
    }
    rules.push({ glob, family, modelClass: cls });
  }
  return { rules, warnings };
}

/** Length of a glob's leading literal (up to the first wildcard) — the specificity tiebreak. */
function literalPrefixLen(glob: string): number {
  const i = glob.search(/[*?[\]{}]/);
  return i === -1 ? glob.length : i;
}

/** Resolve one path against the rules; most-specific (longest literal prefix) match wins, or null. */
export function resolveModel(path: string, rules: ModelRule[]): ResolvedModel | null {
  let best: ModelRule | null = null;
  let bestLen = -1;
  for (const rule of rules) {
    if (!minimatch(path, rule.glob, { dot: true })) continue;
    const len = literalPrefixLen(rule.glob);
    if (len > bestLen) {
      best = rule;
      bestLen = len;
    }
  }
  return best ? { family: best.family, modelClass: best.modelClass } : null;
}
