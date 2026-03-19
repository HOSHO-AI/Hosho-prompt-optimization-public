import {
  ComparisonResult,
  ChangeItem,
  SynthesisResult,
  FactorEvaluationResult,
  FactorInsight,
  Finding,
  CustomPrinciplesResult,
} from './types';

const BOT_MARKER = '<!-- prompt-factor-reviewer-api -->';
const PR_COMMENT_MAX_LENGTH = 65000; // Leave buffer below 65536 limit

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
    ? `## PR Review: #${prNumber} → ${filename}`
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

  let md = `## PR Review: ${repoFullName}#${prNumber}\n\n`;

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

function formatTable(
  factorResults: FactorEvaluationResult[],
  insights: FactorInsight[],
  customPrinciplesResult?: CustomPrinciplesResult,
): string {
  const isPRMode = insights.some(f => f.changeDirection);

  let md = '';
  if (isPRMode) {
    md += `| Factor | PR Impact | Overall Prompt Score | Rationale |\n`;
    md += `|---|---|---|---|`;
  } else {
    md += `| Factor | Score | Rationale |\n`;
    md += `|---|---|---|`;
  }

  for (const factor of factorResults) {
    const emoji = getTrafficLightEmoji(factor.score);
    const insight = insights.find(f => f.factorId === factor.factorId);

    if (isPRMode && insight?.changeDirection) {
      const changeEmoji = getChangeEmoji(insight.changeDirection);
      const prRationale = sanitizeInlineText(insight.changeRationale || '—');
      const scoreRationale = sanitizeInlineText(factor.tableRationale || '—');
      md += `\n| ${factor.factorName} | ${changeEmoji} | ${emoji} | <b><u>PR rationale:</u></b> ${prRationale}<br><b><u>Score rationale:</u></b> ${scoreRationale} |`;
    } else {
      const rationale = sanitizeInlineText(factor.tableRationale || '—');
      md += `\n| ${factor.factorName} | ${emoji} | ${rationale} |`;
    }
  }

  // Custom principles row (if present — separate from standard 6 factors)
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

  const hasCritical = changeSummary.some(c => c.effect === 'negative' && c.severity === 'critical');
  if (hasCritical) return '**Verdict:** ⛔ Request Changes\n\n';

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

  return `${line} — See ${tagged.factorName} (${f.findingNumber})`;
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
    const emoji = item.effect === 'positive' ? '✅'
      : item.severity === 'critical' ? '⛔' : '⚠️';
    const categoryPrefix = item.category ? `**${sanitizeInlineText(item.category)}** — ` : '';
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
      const hasCriticalInGroup = group.some(item => item.severity === 'critical');
      const fixLabel = hasCriticalInGroup ? `Fix ${g + 1}` : `Suggested fix ${g + 1}`;

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
          const cat = item.category ? `**${sanitizeInlineText(item.category)}**` : 'Review';
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
      const simpleLabel = first.severity === 'critical' ? `Fix ${g + 1}` : `Suggested fix ${g + 1}`;
      md += `**${simpleLabel}: ${sanitizeInlineText(first.revert!)}**\n\n`;
    }
  }
  return md;
}

function formatFindingDetail(finding: Finding): string {
  let md = '';

  const title = finding.codeSnippet?.issue || finding.description;

  if (finding.codeSnippet && finding.codeSnippet.code.trim()) {
    const lineRef = finding.codeSnippet.startLine === finding.codeSnippet.endLine
      ? `${finding.codeSnippet.startLine}`
      : `${finding.codeSnippet.startLine}-${finding.codeSnippet.endLine}`;
    md += `<h4>${finding.findingNumber}. ${title} (line ${lineRef})</h4>\n\n`;

    if (finding.codeSnippet.issue) {
      md += `${sanitizeInlineText(finding.codeSnippet.issue)}\n\n`;
    }

    const cleanedCode = cleanCodeSnippet(finding.codeSnippet.code);
    if (cleanedCode.trim()) {
      const codeFence = getCodeFence(cleanedCode);
      md += `**Problematic text:**\n\n`;
      md += `${codeFence}\n${cleanedCode}\n${codeFence}\n\n`;
    }
  } else {
    md += `<h4>${finding.findingNumber}. ${title}</h4>\n\n`;
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

  for (const insight of withFindings) {
    md += `#### ${insight.factorName}\n\n`;
    for (const finding of insight.findings) {
      md += formatFindingDetail(finding);
    }
  }

  // Custom principles findings (separate from standard 6 factors)
  if (hasCustomFindings) {
    md += `#### Custom Principles\n\n`;
    for (const finding of customPrinciplesResult!.findings) {
      md += formatFindingDetail(finding);
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
): string {
  const enrichedInsights = mergeFindings(synthesis.factorInsights, factorResults);

  let md = formatHeader(synthesis.promptFile, synthesis.promptDescription, targetModelFamily, targetModelName);
  md += formatTable(factorResults, enrichedInsights);

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
  const tableContent = formatTable(comp.factorResults, enrichedInsights, comp.customPrinciplesResult);
  md += formatAllFindings(enrichedInsights, tableContent, comp.customPrinciplesResult);

  return md;
}

export function formatPRComment(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
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

  md += `\n*Hosho Bot*\n`;
  return md;
}

export function formatJobSummary(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
): string {
  let md = '';
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatPRFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

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

  md += `\n<p align="center"><b>Comment <code>/hosho-improve</code> for full scoring and improvement suggestions beyond this PR.</b></p>\n\n`;
  md += `*Hosho Bot*\n`;
  return md;
}

export function formatReviewJobSummary(
  comparisons: ComparisonResult[],
  prNumber: number,
  repoFullName: string = '',
): string {
  let md = '';
  md += formatScopeHeader(comparisons, prNumber, repoFullName);

  const isMultiFile = comparisons.length > 1;
  for (const comp of comparisons) {
    md += formatReviewFileSection(comp, prNumber, isMultiFile);
    if (isMultiFile) md += `\n---\n\n`;
  }

  md += `\n<p align="center"><b>Comment <code>/hosho-improve</code> for full scoring and improvement suggestions beyond this PR.</b></p>\n\n`;
  md += `*Hosho Bot*\n`;
  return md;
}

// Export the bot marker for comment deduplication
export { BOT_MARKER };
