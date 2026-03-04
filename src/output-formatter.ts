import {
  ComparisonResult,
  ChangeItem,
  SynthesisResult,
  FactorEvaluationResult,
  FactorInsight,
  Finding,
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

function formatTable(
  factorResults: FactorEvaluationResult[],
  insights: FactorInsight[],
): string {
  const isPRMode = insights.some(f => f.changeDirection);

  let md = '';
  if (isPRMode) {
    md += `| Factor | PR Impact | PR Rationale | Overall Prompt Score |\n`;
    md += `|---|---|---|---|`;
  } else {
    md += `| Factor | Score |\n`;
    md += `|---|---|`;
  }

  for (const factor of factorResults) {
    const emoji = getTrafficLightEmoji(factor.score);
    const insight = insights.find(f => f.factorId === factor.factorId);

    if (isPRMode && insight?.changeDirection) {
      const changeEmoji = getChangeEmoji(insight.changeDirection);
      const rationale = sanitizeInlineText(insight.changeRationale || '—');
      md += `\n| ${factor.factorName} | ${changeEmoji} | ${rationale} | ${emoji} |`;
    } else {
      md += `\n| ${factor.factorName} | ${emoji} |`;
    }
  }

  md += '\n\n';
  return md;
}

function formatVerdict(changeSummary?: ChangeItem[]): string {
  if (!changeSummary || changeSummary.length === 0) return '### ✅ Approve This PR\n\n';

  const hasNegative = changeSummary.some(c => c.effect === 'negative');

  if (hasNegative) return '### ⛔ Request Changes\n\n';
  return '### ✅ Approve This PR\n\n';
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

  return `${line} — See ${tagged.factorName} #${f.findingNumber}`;
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
    const change = sanitizeInlineText(item.change);
    const impact = item.impact ? ` — ${sanitizeInlineText(item.impact)}` : '';
    md += `- ${emoji} ${change}${impact}\n`;
  }
  md += '\n';
  return md;
}

function formatRevertSection(changeSummary?: ChangeItem[]): string {
  if (!changeSummary) return '';
  const reverts = changeSummary.filter(c => c.effect !== 'positive' && c.revert);
  if (reverts.length === 0) return '';

  let md = '### SUGGESTED FIXES BEFORE MERGING\n\n';
  for (let i = 0; i < reverts.length; i++) {
    const item = reverts[i];
    if (item.revertDetail) {
      const d = item.revertDetail;
      const lineRef = d.startLine === d.endLine ? `${d.startLine}` : `${d.startLine}-${d.endLine}`;
      md += `<details><summary><strong>Fix ${i + 1}:</strong> ${sanitizeInlineText(item.revert!)} <em>(line ${lineRef})</em></summary>\n\n`;
      if (d.currentCode.trim()) {
        const codeFence = getCodeFence(d.currentCode);
        md += `**Current prompt:**\n\n${codeFence}\n${d.currentCode}\n${codeFence}\n\n`;
      }
      md += `**Suggested fix:** ${sanitizeInlineText(d.suggestedFix)}\n\n`;
      if (d.rewrittenCode.trim()) {
        const rewriteFence = getCodeFence(d.rewrittenCode);
        md += `${rewriteFence}\n${d.rewrittenCode}\n${rewriteFence}\n\n`;
      }
      md += `</details>\n\n`;
    } else {
      md += `**Fix ${i + 1}:** ${sanitizeInlineText(item.revert!)}\n\n`;
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

    const cleanedCode = cleanCodeSnippet(finding.codeSnippet.code);
    if (cleanedCode.trim()) {
      const codeFence = getCodeFence(cleanedCode);
      md += `**Existing prompt:**\n\n`;
      md += `${codeFence}\n${cleanedCode}\n${codeFence}\n\n`;
    }
  } else {
    md += `<h4>${finding.findingNumber}. ${title}</h4>\n\n`;
  }

  md += `**Suggested edit:** ${sanitizeInlineText(finding.consideration)}\n\n`;

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
): string {
  const withFindings = insights.filter(f => f.findings.length > 0);
  if (withFindings.length === 0 && !tableContent) return '';

  let md = `---\n### APPENDIX: FURTHER PROMPT IMPROVEMENTS\n\n`;

  if (tableContent) {
    md += tableContent;
  }

  for (const insight of withFindings) {
    md += `<details><summary><strong>${insight.factorName}</strong></summary>\n\n`;
    for (const finding of insight.findings) {
      md += formatFindingDetail(finding);
    }
    md += `</details>\n`;
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
): string {
  const enrichedInsights = mergeFindings(comp.synthesis.factorInsights, comp.factorResults);

  let md = formatHeader(
    comp.promptFile,
    comp.synthesis.promptDescription,
    comp.targetModelFamily,
    comp.targetModelName,
    prNumber,
  );

  // Verdict (based on changeSummary)
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
  const tableContent = formatTable(comp.factorResults, enrichedInsights);
  md += formatAllFindings(enrichedInsights, tableContent);

  return md;
}

export function formatPRComment(
  comparisons: ComparisonResult[],
  prNumber: number,
): string {
  let md = `${BOT_MARKER}\n`;

  for (const comp of comparisons) {
    md += formatPRFileSection(comp, prNumber);
    if (comparisons.length > 1) md += `\n---\n\n`;
  }

  // Truncate if needed
  if (md.length > PR_COMMENT_MAX_LENGTH) {
    md = md.substring(0, PR_COMMENT_MAX_LENGTH - 200);
    md += `\n\n---\n\n**Comment truncated.** See the Job Summary in the Actions tab for the full detailed report.\n`;
  }

  md += `\n*Hosho Bot — [hosho.ai](https://hosho.ai)*\n`;
  return md;
}

export function formatJobSummary(
  comparisons: ComparisonResult[],
  prNumber: number,
): string {
  let md = '';

  for (const comp of comparisons) {
    md += formatPRFileSection(comp, prNumber);
    if (comparisons.length > 1) md += `\n---\n\n`;
  }

  return md;
}

// Export the bot marker for comment deduplication
export { BOT_MARKER };
