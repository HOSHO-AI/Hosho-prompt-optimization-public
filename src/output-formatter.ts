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

// ---- Helpers (unchanged) ----

function getTrafficLightEmoji(score: number): string {
  if (score <= 4) return '🔴';
  if (score <= 7) return '🟡';
  return '🟢';
}

function getChangeEmoji(direction: 'improved' | 'no-change' | 'worse' | 'mixed'): string {
  if (direction === 'improved') return '✅';
  if (direction === 'worse') return '⚠️ Worse';
  if (direction === 'mixed') return '🔄 Mixed';
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

function safeDescription(description: string): string {
  return description
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`{3,}/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

// ---- Finding types with parent context ----

interface TaggedFinding {
  finding: Finding;
  factorName: string;
  factorScore: number;
}

function gatherFindings(insights: FactorInsight[]): TaggedFinding[] {
  const all: TaggedFinding[] = [];
  for (const insight of insights) {
    for (const finding of insight.findings) {
      all.push({ finding, factorName: insight.factorName, factorScore: insight.score });
    }
  }
  // Sort by score ascending (lowest = most impactful)
  all.sort((a, b) => a.factorScore - b.factorScore);
  return all;
}

// ---- Format building blocks ----

function formatHeader(
  filename: string,
  description: string,
  targetModelFamily?: string,
  targetModelName?: string,
  prNumber?: number,
): string {
  const title = prNumber
    ? `## PR Review: #${prNumber} → ${filename}`
    : `## Prompt Review: ${filename}`;

  let md = `${title}\n`;
  md += `${safeDescription(description)}\n`;
  if (targetModelFamily) {
    const familyLabel = targetModelFamily.charAt(0).toUpperCase() + targetModelFamily.slice(1);
    if (targetModelName) {
      md += `Target model: ${familyLabel} (${targetModelName})\n`;
    } else {
      md += `Target model: ${familyLabel}\n`;
    }
  }
  md += '\n';
  return md;
}

function formatTable(
  factorResults: FactorEvaluationResult[],
  insights: FactorInsight[],
): string {
  const isPRMode = insights.some(f => f.changeDirection);

  let md = '';
  if (isPRMode) {
    md += `| Factor | PR Impact | Rating |\n`;
    md += `|---|---|---|`;
  } else {
    md += `| Factor | Rating |\n`;
    md += `|---|---|`;
  }

  for (const factor of factorResults) {
    const emoji = getTrafficLightEmoji(factor.score);
    const insight = insights.find(f => f.factorId === factor.factorId);

    if (isPRMode && insight?.changeDirection) {
      const changeEmoji = getChangeEmoji(insight.changeDirection);
      md += `\n| ${factor.factorName} | ${changeEmoji} | ${emoji} |`;
    } else {
      md += `\n| ${factor.factorName} | ${emoji} |`;
    }
  }

  md += '\n\n';
  return md;
}

function formatVerdict(insights: FactorInsight[]): string {
  const hasRegression = insights.some(
    f => f.changeDirection === 'worse' || f.changeDirection === 'mixed'
  );

  if (hasRegression) {
    return '### ⛔ REJECT\n\n';
  }
  return '### ✅ APPROVE\n\n';
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

  // Build the "why + what to do" from issue + consideration
  const parts: string[] = [];
  if (f.codeSnippet?.issue) {
    // Ensure issue ends without period, then add period
    const issue = f.codeSnippet.issue.replace(/\.+$/, '');
    parts.push(issue);
  }
  if (f.consideration) {
    parts.push(f.consideration.replace(/\.+$/, ''));
  }
  const body = parts.join('. ') + '.';

  if (sectionRef) {
    return `**${sanitizeInlineText(title)}** (${sectionRef}) — ${sanitizeInlineText(body)}`;
  }
  return `**${sanitizeInlineText(title)}** — ${sanitizeInlineText(body)}`;
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

  let md = '### What changed\n\n';
  for (const item of changeSummary) {
    const emoji = item.effect === 'positive' ? '✅' : item.effect === 'negative' ? '❌' : '⚠️';
    const change = sanitizeInlineText(item.change);
    const impact = item.impact ? ` — ${sanitizeInlineText(item.impact)}` : '';
    md += `- ${emoji} ${change}${impact}\n`;
  }
  md += '\n';
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
      md += `${codeFence}\n${cleanedCode}\n${codeFence}\n\n`;
    }
  } else {
    md += `<h4>${finding.findingNumber}. ${title}</h4>\n\n`;
  }

  md += `**Potential prompt edit:** ${sanitizeInlineText(finding.consideration)}\n\n`;

  if (finding.rewrittenCode && finding.rewrittenCode.trim()) {
    const rewriteFence = getCodeFence(finding.rewrittenCode);
    md += `${rewriteFence}\n${finding.rewrittenCode}\n${rewriteFence}\n\n`;
  }

  md += `---\n\n`;
  return md;
}

function formatCollapsedFindings(
  insights: FactorInsight[],
  summaryLabel: string,
): string {
  // Gather insights that have findings
  const withFindings = insights.filter(f => f.findings.length > 0);
  if (withFindings.length === 0) return '';

  const totalFindings = withFindings.reduce((sum, f) => sum + f.findings.length, 0);
  const factorCount = withFindings.length;

  let md = `<details><summary>${summaryLabel} (${totalFindings} across ${factorCount} factor${factorCount === 1 ? '' : 's'})</summary>\n\n`;
  md += `<br>\n\n`;

  for (const insight of withFindings) {
    md += `#### ${insight.factorName}\n\n`;
    for (const finding of insight.findings) {
      md += formatFindingDetail(finding);
    }
  }

  md += `</details>\n\n`;
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
    md += `### Top ${Math.min(3, allFindings.length)} edit${allFindings.length === 1 ? '' : 's'}\n\n`;
    md += formatTopEdits(allFindings, 3);
  }

  // Collapsed detail
  md += formatCollapsedFindings(enrichedInsights, 'All findings');

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

  // Verdict
  md += formatVerdict(enrichedInsights);

  // Table
  md += formatTable(comp.factorResults, enrichedInsights);

  // What changed
  md += formatWhatChanged(comp.changeSummary);

  // Split findings: PR-caused vs pre-existing
  const prCausedInsights = enrichedInsights.filter(
    f => f.changeDirection === 'worse' || f.changeDirection === 'mixed'
  );
  const otherInsights = enrichedInsights.filter(
    f => f.changeDirection !== 'worse' && f.changeDirection !== 'mixed'
  );

  // Fix before merging (PR-caused findings only)
  const prFindings = gatherFindings(prCausedInsights);
  if (prFindings.length > 0) {
    md += `### Fix before merging\n\n`;
    md += formatTopEdits(prFindings, 3);
  }

  // Further improvements (non-PR findings, collapsed)
  const otherWithFindings = otherInsights.filter(f => f.findings.length > 0);
  if (otherWithFindings.length > 0) {
    md += `### Further improvements — not blocking this PR\n\n`;
    md += formatCollapsedFindings(otherInsights, 'Expand further improvements');
  }

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
