// Deterministic per-prompt model resolution from a customer-maintained `.github/hosho/models.yaml`.
//
// Why: today, in CI, a prompt's target model is INFERRED — the Lambda hands the whole
// architecture prose doc to Haiku and asks it to fuzzy-match each changed path to a "- Model: …"
// line. That drifts (a real incident: a prompt reviewed as the wrong provider because the prose
// lagged the code), collides (every agent's file is `system-prompt.md`), and silently degrades to
// "model-fit N/A" on any failure. A customer file that maps path globs → {family, class} makes it
// exact: no LLM, no fuzzy matching, no silent drop.
//
// Format is a flat YAML map (valid YAML; parsed here without a yaml dependency, matching the repo's
// hand-rolled assembly-config parser). Each entry is  "<path-glob>": <family>[/<class>] :
//
//   # .github/hosho/models.yaml
//   "backend/app/llm/orchestrator_agent/**": openai/reasoning
//   "backend/app/llm/brand_analyzer_agent/**": gemini
//   "**/*prompt*.md": gemini            # catch-all
//
// Most-specific match wins (the rule with the longest literal, non-wildcard prefix), so order in
// the file doesn't matter. family must be one of the seven the scorer knows; class defaults to
// standard. Anything malformed is skipped with a warning, never throws — a bad models.yaml
// degrades to today's inference, it never fails the run.

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

function stripComment(line: string): string {
  // Drop a trailing `# comment`, but not a `#` inside quotes (globs don't use #, so this is safe).
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

function isFamily(v: string): v is ModelFamily {
  return (MODEL_FAMILIES as readonly string[]).includes(v);
}

/**
 * Parse the file's text into rules. Never throws — malformed lines are collected into `warnings`
 * and skipped, so a typo can't break the whole review.
 */
export function parseModelsConfig(raw: string): { rules: ModelRule[]; warnings: string[] } {
  const rules: ModelRule[] = [];
  const warnings: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (/^version\s*:/.test(line) || /^defaults\s*:/.test(line) || /^models\s*:/.test(line)) continue; // headers, ignored
    // "<glob>": family[/class]   — the glob may be quoted (recommended) or bare.
    const m = line.match(/^["']?(.+?)["']?\s*:\s*([A-Za-z]+)(?:\s*\/\s*([A-Za-z]+))?\s*$/);
    if (!m) {
      warnings.push(`ignored unparseable line: ${rawLine.trim()}`);
      continue;
    }
    const [, glob, familyRaw, classRaw] = m;
    const family = familyRaw.toLowerCase();
    if (!isFamily(family)) {
      warnings.push(`ignored unknown model family "${familyRaw}" for ${glob} (known: ${MODEL_FAMILIES.join(', ')})`);
      continue;
    }
    const cls = (classRaw ?? 'standard').toLowerCase();
    if (cls !== 'standard' && cls !== 'reasoning') {
      warnings.push(`ignored unknown class "${classRaw}" for ${glob} (use reasoning|standard)`);
      continue;
    }
    rules.push({ glob: glob.trim(), family, modelClass: cls });
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
