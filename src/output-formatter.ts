import {
  ComparisonResult,
  ChangeItem,
  SynthesisResult,
  FactorEvaluationResult,
  FactorInsight,
  Finding,
  CustomPrinciplesResult,
  MacroScore,
} from './types';

const BOT_MARKER = '<!-- prompt-factor-reviewer-api -->';
const PR_COMMENT_MAX_LENGTH = 65000; // Leave buffer below 65536 limit

// ---- v3 taxonomy (4 macros / 13 sub-factors) — display labels + routing ----
// Single source for the "Macro — Sub" tag on every findings list, plus the macro
// bucketing behind the 4-row score table. Mirrors the API's factors/taxonomy-v3.

const MACRO_ORDER = ['scope', 'structure', 'guidance', 'coherence'] as const;

const MACRO_LABELS: Record<string, string> = {
  scope: 'Scope',
  structure: 'Structure',
  guidance: 'Guidance',
  coherence: 'Coherence',
};

const SUB_LABELS: Record<string, string> = {
  focus: 'Focus',
  load: 'Volume',
  layout: 'Layout',
  tools: 'Tools & skills',
  'model-fit': 'Provider fit',
  output: 'Output & validation',
  goal: 'Goal',
  inputs: 'Inputs',
  'method-reasoning': 'Method & reasoning',
  clarity: 'Clarity',
  criteria: 'Criteria',
  consistency: 'Consistency',
  bloat: 'Bloat',
};

const SUB_TO_MACRO: Record<string, string> = {
  focus: 'scope', load: 'scope',
  layout: 'structure', tools: 'structure', output: 'structure',
  goal: 'guidance', inputs: 'guidance', 'method-reasoning': 'guidance', 'model-fit': 'guidance',
  clarity: 'coherence', criteria: 'coherence', consistency: 'coherence', bloat: 'coherence',
};

// Best-effort mapping for a legacy v2 factor id → macro (only reached when a result
// predates v3 and carries no macro/sub tags — keeps the table 4-row rather than 6-row).
const LEGACY_FACTOR_TO_MACRO: Record<string, string> = {
  scope: 'scope',
  'structure-flow': 'structure',
  'output-validation': 'structure',
  'model-specific-prompting': 'guidance',
  'context-guidance': 'guidance',
  constraints: 'guidance',
};

function macroLabel(id?: string): string {
  if (!id) return '';
  return MACRO_LABELS[id] ?? id;
}

function subLabel(id?: string): string {
  if (!id) return '';
  return SUB_LABELS[id] ?? id;
}

/** Resolve a factor/sub id to its macro id, or undefined if it can't be routed. */
function macroForId(id?: string): string | undefined {
  if (!id) return undefined;
  if (MACRO_LABELS[id]) return id;                 // already a macro id
  return SUB_TO_MACRO[id] ?? LEGACY_FACTOR_TO_MACRO[id];
}

/**
 * The "Macro — Sub" tag for a changeSummary item. Prefers the v3 tags; falls back
 * to the legacy `category` string (so custom-principle + untagged items still render).
 * Returns '' when nothing is available (caller omits the prefix).
 */
function changeItemTag(item: ChangeItem): string {
  if (item.macroFactor) {
    const macro = macroLabel(item.macroFactor);
    const sub = subLabel(item.subFactor);
    return sub ? `${macro} — ${sub}` : macro;
  }
  return item.category ? sanitizeInlineText(item.category) : '';
}

/**
 * The "Macro — Sub" tag for a finding, given its parent factor id/name. Prefers the
 * finding's own v3 tags, then the parent factor id (a sub-factor id in v3 improve),
 * then the legacy factor name.
 */
function findingTag(f: Finding, factorId: string, factorName: string): string {
  const macroId = f.macroFactor ?? macroForId(factorId);
  const subId = f.subFactor ?? (SUB_TO_MACRO[factorId] ? factorId : undefined);
  if (macroId && MACRO_LABELS[macroId]) {
    const sub = subLabel(subId);
    return sub ? `${macroLabel(macroId)} — ${sub}` : macroLabel(macroId);
  }
  return sanitizeInlineText(factorName);
}

// ---- Helpers ----

function getTrafficLightEmoji(score: number): string {
  if (score <= 4) return '🔴';
  if (score <= 7) return '🟡';
  return '🟢';
}

function getChangeEmoji(direction: 'improved' | 'no-change' | 'worse' | 'mixed'): string {
  if (direction === 'improved') return '✅';
  if (direction === 'worse') return '⚠️';
  if (direction === 'mixed') return '⚠️';
  return '➖';
}

function cleanCodeSnippet(code: string): string {
  const lines = code.split('\n');
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { cleaned.push(line); continue; }
    if (isSectionHeader(trimmed)) continue;
    cleaned.push(line);
  }
  const result = cleaned.join('\n').trim();
  if (!result && code.trim()) return code;
  return result;
}

function sanitizeInlineText(text: string): string {
  if (!text) return text;
  return text.replace(/`{3,}/g, (match) => '\\`'.repeat(match.length));
}

function getCodeFence(content: string): string {
  let maxRun = 0;
  const matches = content.match(/`{3,}/g);
  if (matches) {
    for (const m of matches) maxRun = Math.max(maxRun, m.length);
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

function isSectionHeader(line: string): boolean {
  if (line !== line.trim()) return false;
  const cleanedLine = line.replace(/\s*\([^)]+\)\s*$/g, '').trim();
  if (/^\d+\)\s+[A-Z]/.test(cleanedLine)) return true;
  if (/^#{1,6}\s+\d+\)\s+[A-Z]/.test(cleanedLine)) return true;
  if (/^#{1,6}\s+[A-Z]/.test(cleanedLine)) return true;
  if (/^[A-Z][a-zA-Z\s]{1,30}:\s*$/.test(cleanedLine)) return true;
  if (/^-{3,}$/.test(line) || /^={3,}$/.test(line) || /^\*{3,}$/.test(line)) return true;
  return false;
}

function mergeFindings(
  factorInsights: FactorInsight[],
  factorResults: FactorEvaluationResult[]
): FactorInsight[] {
  return factorInsights.map(insight => {
    const result = factorResults.find(fr => fr.factorId === insight.factorId);
    if (result) return { ...insight, findings: result.findings };
    return insight;
  });
}

// ---- Finding types with parent context ----

interface TaggedFinding {
  finding: Finding;
  factorId: string;
  factorName: string;
  factorScore: number;
}

function gatherFindings(insights: FactorInsight[]): TaggedFinding[] {
  const all: TaggedFinding[] = [];
  for (const insight of insights) {
    for (const finding of insight.findings) {
      all.push({ finding, factorId: insight.factorId, factorName: insight.factorName, factorScore: insight.score });
    }
  }
  // Sort by score ascending (lowest = most impactful)
  all.sort((a, b) => a.factorScore - b.factorScore);
  return all;
}

// ---- Format building blocks ----

function formatHeader(
  filename: string,
  _description: string,
  _targetModelFamily?: string,
  _targetModelName?: string,
  prNumber?: number,
): string {
  const title = prNumber
    ? `## Hosho PR Review: #${prNumber} → ${filename}`
    : `## Prompt Review: ${filename}`;

  let md = `${title}\n\n`;
  return md;
}

function formatScopeHeader(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string,
): string {
  const fileCount = comparisons.length;
  const fileList = comparisons.map(c => `\`${c.promptFile}\``).join(', ');

  let md = `## Hosho PR Review: ${repoFullName}#${prNumber}\n\n`;

  if (fileCount === 1) {
    const summary = comparisons[0].scopeSummary;
    md += summary
      ? `**Scope:** ${summary} in ${fileList}\n\n`
      : `**Scope:** 1 prompt change in ${fileList}\n\n`;
  } else {
    md += `**Scope:** ${fileCount} prompt changes in ${fileList}\n\n`;
  }

  return md;
}

function formatDiffSnippet(comp: ComparisonResult): string {
  if (!comp.diffSnippet) return '';
  const fence = getCodeFence(comp.diffSnippet);
  return `**The Change:**\n\n${fence}diff\n${comp.diffSnippet}\n${fence}\n\n`;
}

/** Worst change direction across a macro's sub-factors (for the PR-impact column). */
function aggregateDirection(
  insights: FactorInsight[],
): FactorInsight['changeDirection'] | undefined {
  const dirs = insights.map(i => i.changeDirection).filter(Boolean) as string[];
  if (dirs.length === 0) return undefined;
  if (dirs.includes('worse')) return 'worse';
  if (dirs.includes('mixed')) return 'mixed';
  if (dirs.includes('improved')) return 'improved';
  return 'no-change';
}

/** Join a macro's sub-factor rationales, each prefixed with its sub label, deduped. */
function macroRationale(
  items: Array<{ factorId: string; tableRationale?: string; changeRationale?: string }>,
  key: 'tableRationale' | 'changeRationale',
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const t = (it[key] ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const sub = SUB_TO_MACRO[it.factorId] ? subLabel(it.factorId) : '';
    parts.push(sub ? `<b>${sub}:</b> ${sanitizeInlineText(t)}` : sanitizeInlineText(t));
  }
  return parts.join('<br>');
}

// Score/roll-up table at the 4-MACRO level only (never the 6 legacy factors). Prefers the
// API's `macroScores` for each macro's number; aggregates the sub-factor results/insights for
// the rationale text and (PR mode) the change direction.
function formatTable(
  factorResults: FactorEvaluationResult[],
  insights: FactorInsight[],
  customPrinciplesResult?: CustomPrinciplesResult,
  macroScores?: MacroScore[],
): string {
  const isPRMode = insights.some(f => f.changeDirection);

  // Bucket sub-factor (v3) / legacy-factor results + insights into the 4 macros.
  const buckets = new Map<string, { results: FactorEvaluationResult[]; insights: FactorInsight[] }>();
  const bucket = (macro: string) => {
    let b = buckets.get(macro);
    if (!b) { b = { results: [], insights: [] }; buckets.set(macro, b); }
    return b;
  };
  for (const fr of factorResults) {
    const macro = macroForId(fr.factorId);
    if (macro) bucket(macro).results.push(fr);
  }
  for (const ins of insights) {
    const macro = macroForId(ins.factorId);
    if (macro) bucket(macro).insights.push(ins);
  }

  const macroScoreMap = new Map((macroScores ?? []).map(m => [m.macro, m]));
  const rows = MACRO_ORDER.filter(
    m => macroScoreMap.has(m) || (buckets.get(m)?.results.length ?? 0) > 0,
  );

  let md = '';
  if (isPRMode) {
    md += `| Macro Factor | PR Impact | Overall Prompt Score | Rationale |\n`;
    md += `|---|---|---|---|`;
  } else {
    md += `| Macro Factor | Score | Rationale |\n`;
    md += `|---|---|---|`;
  }

  for (const macro of rows) {
    const b = buckets.get(macro);
    const memberResults = b?.results ?? [];
    const ms = macroScoreMap.get(macro);
    const score = ms
      ? ms.score
      : memberResults.length
        ? Math.round(memberResults.reduce((s, r) => s + r.score, 0) / memberResults.length)
        : 0;
    const emoji = getTrafficLightEmoji(score);
    const scoreRationale = macroRationale(memberResults, 'tableRationale') || '—';

    if (isPRMode) {
      const dir = aggregateDirection(b?.insights ?? []);
      const changeEmoji = dir ? getChangeEmoji(dir) : '➖';
      const prRationale = macroRationale(b?.insights ?? [], 'changeRationale') || '—';
      md += `\n| ${macroLabel(macro)} | ${changeEmoji} | ${emoji} | <b><u>PR rationale:</u></b> ${prRationale}<br><b><u>Score rationale:</u></b> ${scoreRationale} |`;
    } else {
      md += `\n| ${macroLabel(macro)} | ${emoji} | ${scoreRationale} |`;
    }
  }

  // Custom principles row (kept — separate from the macro roll-up, excluded from overall)
  if (customPrinciplesResult && customPrinciplesResult.score > 0) {
    const emoji = getTrafficLightEmoji(customPrinciplesResult.score);
    const rationale = sanitizeInlineText(customPrinciplesResult.tableRationale || '—');
    if (isPRMode) {
      md += `\n| Custom Principles | — | ${emoji} | ${rationale} |`;
    } else {
      md += `\n| Custom Principles | ${emoji} | ${rationale} |`;
    }
  }

  md += '\n\n';
  return md;
}

function formatVerdict(changeSummary?: ChangeItem[]): string {
  if (!changeSummary || changeSummary.length === 0) return '**Verdict:** ✅ Approve This PR\n\n';

  const hasSuggestions = changeSummary.some(c => c.effect === 'negative');
  if (hasSuggestions) return '**Verdict:** ✅ Approve — with suggestions\n\n';

  return '**Verdict:** ✅ Approve This PR\n\n';
}

function formatEditLine(tagged: TaggedFinding): string {
  const f = tagged.finding;
  const title = f.description || 'Improvement';

  let sectionRef = '';
  if (f.codeSnippet) {
    sectionRef = f.codeSnippet.startLine === f.codeSnippet.endLine
      ? `§${f.codeSnippet.startLine}`
      : `§${f.codeSnippet.startLine}-${f.codeSnippet.endLine}`;
  }

  // Show issue (why) after em-dash. Fall back to consideration if no issue.
  const reason = f.codeSnippet?.issue || f.consideration || '';
  const cleanReason = sanitizeInlineText(reason.replace(/\.+$/, ''));

  let line: string;
  if (sectionRef && cleanReason) {
    line = `**${sanitizeInlineText(title)}** (${sectionRef}) — ${cleanReason}`;
  } else if (cleanReason) {
    line = `**${sanitizeInlineText(title)}** — ${cleanReason}`;
  } else if (sectionRef) {
    line = `**${sanitizeInlineText(title)}** (${sectionRef})`;
  } else {
    line = `**${sanitizeInlineText(title)}**`;
  }

  return `${line} — See ${findingTag(f, tagged.factorId, tagged.factorName)} (${f.findingNumber})`;
}

function formatTopEdits(tagged: TaggedFinding[], limit: number = 3): string {
  if (tagged.length === 0) return '';

  const top = tagged.slice(0, limit);
  let md = '';
  for (let i = 0; i < top.length; i++) {
    md += `${i + 1}. ${formatEditLine(top[i])}\n\n`;
  }
  return md;
}

function formatWhatChanged(changeSummary?: ChangeItem[]): string {
  if (!changeSummary || changeSummary.length === 0) return '';

  const effectOrder: Record<string, number> = { negative: 0, mixed: 1, positive: 2 };
  const sorted = [...changeSummary].sort(
    (a, b) => (effectOrder[a.effect] ?? 1) - (effectOrder[b.effect] ?? 1)
  );

  let md = '### WHAT\'S GOOD AND BAD IN THIS PR\n\n';
  for (const item of sorted) {
    const emoji = item.effect === 'positive' ? '✅' : '⚠️';
    const tag = changeItemTag(item);
    const categoryPrefix = tag ? `**${tag}** — ` : '';
    const change = sanitizeInlineText(item.change);
    const impact = item.impact ? ` — ${sanitizeInlineText(item.impact)}` : '';
    md += `- ${emoji} ${categoryPrefix}${change}${impact}\n`;
  }
  md += '\n';
  return md;
}

/**
 * Group reverts with identical revertDetail line ranges (conservative dedup).
 * Only merges when startLine AND endLine match exactly.
 */
function groupRevertsByLineRange(reverts: ChangeItem[]): ChangeItem[][] {
  const groups: ChangeItem[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < reverts.length; i++) {
    if (used.has(i)) continue;
    const group = [reverts[i]];
    used.add(i);
    const a = reverts[i].revertDetail;

    if (a) {
      for (let j = i + 1; j < reverts.length; j++) {
        if (used.has(j)) continue;
        const b = reverts[j].revertDetail;
        if (b && a.startLine === b.startLine && a.endLine === b.endLine) {
          group.push(reverts[j]);
          used.add(j);
        }
      }
    }

    groups.push(group);
  }
  return groups;
}

function formatRevertSection(changeSummary?: ChangeItem[]): string {
  if (!changeSummary) return '';
  const reverts = changeSummary.filter(c => c.effect !== 'positive' && c.revert);
  if (reverts.length === 0) return '';

  const groups = groupRevertsByLineRange(reverts);

  let md = '### SUGGESTED FIXES BEFORE MERGING\n\n';
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const first = group[0];

    if (first.revertDetail) {
      const d = first.revertDetail;
      const lineRef = d.startLine === d.endLine ? `${d.startLine}` : `${d.startLine}-${d.endLine}`;
      const fixLabel = `Suggested fix ${g + 1}`;

      if (group.length === 1) {
        // Single item — render as before
        md += `**${fixLabel}: ${sanitizeInlineText(first.revert!)}** *(line ${lineRef})*\n\n`;
        if (d.suggestedFix.trim()) {
          md += `${sanitizeInlineText(d.suggestedFix)}\n\n`;
        }
      } else {
        // Grouped — show first revert as title, list all reasons as bullets
        md += `**${fixLabel}: ${sanitizeInlineText(first.revert!)}** *(line ${lineRef})*\n\n`;
        md += `This change was flagged by multiple quality factors:\n`;
        for (const item of group) {
          const tag = changeItemTag(item);
          const cat = tag ? `**${tag}**` : 'Review';
          md += `- ${cat} — ${sanitizeInlineText(item.change)} — ${sanitizeInlineText(item.impact)}\n`;
        }
        md += '\n';
      }

      if (d.currentCode.trim()) {
        const codeFence = getCodeFence(d.currentCode);
        md += `**Problematic text:**\n\n${codeFence}\n${d.currentCode}\n${codeFence}\n\n`;
      }

      // Pick the longest rewrittenCode from the group
      const bestRewrite = group
        .map(item => item.revertDetail?.rewrittenCode || '')
        .filter(code => code.trim())
        .sort((a, b) => b.length - a.length)[0];

      if (bestRewrite) {
        const rewriteFence = getCodeFence(bestRewrite);
        md += `**Suggested fix:**\n\n${rewriteFence}\n${bestRewrite}\n${rewriteFence}\n\n`;
      }
    } else {
      const simpleLabel = `Suggested fix ${g + 1}`;
      md += `**${simpleLabel}: ${sanitizeInlineText(first.revert!)}**\n\n`;
    }
  }
  return md;
}

/**
 * Render a finding's location with source-file provenance (WS-3). Shows the line
 * range; when the finding resolves to a bundled file NOT under review, names that
 * file and marks it out-of-scope; when no line could be anchored, says file-level.
 */
function formatLocation(cs: NonNullable<Finding['codeSnippet']>): string {
  const hasLine = cs.startLine > 0;
  const lineRef = cs.startLine === cs.endLine ? `${cs.startLine}` : `${cs.startLine}-${cs.endLine}`;
  if (cs.sourceFile && cs.sourceInChangeSet === false) {
    return hasLine
      ? `in \`${cs.sourceFile}\` line ${lineRef} — bundled file, not changed by this PR`
      : `in \`${cs.sourceFile}\` — bundled file, not changed by this PR`;
  }
  return hasLine ? `line ${lineRef}` : 'file-level';
}

function formatFindingDetail(finding: Finding, factorId?: string, subTag?: string): string {
  let md = '';
  const anchorId = factorId ? `${factorId}-${finding.findingNumber}` : '';

  // Sub-factor label prefix (v3) — the appendix groups under the 4 macros, so each
  // finding names its sub inline. Empty when the finding can't be routed to a sub.
  const subPrefix = subTag ? `${subTag} — ` : '';
  const title = finding.codeSnippet?.issue || finding.description;

  if (finding.codeSnippet && finding.codeSnippet.code.trim()) {
    md += `**<u>${finding.findingNumber}. ${subPrefix}${title} (${formatLocation(finding.codeSnippet)})</u>**\n\n`;

    const cleanedCode = cleanCodeSnippet(finding.codeSnippet.code);
    if (cleanedCode.trim()) {
      const codeFence = getCodeFence(cleanedCode);
      md += `**Problematic text:**\n\n`;
      md += `${codeFence}\n${cleanedCode}\n${codeFence}\n\n`;
    }
  } else {
    md += `**<u>${finding.findingNumber}. ${subPrefix}${title}</u>**\n\n`;
  }

  md += `**Suggested fix:** ${sanitizeInlineText(finding.consideration)}\n\n`;

  if (finding.rewrittenCode && finding.rewrittenCode.trim()) {
    const rewriteFence = getCodeFence(finding.rewrittenCode);
    md += `${rewriteFence}\n${finding.rewrittenCode}\n${rewriteFence}\n\n`;
  }

  md += `---\n\n`;
  return md;
}

function formatAllFindings(
  insights: FactorInsight[],
  tableContent?: string,
  customPrinciplesResult?: CustomPrinciplesResult,
): string {
  const withFindings = insights.filter(f => f.findings.length > 0);
  const hasCustomFindings = customPrinciplesResult && customPrinciplesResult.findings.length > 0;
  if (withFindings.length === 0 && !tableContent && !hasCustomFindings) return '';

  let md = `---\n### APPENDIX: FURTHER PROMPT IMPROVEMENTS\n\n`;

  if (tableContent) {
    md += tableContent;
  }

  // Group findings under the 4 MACRO headers (v3). Each finding is sub-labeled with its
  // sub-factor. Insights that can't be routed to a macro fall back to their own header.
  const byMacro = new Map<string, FactorInsight[]>();
  const unrouted: FactorInsight[] = [];
  for (const insight of withFindings) {
    const macro = macroForId(insight.factorId);
    if (macro) {
      const list = byMacro.get(macro) ?? [];
      list.push(insight);
      byMacro.set(macro, list);
    } else {
      unrouted.push(insight);
    }
  }

  const renderInsight = (insight: FactorInsight) => {
    for (const finding of insight.findings) {
      const subId = finding.subFactor ?? (SUB_TO_MACRO[insight.factorId] ? insight.factorId : undefined);
      md += formatFindingDetail(finding, insight.factorId, subId ? subLabel(subId) : undefined);
    }
  };

  for (const macro of MACRO_ORDER) {
    const list = byMacro.get(macro);
    if (!list || list.length === 0) continue;
    md += `#### ${macroLabel(macro).toUpperCase()}\n\n`;
    for (const insight of list) renderInsight(insight);
  }

  // Legacy/unrouted insights keep their own factor-name header.
  for (const insight of unrouted) {
    md += `#### ${insight.factorName.toUpperCase()}\n\n`;
    renderInsight(insight);
  }

  // Custom principles findings (separate from the macro roll-up)
  if (hasCustomFindings) {
    md += `#### CUSTOM PRINCIPLES\n\n`;
    for (const finding of customPrinciplesResult!.findings) {
      md += formatFindingDetail(finding, 'custom-principles');
    }
  }

  md += `\n`;

  return md;
}

// ---- On-demand output ----

export function formatOnDemandSummary(
  synthesis: SynthesisResult,
  factorResults: FactorEvaluationResult[],
  targetModelFamily?: string,
  targetModelName?: string,
  macroScores?: MacroScore[],
): string {
  const enrichedInsights = mergeFindings(synthesis.factorInsights, factorResults);

  let md = formatHeader(synthesis.promptFile, synthesis.promptDescription, targetModelFamily, targetModelName);
  md += formatTable(factorResults, enrichedInsights, undefined, macroScores);

  // Top 3 edits
  const allFindings = gatherFindings(enrichedInsights);
  if (allFindings.length > 0) {
    md += `### TOP 3 EDITS\n\n`;
    md += formatTopEdits(allFindings, 3);
  }

  // Collapsed detail
  md += formatAllFindings(enrichedInsights);

  return md;
}

// ---- PR output ----

function formatPRFileSection(
  comp: ComparisonResult,
  prNumber: number,
  isMultiFile: boolean,
): string {
  const enrichedInsights = mergeFindings(comp.synthesis.factorInsights, comp.factorResults);

  let md = '';
  if (isMultiFile) {
    md += `### ${comp.promptFile}\n\n`;
  }

  // Diff snippet + Verdict
  md += formatDiffSnippet(comp);
  md += formatVerdict(comp.changeSummary);

  // What changed in this PR
  md += formatWhatChanged(comp.changeSummary);

  // Revert before merging (conditional — only if ❌ items with revert instructions)
  md += formatRevertSection(comp.changeSummary);

  // Top 3 edits to further improve this prompt (exclude degraded factors to avoid revert overlap)
  const degradedFactorIds = new Set(
    enrichedInsights
      .filter(f => f.changeDirection === 'worse' || f.changeDirection === 'mixed')
      .map(f => f.factorId)
  );
  const allFindings = gatherFindings(enrichedInsights);
  let top3Candidates = allFindings.filter(f => !degradedFactorIds.has(f.factorId));
  // Fall back to degraded findings if not enough non-degraded ones
  if (top3Candidates.length < 3) {
    const degradedFindings = allFindings.filter(f => degradedFactorIds.has(f.factorId));
    top3Candidates = [...top3Candidates, ...degradedFindings].slice(0, 3);
  }
  if (top3Candidates.length > 0) {
    md += `### TOP 3 EDITS TO FURTHER IMPROVE (BEYOND THIS PR)\n\n`;
    md += formatTopEdits(top3Candidates, 3);
  }

  // Collapsed detail (table + ALL findings)
  const tableContent = formatTable(comp.factorResults, enrichedInsights, comp.customPrinciplesResult, comp.macroScores);
  md += formatAllFindings(enrichedInsights, tableContent, comp.customPrinciplesResult);

  return md;
}

/**
 * Build a short footer noting what skills + sibling files Hosho bundled into
 * each prompt for review context. Returns empty string when nothing bundled.
 */
export function formatBundledFooter(
  bundledByFile?: Map<string, { skills: string[]; siblings: string[] }>,
): string {
  if (!bundledByFile || bundledByFile.size === 0) return '';

  const renderList = (names: string[]): string => names.join(', ');

  const lines: string[] = [];
  for (const [filePath, { skills, siblings }] of bundledByFile.entries()) {
    const parts: string[] = [];
    if (skills.length > 0) parts.push(`${renderList(skills)} (${skills.length} skill${skills.length === 1 ? '' : 's'})`);
    if (siblings.length > 0) parts.push(`${renderList(siblings)} (${siblings.length} sibling${siblings.length === 1 ? '' : 's'})`);
    if (parts.length === 0) continue;
    lines.push(`- \`${filePath}\` — ${parts.join(' · ')}`);
  }

  if (lines.length === 0) return '';

  if (lines.length === 1) {
    // Single-file: inline footer
    return `\n<sub>Bundled review context: ${lines[0].replace(/^- `[^`]+` — /, '')}</sub>\n`;
  }
  return `\n<sub>Bundled review context:\n${lines.join('\n')}</sub>\n`;
}

export function formatPRComment(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
  bundledByFile?: Map<string, { skills: string[]; siblings: string[] }>,
): string {
  let md = `${BOT_MARKER}\n`;
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatPRFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

  // Truncate if needed
  if (md.length > PR_COMMENT_MAX_LENGTH) {
    md = md.substring(0, PR_COMMENT_MAX_LENGTH - 200);
    md += `\n\n---\n\n**Comment truncated.** See the Job Summary in the Actions tab for the full detailed report.\n`;
  }

  md += formatBundledFooter(bundledByFile);
  md += `\n*Hosho Bot*\n`;
  return md;
}

export function formatJobSummary(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
  bundledByFile?: Map<string, { skills: string[]; siblings: string[] }>,
): string {
  let md = '';
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatPRFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

  md += formatBundledFooter(bundledByFile);
  return md;
}

// ---- Review-mode output (slim: verdict + changes + fixes only) ----

function formatReviewFileSection(
  comp: ComparisonResult,
  prNumber: number,
  isMultiFile: boolean,
): string {
  let md = '';
  if (isMultiFile) {
    md += `### ${comp.promptFile}\n\n`;
  }
  md += formatDiffSnippet(comp);
  md += formatVerdict(comp.changeSummary);
  md += formatWhatChanged(comp.changeSummary);
  md += formatRevertSection(comp.changeSummary);
  return md;
}

export function formatReviewComment(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
  bundledByFile?: Map<string, { skills: string[]; siblings: string[] }>,
): string {
  let md = `${BOT_MARKER}\n`;
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatReviewFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

  if (md.length > PR_COMMENT_MAX_LENGTH) {
    md = md.substring(0, PR_COMMENT_MAX_LENGTH - 200);
    md += `\n\n---\n\n**Comment truncated.** See the Job Summary in the Actions tab for the full detailed report.\n`;
  }

  md += formatBundledFooter(bundledByFile);
  md += `\n<p align="center">Comment <code>/hosho-improve</code> for full scoring and improvement suggestions beyond this PR.</p>\n\n`;
  md += `*Hosho Bot*\n`;
  return md;
}

export function formatReviewJobSummary(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
  bundledByFile?: Map<string, { skills: string[]; siblings: string[] }>,
): string {
  let md = '';
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatReviewFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

  md += formatBundledFooter(bundledByFile);
  md += `\n<p align="center">Comment <code>/hosho-improve</code> for full scoring and improvement suggestions beyond this PR.</p>\n\n`;
  md += `*Hosho Bot*\n`;
  return md;
}

// Export the bot marker for comment deduplication
export { BOT_MARKER };
