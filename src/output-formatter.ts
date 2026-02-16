import {
  ComparisonResult,
  SynthesisResult,
  FactorEvaluationResult,
  FactorInsight,
} from './types';

const BOT_MARKER = '<!-- prompt-factor-reviewer-api -->';
const PR_COMMENT_MAX_LENGTH = 65000; // Leave buffer below 65536 limit

/**
 * Returns traffic light emoji based on score (1-10 scale).
 * 1-4: Critical (red), 5-7: Needs Work (yellow), 8-10: Good (green)
 */
function getTrafficLightEmoji(score: number): string {
  if (score <= 4) return '🔴';  // 1-4: Critical (red)
  if (score <= 7) return '🟡';  // 5-7: Needs Work (yellow)
  return '🟢';                   // 8-10: Good (green)
}

/**
 * Returns change emoji/label based on change direction.
 */
function getChangeEmoji(direction: 'improved' | 'no-change' | 'worse' | 'mixed'): string {
  if (direction === 'improved') return '✅ Improved';
  if (direction === 'worse') return '⚠️ Worse';
  if (direction === 'mixed') return '🔄 Mixed';
  return '➖ No change';
}

/**
 * Generates PR review verdict based on change direction.
 * In PR mode: REJECT if anything got worse or had mixed changes, ACCEPT otherwise
 * Returns empty string in on-demand mode (no verdict needed)
 */
function formatPRVerdict(factorInsights: FactorInsight[]): string {
  // Check if we're in PR mode
  const isPRMode = factorInsights.some(f => f.changeDirection);

  if (!isPRMode) {
    return ''; // On-demand mode - no verdict
  }

  // Check for any regressions (worse OR mixed)
  const worseFactors = factorInsights.filter(f => f.changeDirection === 'worse');
  const mixedFactors = factorInsights.filter(f => f.changeDirection === 'mixed');
  const regressingFactors = [...worseFactors, ...mixedFactors];

  if (regressingFactors.length > 0) {
    // Build specific regression message
    const parts: string[] = [];
    if (worseFactors.length > 0) {
      parts.push(`${worseFactors.map(f => f.factorName).join(', ')} regressed`);
    }
    if (mixedFactors.length > 0) {
      parts.push(`${mixedFactors.map(f => f.factorName).join(', ')} had mixed changes (includes regressions)`);
    }

    let verdict = `**Review verdict:** ⛔ REJECT — ${parts.join('; ')}.`;

    // Note what would be accepted
    const improvedFactors = factorInsights.filter(f => f.changeDirection === 'improved');
    if (improvedFactors.length > 0) {
      verdict += ` Remaining changes improve quality and would be accepted.`;
    }

    return verdict + '\n\n';
  }

  // No regressions — APPROVE with remaining issues count
  const remainingIssues = factorInsights.filter(f => f.score <= 4).length;  // 1-4 is red zone
  const opportunities = factorInsights.filter(f => f.score >= 5 && f.score <= 7).length;  // 5-7 is yellow zone

  let verdict = `**Review verdict:** ✅ APPROVE — Changes improve or maintain quality.`;

  if (remainingIssues > 0 || opportunities > 0) {
    const parts: string[] = [];
    if (remainingIssues > 0) {
      parts.push(`${remainingIssues} critical gap${remainingIssues === 1 ? '' : 's'}`);
    }
    if (opportunities > 0) {
      parts.push(`${opportunities} improvement opportunity${opportunities === 1 ? 'y' : 'ies'}`);
    }
    verdict += ` ${parts.join(' and ')} remain for future work.`;
  }

  return verdict + '\n\n';
}

/**
 * Removes common section header patterns from code snippets to reduce user confusion.
 *
 * When Claude extracts code snippets, it sometimes includes structural headers like
 * "3) Output (strict)" or "## Instructions". These confuse users because numbering
 * looks like finding numbers and labels lack context.
 *
 * @param code - Raw code snippet extracted by Claude
 * @returns Cleaned code with section headers removed
 */
function cleanCodeSnippet(code: string): string {
  const lines = code.split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Keep empty lines for formatting
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }

    // Skip if line matches section header patterns
    if (isSectionHeader(trimmed)) {
      continue;
    }

    cleaned.push(line);
  }

  const result = cleaned.join('\n').trim();

  // Safety: if we stripped everything, return original
  if (!result && code.trim()) {
    return code;
  }

  return result;
}

/**
 * Escapes triple backtick sequences in plain text to prevent
 * accidental code block creation inside <details> blocks.
 */
function sanitizeInlineText(text: string): string {
  if (!text) return text;
  return text.replace(/`{3,}/g, (match) => '\\`'.repeat(match.length));
}

/**
 * Returns a code fence delimiter that won't conflict with content.
 * If content contains ```, uses ```` (4 backticks), etc.
 */
function getCodeFence(content: string): string {
  let maxRun = 0;
  const matches = content.match(/`{3,}/g);
  if (matches) {
    for (const m of matches) {
      maxRun = Math.max(maxRun, m.length);
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

/**
 * Detects if a line matches common section header patterns.
 *
 * Conservative matching to avoid false positives:
 * - Must start at line beginning (no indentation)
 * - Must match known structural patterns
 * - Requires capital letter after marker for numbered sections
 */
function isSectionHeader(line: string): boolean {
  // Skip indented lines - likely code, not headers
  if (line !== line.trim()) {
    return false;
  }

  // Strip common annotations before pattern matching
  // This removes "(strict)", "(optional)", "(required)" etc.
  const cleanedLine = line.replace(/\s*\([^)]+\)\s*$/g, '').trim();

  // Pattern 1: Numbered sections with capital letter: "1) Output", "3) Instructions (strict)"
  // Does NOT match: "1) analyze input" (lowercase after marker)
  // Now matches "3) Output (strict)" because "(strict)" is stripped first
  if (/^\d+\)\s+[A-Z]/.test(cleanedLine)) {
    return true;
  }

  // Pattern 2a: Markdown headers with numbered sections: "## 3) Output", "### 2) Instructions"
  if (/^#{1,6}\s+\d+\)\s+[A-Z]/.test(cleanedLine)) {
    return true;
  }

  // Pattern 2b: Markdown headers: "# Section", "## Instructions", "### Details"
  if (/^#{1,6}\s+[A-Z]/.test(cleanedLine)) {
    return true;
  }

  // Pattern 3: Section labels with colons: "Output:", "Instructions:", "Process:"
  // Limit to reasonable header length (1-30 chars before colon)
  if (/^[A-Z][a-zA-Z\s]{1,30}:\s*$/.test(cleanedLine)) {
    return true;
  }

  // Pattern 4: Horizontal rules (markdown separators)
  if (/^-{3,}$/.test(line) || /^={3,}$/.test(line) || /^\*{3,}$/.test(line)) {
    return true;
  }

  return false;
}

/**
 * Merges authoritative findings from factorResults into factorInsights.
 * Synthesis may drop or fail to copy findings — factorResults are the source of truth.
 */
function mergeFindings(
  factorInsights: FactorInsight[],
  factorResults: FactorEvaluationResult[]
): FactorInsight[] {
  return factorInsights.map(insight => {
    const result = factorResults.find(fr => fr.factorId === insight.factorId);
    if (result) {
      return { ...insight, findings: result.findings };
    }
    return insight;
  });
}

// ---- PR Comment ----

export function formatPRComment(comparisons: ComparisonResult[]): string {
  const fileCount = comparisons.length;
  const factorCount = comparisons.length > 0 ? comparisons[0].factorResults.length : 0;

  let md = `${BOT_MARKER}\n`;
  md += `# PROMPT REVIEW\n\n`;
  md += `Reviewed ${fileCount} prompt file(s) against ${factorCount} factors.\n\n`;
  md += `---\n\n`;

  for (const comp of comparisons) {
    md += formatFileSection(comp);
    md += `\n---\n\n`;
  }

  // Truncate if needed
  if (md.length > PR_COMMENT_MAX_LENGTH) {
    md = md.substring(0, PR_COMMENT_MAX_LENGTH - 200);
    md += `\n\n---\n\n**Comment truncated.** See the Job Summary in the Actions tab for the full detailed report.\n`;
  }

  return md;
}

function formatFileSection(comp: ComparisonResult): string {
  const enrichedInsights = mergeFindings(comp.synthesis.factorInsights, comp.factorResults);

  let md = formatPromptHeader(comp.promptFile, comp.synthesis.promptDescription);
  md += formatEvaluationTable(comp.factorResults, enrichedInsights);

  // Add PR verdict right after table (PR mode only)
  md += formatPRVerdict(enrichedInsights);

  md += formatRecommendations(enrichedInsights, comp.promptFile);

  return md;
}

function formatPromptHeader(promptFile: string, description: string): string {
  // Strip any markdown code fences/blocks that would break subsequent rendering
  const safeDescription = description
    .replace(/```[\s\S]*?```/g, '')  // Strip code blocks
    .replace(/`{3,}/g, '')           // Strip orphan fence markers
    .replace(/\n/g, ' ')             // Collapse to single line
    .trim();
  return `## \`${promptFile}\`\n\n**Prompt overview:** ${safeDescription}\n\n`;
}

function formatEvaluationTable(
  factorResults: FactorEvaluationResult[],
  factorInsights: FactorInsight[]
): string {
  let md = `### Evaluation\n\n`;

  // Check if any factor has change direction (PR mode indicator)
  const isPRMode = factorInsights.some(f => f.changeDirection);

  if (isPRMode) {
    md += `| Factor | Factor Assessment | Impact of PR | Rationale |\n`;
    md += `|--------|-------------------|--------------|-----------|`;
  } else {
    md += `| Factor | Factor Assessment | Rationale |\n`;
    md += `|--------|-------------------|-----------|`;
  }

  for (const factor of factorResults) {
    const emoji = getTrafficLightEmoji(factor.score);
    const insight = factorInsights.find(f => f.factorId === factor.factorId);

    let rationale = factor.tableRationale;

    // In PR mode, prepend change rationale with full stop separator
    if (isPRMode && insight?.changeRationale) {
      const separator = insight.changeRationale.endsWith('.') ? ' ' : '. ';
      rationale = `${insight.changeRationale}${separator}${factor.tableRationale}`;
    }

    // Escape pipe characters to prevent breaking table columns
    const safeRationale = rationale.replace(/\|/g, '\\|');

    if (isPRMode && insight?.changeDirection) {
      const changeEmoji = getChangeEmoji(insight.changeDirection);
      md += `\n| **${factor.factorName}** | ${emoji} | ${changeEmoji} | ${safeRationale} |`;
    } else {
      md += `\n| **${factor.factorName}** | ${emoji} | ${safeRationale} |`;
    }
  }

  return md + `\n\n---\n\n`;
}

function formatRecommendations(
  factorInsights: FactorInsight[],
  promptFile: string
): string {
  const critical = factorInsights.filter(f => f.score <= 4);  // 1-4: Critical (red)
  const opportunities = factorInsights.filter(f => f.score >= 5 && f.score <= 7);  // 5-7: Needs Work (yellow)

  if (critical.length === 0 && opportunities.length === 0) {
    return ''; // No considerations needed
  }

  let md = `### Considerations\n\n`;

  if (critical.length > 0) {
    md += `#### 🔴 Major Gaps\n\n`;
    for (const factor of critical) {
      md += formatFactorFindings(factor, promptFile);
    }
  }

  if (opportunities.length > 0) {
    md += `#### 🟡 Opportunities to Improve\n\n`;
    for (const factor of opportunities) {
      md += formatFactorFindings(factor, promptFile);
    }
  }

  return md;
}

function formatFactorFindings(
  factor: FactorInsight,
  promptFile: string
): string {
  if (factor.findings.length === 0 && !factor.changeDetails) {
    return ''; // No findings and no PR changes
  }

  const findingCount = factor.findings.length;
  const hasChanges = factor.changeDetails && factor.changeDetails.length > 0;

  let label = '';
  if (hasChanges && findingCount > 0) {
    label = `${findingCount} improvement${findingCount === 1 ? '' : 's'} + PR changes`;
  } else if (hasChanges) {
    label = 'PR changes only';
  } else {
    label = findingCount === 1 ? '1 finding' : `${findingCount} findings`;
  }

  let md = `<details>\n`;
  md += `<summary><strong>${factor.factorName}</strong> — ${label}</summary>\n\n`;
  md += `<br>\n\n`;

  // Detect if we're in PR mode (changeDirection exists)
  const isPRMode = factor.changeDirection !== undefined;

  // Section 1: Changes in PR
  if (isPRMode) {
    md += `<h4>Changes in this PR</h4>\n\n`;

    if (hasChanges) {
      // Has meaningful changes - show bullet points
      for (const change of factor.changeDetails!) {
        md += `- ${sanitizeInlineText(change)}\n`;
      }
    } else {
      // PR mode but no meaningful changes - show brief statement
      md += `No observed changes in this PR.\n`;
    }

    md += `\n---\n\n`;
  }

  // Section 2: Further improvements (existing findings)
  if (factor.findings.length > 0) {
    if (isPRMode) {
      md += `<h4>Further improvements</h4>\n\n`;
    }

    for (const finding of factor.findings) {
      // Determine title: use short issue if available, else use description
      const title = finding.codeSnippet?.issue || finding.description;

      // Title is now short (3-5 words from codeSnippet.issue)
      md += `<h4>${finding.findingNumber}. ${title}</h4>\n\n`;

      // Code snippet (if present and not empty)
      if (finding.codeSnippet && finding.codeSnippet.code.trim()) {
        const lineRef = finding.codeSnippet.startLine === finding.codeSnippet.endLine
          ? `${finding.codeSnippet.startLine}`
          : `${finding.codeSnippet.startLine}-${finding.codeSnippet.endLine}`;

        // Include full description + "Prompt text example from"
        md += `**Assessment observation:** ${sanitizeInlineText(finding.description)}. Prompt text example from \`${promptFile}:${lineRef}\`\n\n`;

        // Clean section headers from code
        const cleanedCode = cleanCodeSnippet(finding.codeSnippet.code);

        // Render code block if non-empty (dynamic fence to avoid nested ``` conflicts)
        if (cleanedCode.trim()) {
          const codeFence = getCodeFence(cleanedCode);
          md += `${codeFence}\n${cleanedCode}\n${codeFence}\n\n`;
        }
      }

      // Recommendation
      md += `**Consideration:** ${sanitizeInlineText(finding.consideration)}\n\n`;

      // Proposed prompt edit (if present and not empty)
      if (finding.rewrittenCode && finding.rewrittenCode.trim()) {
        md += `**Proposed prompt edit:**\n\n`;
        const rewriteFence = getCodeFence(finding.rewrittenCode);
        md += `${rewriteFence}\n${finding.rewrittenCode}\n${rewriteFence}\n\n`;
      }

      md += `---\n\n`;
    }
  }

  md += `</details>\n\n`;

  return md;
}

// ---- Job Summary (PR mode) ----

export function formatJobSummary(
  comparisons: ComparisonResult[],
  model: string
): string {
  const fileCount = comparisons.length;
  const factorCount = comparisons.length > 0 ? comparisons[0].factorResults.length : 0;

  let md = `# PROMPT REVIEW\n\n`;
  md += `Reviewed ${fileCount} prompt file(s) against ${factorCount} factors.\n`;
  md += `Mode: Pull Request\n\n`;
  md += `---\n\n`;

  for (const comp of comparisons) {
    md += formatFileSection(comp);
    md += `\n---\n\n`;
  }

  return md;
}

// ---- On-Demand Summary ----

export function formatOnDemandSummary(
  synthesis: SynthesisResult,
  factorResults: FactorEvaluationResult[],
  model: string
): string {
  const factorCount = factorResults.length;

  let md = `# PROMPT REVIEW\n\n`;
  md += `Reviewed 1 prompt file against ${factorCount} factors.\n`;
  md += `Mode: On-Demand\n\n`;
  md += `---\n\n`;

  const enrichedInsights = mergeFindings(synthesis.factorInsights, factorResults);

  md += formatPromptHeader(synthesis.promptFile, synthesis.promptDescription);
  md += formatEvaluationTable(factorResults, enrichedInsights);
  md += formatRecommendations(enrichedInsights, synthesis.promptFile);

  md += `\n---\n\n`;

  return md;
}

// Export the bot marker for comment deduplication
export { BOT_MARKER };
