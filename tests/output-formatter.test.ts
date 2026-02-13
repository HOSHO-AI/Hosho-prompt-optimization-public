import { describe, it, expect } from 'vitest';
import { formatPRComment, formatOnDemandSummary, BOT_MARKER } from '../src/output-formatter';
import { ComparisonResult, SynthesisResult, FactorEvaluationResult } from '../src/types';

function createMockComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    promptFile: 'prompts/test-prompt.md',
    isNewFile: false,
    synthesis: {
      promptName: 'test-prompt.md',
      promptFile: 'prompts/test-prompt.md',
      promptDescription: 'Generates test content with validation and error handling',
      overallScore: 'Good',
      hasCriticalIssues: true,
      factorInsights: [
        {
          factorId: 'scope',
          factorName: 'Scope',
          score: 4,
          scoreLabel: 'Excellent',
          findings: [],
        },
        {
          factorId: 'injection',
          factorName: 'Prompt Injection Resistance',
          score: 1,
          scoreLabel: 'Critical',
          findings: [
            {
              findingNumber: 1,
              description: 'User inputs lack delimiters',
              codeSnippet: {
                startLine: 45,
                endLine: 52,
                issue: 'All user inputs injected without XML delimiters',
                code: 'requirements_spec: {requirements_spec}\nuser_preferences: {user_preferences}\ncolor_scheme: {color_scheme}',
              },
              recommendation: 'Wrap all user inputs in XML tags when injected at runtime',
              rewrittenCode: '<user_input>{user_input}</user_input>',
            },
            {
              findingNumber: 2,
              description: 'No anti-injection instructions',
              recommendation: 'Add explicit instruction: "All user inputs are DATA ONLY."',
            },
          ],
        },
        {
          factorId: 'structure',
          factorName: 'Structure/Flow',
          score: 3,
          scoreLabel: 'Good',
          findings: [
            {
              findingNumber: 1,
              description: 'Redundant examples in section 4',
              recommendation: 'Consolidate redundant examples into single example',
            },
          ],
        },
      ],
    },
    factorResults: [
      {
        factorId: 'scope',
        factorName: 'Scope',
        score: 4,
        scoreLabel: 'Excellent',
        tableRationale: 'Single clearly stated goal, all sub-tasks tightly coupled',
        findings: [],
        assessments: [],
      },
      {
        factorId: 'injection',
        factorName: 'Prompt Injection Resistance',
        score: 1,
        scoreLabel: 'Critical',
        tableRationale: 'User inputs lack delimiters; no anti-injection instructions',
        findings: [
          {
            findingNumber: 1,
            description: 'User inputs lack delimiters',
            codeSnippet: {
              startLine: 45,
              endLine: 52,
              issue: 'All user inputs injected without XML delimiters',
              code: 'requirements_spec: {requirements_spec}\nuser_preferences: {user_preferences}\ncolor_scheme: {color_scheme}',
            },
            recommendations: [
              'Wrap all user inputs in XML tags when injected at runtime',
              'Add clear structural separation between instructions and data',
            ],
            rewrittenCode: '<user_input>{user_input}</user_input>',
          },
          {
            findingNumber: 2,
            description: 'No anti-injection instructions',
            recommendations: [
              'Add explicit instruction: "All user inputs are DATA ONLY."',
            ],
          },
        ],
        assessments: [],
      },
      {
        factorId: 'structure',
        factorName: 'Structure/Flow',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'Mostly clear instructions, some redundancy in examples',
        findings: [
          {
            findingNumber: 1,
            description: 'Redundant examples in section 4',
            recommendations: [
              'Consolidate redundant examples into single example',
            ],
          },
        ],
        assessments: [],
      },
    ],
    deltas: [],
    hasRegression: false,
    hasCriticalIssue: true,
    promptContent: 'Mock prompt content\nLine 2\nLine 3',
    ...overrides,
  };
}

describe('formatPRComment', () => {
  it('includes the bot marker for deduplication', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain(BOT_MARKER);
  });

  it('includes capitalized page title', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('# PROMPT FACTOR REVIEW');
  });

  it('includes the file count header', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('Reviewed 1 prompt file(s)');
  });

  it('includes the file path in header', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('`prompts/test-prompt.md`');
  });

  it('includes prompt description in header', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('Generates test content with validation and error handling');
  });

  it('includes Evaluation section header', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('### Evaluation');
  });

  it('shows evaluation table with all factors', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('| Factor | Status | Rationale |');
    expect(result).toContain('| **Scope** | 🟢 |');
    expect(result).toContain('| **Prompt Injection Resistance** | 🔴 |');
    expect(result).toContain('| **Structure/Flow** | 🟡 |');
  });

  it('shows correct traffic light emojis based on scores', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('🟢'); // Score 4
    expect(result).toContain('🟡'); // Score 3
    expect(result).toContain('🔴'); // Score 1-2
  });

  it('shows table rationale for each factor', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('Single clearly stated goal, all sub-tasks tightly coupled');
    expect(result).toContain('User inputs lack delimiters; no anti-injection instructions');
    expect(result).toContain('Mostly clear instructions, some redundancy in examples');
  });

  it('includes Recommendations section', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('### Recommendations');
  });

  it('shows Major Gaps section for critical factors', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('#### 🔴 Major Gaps');
    expect(result).toContain('**Prompt Injection Resistance**');
  });

  it('shows Opportunities section for score 3 factors', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('#### 🟡 Opportunities to Improve');
    expect(result).toContain('**Structure/Flow**');
  });

  it('does NOT show factors with score 4 in recommendations', () => {
    const result = formatPRComment([createMockComparison()]);
    // Scope has score 4, should not appear in recommendations
    const recommendationsSection = result.split('### Recommendations')[1];
    expect(recommendationsSection).not.toContain('**Scope**');
  });

  it('shows numbered findings for each factor', () => {
    const result = formatPRComment([createMockComparison()]);
    // Now uses short issue as title instead of long description
    expect(result).toContain('### 1. All user inputs injected without XML delimiters');
    expect(result).toContain('### 2. No anti-injection instructions');
  });

  it('shows code snippets with line references', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('Prompt text example from `prompts/test-prompt.md:45-52`');
  });

  it('shows recommendations for findings', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('**Recommendation:**');
    expect(result).toContain('Wrap all user inputs in XML tags when injected at runtime');
  });

  it('shows rewritten code for findings that have it', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('**Rewritten code:**');
    expect(result).toContain('<user_input>{user_input}</user_input>');
  });

  it('shows REQUEST_CHANGES verdict when critical issues exist', () => {
    const result = formatPRComment([createMockComparison()]);
    expect(result).toContain('REQUEST_CHANGES');
  });

  it('shows COMMENT verdict when no critical issues', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test-prompt.md',
        promptFile: 'prompts/test-prompt.md',
        promptDescription: 'Clean prompt with no critical issues',
        overallScore: 'Excellent',
        hasCriticalIssues: false,
        factorInsights: [
          {
            factorId: 'scope',
            factorName: 'Scope',
            score: 4,
            scoreLabel: 'Excellent',
            findings: [],
          },
        ],
      },
      factorResults: [
        {
          factorId: 'scope',
          factorName: 'Scope',
          score: 4,
          scoreLabel: 'Excellent',
          tableRationale: 'Perfect scope definition',
          findings: [],
          assessments: [],
        },
      ],
    });
    const result = formatPRComment([comp]);
    expect(result).toContain('COMMENT');
    expect(result).not.toContain('REQUEST_CHANGES');
  });

  it('does not show recommendations section when all factors score 4', () => {
    const comp = createMockComparison({
      synthesis: {
        promptName: 'test-prompt.md',
        promptFile: 'prompts/test-prompt.md',
        promptDescription: 'Generates test content with validation and error handling',
        overallScore: 'Excellent',
        hasCriticalIssues: false,
        factorInsights: [
          {
            factorId: 'scope',
            factorName: 'Scope',
            score: 4,
            scoreLabel: 'Excellent',
            findings: [],
          },
        ],
      },
      factorResults: [
        {
          factorId: 'scope',
          factorName: 'Scope',
          score: 4,
          scoreLabel: 'Excellent',
          tableRationale: 'Perfect',
          findings: [],
          assessments: [],
        },
      ],
    });
    const result = formatPRComment([comp]);
    expect(result).not.toContain('### Recommendations');
  });
});

describe('formatOnDemandSummary', () => {
  it('includes on-demand mode header', () => {
    const synthesis: SynthesisResult = {
      promptName: 'test.md',
      promptFile: 'prompts/test.md',
      promptDescription: 'Test prompt for validation',
      overallScore: 'Good',
      hasCriticalIssues: false,
      factorInsights: [
        {
          factorId: 'scope',
          factorName: 'Scope',
          score: 4,
          scoreLabel: 'Excellent',
          findings: [],
        },
      ],
    };
    const factorResults: FactorEvaluationResult[] = [
      {
        factorId: 'scope',
        factorName: 'Scope',
        score: 4,
        scoreLabel: 'Excellent',
        tableRationale: 'Clear goal',
        findings: [],
        assessments: [],
      },
    ];

    const result = formatOnDemandSummary(synthesis, factorResults, 'claude-opus-4-6');
    expect(result).toContain('Mode: On-Demand');
    expect(result).toContain('claude-opus-4-6');
  });

  it('includes prompt description', () => {
    const synthesis: SynthesisResult = {
      promptName: 'test.md',
      promptFile: 'prompts/test.md',
      promptDescription: 'Generates content with style and tone validation',
      overallScore: 'Good',
      hasCriticalIssues: false,
      factorInsights: [],
    };

    const result = formatOnDemandSummary(synthesis, [], 'claude-opus-4-6');
    expect(result).toContain('Generates content with style and tone validation');
  });

  it('includes evaluation table', () => {
    const synthesis: SynthesisResult = {
      promptName: 'test.md',
      promptFile: 'prompts/test.md',
      promptDescription: 'Test prompt',
      overallScore: 'Good',
      hasCriticalIssues: false,
      factorInsights: [
        {
          factorId: 'scope',
          factorName: 'Scope',
          score: 3,
          scoreLabel: 'Good',
          findings: [],
        },
      ],
    };
    const factorResults: FactorEvaluationResult[] = [
      {
        factorId: 'scope',
        factorName: 'Scope',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'Mostly clear',
        findings: [],
        assessments: [],
      },
    ];

    const result = formatOnDemandSummary(synthesis, factorResults, 'claude-opus-4-6');
    expect(result).toContain('### Evaluation');
    expect(result).toContain('| **Scope** | 🟡 | Mostly clear |');
  });

  it('includes recommendations for problematic factors', () => {
    const synthesis: SynthesisResult = {
      promptName: 'test.md',
      promptFile: 'prompts/test.md',
      promptDescription: 'Test prompt',
      overallScore: 'Needs Work',
      hasCriticalIssues: true,
      factorInsights: [
        {
          factorId: 'injection',
          factorName: 'Prompt Injection Resistance',
          score: 2,
          scoreLabel: 'Needs Work',
          findings: [
            {
              findingNumber: 1,
              description: 'No input delimiters',
              recommendation: 'Add XML tags',
            },
          ],
        },
      ],
    };
    const factorResults: FactorEvaluationResult[] = [
      {
        factorId: 'injection',
        factorName: 'Prompt Injection Resistance',
        score: 2,
        scoreLabel: 'Needs Work',
        tableRationale: 'Missing delimiters',
        findings: [
          {
            findingNumber: 1,
            description: 'No input delimiters',
            recommendation: 'Add XML tags',
          },
        ],
        assessments: [],
      },
    ];

    const result = formatOnDemandSummary(synthesis, factorResults, 'claude-opus-4-6');
    expect(result).toContain('### Recommendations');
    expect(result).toContain('🔴 Major Gaps');
    expect(result).toContain('**Prompt Injection Resistance**');
    expect(result).toContain('### 1. No input delimiters');
  });
});

describe('Section Header Cleaning Integration', () => {
  it('removes section headers from code snippets in PR comment output', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test-prompt.md',
        promptFile: 'prompts/test-prompt.md',
        promptDescription: 'Test prompt with section headers in code',
        overallScore: 'Needs Work',
        hasCriticalIssues: false,
        factorInsights: [
          {
            factorId: 'constraints',
            factorName: 'Constraints',
            score: 2,
            scoreLabel: 'Needs Work',
            findings: [
              {
                findingNumber: 1,
                description: 'Conflicting constraints',
                codeSnippet: {
                  startLine: 45,
                  endLine: 52,
                  issue: 'Must be concise vs comprehensive',
                  code: '3) Requirements (strict)\n\n---\n\n- Keep responses under 100 words\n- Be comprehensive and cover all edge cases',
                },
                recommendation: 'Add priority order for constraints',
                rewrittenCode: '# Requirements\n- Primary: Keep under 100 words\n- Secondary: Cover edge cases where brevity allows',
              },
            ],
          },
        ],
      },
      factorResults: [
        {
          factorId: 'constraints',
          factorName: 'Constraints',
          score: 2,
          scoreLabel: 'Needs Work',
          tableRationale: 'Conflicting constraints',
          findings: [
            {
              findingNumber: 1,
              description: 'Conflicting constraints',
              codeSnippet: {
                startLine: 45,
                endLine: 52,
                issue: 'Must be concise vs comprehensive',
                code: '3) Requirements (strict)\n\n---\n\n- Keep responses under 100 words\n- Be comprehensive and cover all edge cases',
              },
              recommendations: ['Add priority order for constraints'],
              rewrittenCode: '# Requirements\n- Primary: Keep under 100 words\n- Secondary: Cover edge cases where brevity allows',
            },
          ],
          assessments: [],
        },
      ],
    });

    const result = formatPRComment([comp]);

    // Should NOT contain section header or horizontal rule
    expect(result).not.toContain('3) Requirements (strict)');
    expect(result).not.toContain('---\n\n- Keep'); // horizontal rule before content

    // SHOULD contain actual content (preserved)
    expect(result).toContain('Keep responses under 100 words');
    expect(result).toContain('Be comprehensive and cover all edge cases');

    // Should use new formatting improvements
    expect(result).toContain('### 1. Must be concise vs comprehensive'); // ### header with short issue as title
    expect(result).toContain('**Assessment observation:** Conflicting constraints. Prompt text example from `prompts/test-prompt.md:45-52`'); // New label with full description
    expect(result).toContain('**Recommendation:** Add priority order for constraints');
    expect(result).toContain('**Rewritten code:**');
  });

  it('preserves legitimate code that looks like headers', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test-prompt.md',
        promptFile: 'prompts/test-prompt.md',
        promptDescription: 'Test with legitimate numbered list',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [
          {
            factorId: 'structure',
            factorName: 'Structure/Flow',
            score: 3,
            scoreLabel: 'Good',
            findings: [
              {
                findingNumber: 1,
                description: 'Instructions could be clearer',
                codeSnippet: {
                  startLine: 10,
                  endLine: 15,
                  issue: 'Instruction list formatting',
                  code: '1) analyze the input carefully\n2) extract key entities\n3) generate output in JSON format',
                },
                recommendation: 'Use numbered list format',
              },
            ],
          },
        ],
      },
      factorResults: [
        {
          factorId: 'structure',
          factorName: 'Structure/Flow',
          score: 3,
          scoreLabel: 'Good',
          tableRationale: 'Clear instructions',
          findings: [
            {
              findingNumber: 1,
              description: 'Instructions could be clearer',
              codeSnippet: {
                startLine: 10,
                endLine: 15,
                issue: 'Instruction list formatting',
                code: '1) analyze the input carefully\n2) extract key entities\n3) generate output in JSON format',
              },
              recommendations: ['Use numbered list format'],
            },
          ],
          assessments: [],
        },
      ],
    });

    const result = formatPRComment([comp]);

    // SHOULD preserve lowercase numbered instructions (not headers)
    expect(result).toContain('1) analyze the input carefully');
    expect(result).toContain('2) extract key entities');
    expect(result).toContain('3) generate output in JSON format');
  });

  it('handles edge case where all lines are headers (returns original)', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test-prompt.md',
        promptFile: 'prompts/test-prompt.md',
        promptDescription: 'Edge case test',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [
          {
            factorId: 'structure',
            factorName: 'Structure/Flow',
            score: 3,
            scoreLabel: 'Good',
            findings: [
              {
                findingNumber: 1,
                description: 'All headers edge case',
                codeSnippet: {
                  startLine: 5,
                  endLine: 10,
                  issue: 'Only section markers',
                  code: '## Instructions\n\n---\n\n3) Output',
                },
                recommendation: 'Add actual content',
              },
            ],
          },
        ],
      },
      factorResults: [
        {
          factorId: 'structure',
          factorName: 'Structure/Flow',
          score: 3,
          scoreLabel: 'Good',
          tableRationale: 'Edge case',
          findings: [
            {
              findingNumber: 1,
              description: 'All headers edge case',
              codeSnippet: {
                startLine: 5,
                endLine: 10,
                issue: 'Only section markers',
                code: '## Instructions\n\n---\n\n3) Output',
              },
              recommendations: ['Add actual content'],
            },
          ],
          assessments: [],
        },
      ],
    });

    const result = formatPRComment([comp]);

    // When all lines are headers, safety check returns original
    // Should contain the original code (not stripped to empty)
    expect(result).toContain('## Instructions');
    expect(result).toContain('3) Output');
  });
});

describe('Annotation Stripping and Title Restructuring', () => {
  it('removes annotations like (strict) from section headers', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test.md',
        promptFile: 'prompts/test.md',
        promptDescription: 'Test annotation removal',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [{
          factorId: 'constraints',
          factorName: 'Constraints',
          score: 3,
          scoreLabel: 'Good',
          findings: [{
            findingNumber: 1,
            description: 'Missing validation before output',
            codeSnippet: {
              startLine: 40,
              endLine: 44,
              issue: 'No validation step',
              code: '## 3) Output (strict)\n\nReturn only valid JSON.',
            },
            recommendation: 'Add validation step',
          }],
        }],
      },
      factorResults: [{
        factorId: 'constraints',
        factorName: 'Constraints',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'Missing validation',
        findings: [{
          findingNumber: 1,
          description: 'Missing validation before output',
          codeSnippet: {
            startLine: 40,
            endLine: 44,
            issue: 'No validation step',
            code: '## 3) Output (strict)\n\nReturn only valid JSON.',
          },
          recommendations: ['Add validation step'],
        }],
        assessments: [],
      }],
    });

    const result = formatPRComment([comp]);

    // Should NOT contain "(strict)" annotation or section header
    expect(result).not.toContain('3) Output (strict)');
    expect(result).not.toContain('## 3) Output');

    // SHOULD contain actual content
    expect(result).toContain('Return only valid JSON');
  });

  it('uses short issue as title and long description in observation', () => {
    const comp = createMockComparison({
      promptFile: 'prompts/test.md',
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test.md',
        promptFile: 'prompts/test.md',
        promptDescription: 'Test title restructure',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [{
          factorId: 'output-validation',
          factorName: 'Output Validation',
          score: 3,
          scoreLabel: 'Good',
          findings: [{
            findingNumber: 1,
            description: 'No self-check or validation step before producing final output',
            codeSnippet: {
              startLine: 40,
              endLine: 44,
              issue: 'Missing validation step',
              code: 'Return JSON output immediately.',
            },
            recommendation: 'Add validation step',
          }],
        }],
      },
      factorResults: [{
        factorId: 'output-validation',
        factorName: 'Output Validation',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'No validation',
        findings: [{
          findingNumber: 1,
          description: 'No self-check or validation step before producing final output',
          codeSnippet: {
            startLine: 40,
            endLine: 44,
            issue: 'Missing validation step',
            code: 'Return JSON output immediately.',
          },
          recommendations: ['Add validation step'],
        }],
        assessments: [],
      }],
    });

    const result = formatPRComment([comp]);

    // Title should use SHORT issue
    expect(result).toContain('### 1. Missing validation step');

    // Observation should include LONG description + new label
    expect(result).toContain('**Assessment observation:** No self-check or validation step before producing final output. Prompt text example from `prompts/test.md:40-44`');

    // Should NOT use "Code from" label anymore
    expect(result).not.toContain('Code from `prompts/test.md:40-44`');
  });

  it('handles findings without code snippets (fallback to description)', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test.md',
        promptFile: 'prompts/test.md',
        promptDescription: 'Test fallback behavior',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [{
          factorId: 'scope',
          factorName: 'Scope',
          score: 3,
          scoreLabel: 'Good',
          findings: [{
            findingNumber: 1,
            description: 'Prompt has multiple unrelated goals',
            // NO codeSnippet - should fallback to description as title
            recommendation: 'Split into separate prompts',
          }],
        }],
      },
      factorResults: [{
        factorId: 'scope',
        factorName: 'Scope',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'Multiple goals',
        findings: [{
          findingNumber: 1,
          description: 'Prompt has multiple unrelated goals',
          recommendations: ['Split into separate prompts'],
        }],
        assessments: [],
      }],
    });

    const result = formatPRComment([comp]);

    // Should use description as title (fallback)
    expect(result).toContain('### 1. Prompt has multiple unrelated goals');

    // Should NOT show observation line (no code snippet)
    expect(result).not.toContain('**Assessment observation:**');

    // Should still show recommendation
    expect(result).toContain('**Recommendation:** Split into separate prompts');
  });

  it('handles findings with empty issue field (fallback to description)', () => {
    const comp = createMockComparison({
      hasCriticalIssue: false,
      synthesis: {
        promptName: 'test.md',
        promptFile: 'prompts/test.md',
        promptDescription: 'Test empty issue',
        overallScore: 'Good',
        hasCriticalIssues: false,
        factorInsights: [{
          factorId: 'constraints',
          factorName: 'Constraints',
          score: 3,
          scoreLabel: 'Good',
          findings: [{
            findingNumber: 1,
            description: 'Constraint lacks positive framing',
            codeSnippet: {
              startLine: 10,
              endLine: 12,
              issue: '',  // Empty issue field
              code: 'Do not use abbreviations.',
            },
            recommendation: 'Rephrase positively',
          }],
        }],
      },
      factorResults: [{
        factorId: 'constraints',
        factorName: 'Constraints',
        score: 3,
        scoreLabel: 'Good',
        tableRationale: 'Negative framing',
        findings: [{
          findingNumber: 1,
          description: 'Constraint lacks positive framing',
          codeSnippet: {
            startLine: 10,
            endLine: 12,
            issue: '',
            code: 'Do not use abbreviations.',
          },
          recommendations: ['Rephrase positively'],
        }],
        assessments: [],
      }],
    });

    const result = formatPRComment([comp]);

    // Should fallback to description as title (issue is empty)
    expect(result).toContain('### 1. Constraint lacks positive framing');

    // Should still show observation with full description
    expect(result).toContain('**Assessment observation:** Constraint lacks positive framing. Prompt text example from');
  });
});
