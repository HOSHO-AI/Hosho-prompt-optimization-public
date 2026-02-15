// ---- Score Constants ----

export const SCORE_LABELS: Record<number, string> = {
  10: 'Good', 9: 'Good', 8: 'Good',           // Green zone (8-10)
  7: 'Needs Work', 6: 'Needs Work', 5: 'Needs Work',  // Yellow zone (5-7)
  4: 'Critical', 3: 'Critical', 2: 'Critical', 1: 'Critical',  // Red zone (1-4)
} as const;

export const OVERALL_SCORE_ORDER = ['Critical', 'Needs Work', 'Good', 'Excellent'] as const;

// ---- Assessment Types ----

export interface Assessment {
  assessmentId: string;
  question: string;
}

export interface Factor {
  factorId: string;
  factorName: string;
  factorDescription: string;
  assessments: Assessment[];
}

// ---- Claude Response Types (Factor Call) ----

export interface AssessmentResult {
  assessmentId: string;
  question: string;
  result: 'yes' | 'partial' | 'no';
  justification: string;
}

// ---- Finding Type ----

export interface Finding {
  findingNumber: number;
  description: string;
  codeSnippet?: {
    startLine: number;
    endLine: number;
    issue: string;
    code: string;
  };
  consideration: string;
  rewrittenCode?: string;
}

export interface FactorEvaluationResult {
  factorId: string;
  factorName: string;
  score: number;
  scoreLabel: string;
  tableRationale: string;
  findings: Finding[];
  assessments: AssessmentResult[];

  // PR mode fields (only present when diff provided)
  changeDirection?: 'improved' | 'no-change' | 'worse' | 'mixed';
  changeRationale?: string;
  changeDetails?: string[];
}

// ---- Claude Response Types (Synthesis Call) ----

export interface FactorInsight {
  factorId: string;
  factorName: string;
  score: number;
  scoreLabel: string;
  findings: Finding[];

  changeDirection?: 'improved' | 'no-change' | 'worse' | 'mixed';
  changeRationale?: string;
  changeDetails?: string[];
}

export interface SynthesisResult {
  promptName: string;
  promptFile: string;
  promptDescription: string;
  overallScore: string;
  hasCriticalIssues: boolean;
  factorInsights: FactorInsight[];
}

// ---- Comparison Types ----

export interface FactorDelta {
  factorId: string;
  factorName: string;
  beforeScore: number | null;
  afterScore: number;
  delta: number;
  beforeLabel: string | null;
  afterLabel: string;
}

export interface ComparisonResult {
  promptFile: string;
  isNewFile: boolean;
  synthesis: SynthesisResult;
  factorResults: FactorEvaluationResult[];
  deltas: FactorDelta[];
  hasRegression: boolean;
  hasCriticalIssue: boolean;
  promptContent?: string;
}

// ---- File Types ----

export interface PromptFileChange {
  filename: string;
  previousFilename?: string;
  status: 'added' | 'modified' | 'renamed';
}

export interface PromptFileContent {
  path: string;
  content: string;
}
