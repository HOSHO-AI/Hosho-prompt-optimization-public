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
    sourceFile?: string;
    sourceInChangeSet?: boolean;
  };
  consideration: string;
  rewrittenCode?: string;
  // v3 display-taxonomy tags (internal keys only; derived from assessmentId by the API).
  // Renderers prefer these; they fall back to the parent factor's name when absent.
  subFactor?: string;
  macroFactor?: string;
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

// ---- Assembly provenance manifest (mirrors engine Segment) ----

export interface Segment {
  source: string;
  kind: 'main' | 'skill' | 'sibling' | 'reference';
  blobStartLine: number;
  sourceStartLine: number;
}

// ---- Change Summary (from batch diff) ----

export interface ChangeItem {
  change: string;
  impact: string;
  effect: 'positive' | 'negative';
  category?: string; // LEGACY factor/principle label. Kept for back-compat + as the fallback
                     // tag when the v3 macro/sub tags below are absent.
  // v3 taxonomy tag: `assessmentId` is the criterion the API mapped this change to;
  // `subFactor`/`macroFactor` are derived from it. Renderers label "Macro — Sub" and
  // fall back to `category` when `macroFactor` is absent.
  assessmentId?: string;
  subFactor?: string;
  macroFactor?: string;
  revert?: string;
  revertDetail?: {
    currentCode: string;
    startLine: number;
    endLine: number;
    suggestedFix: string;
    rewrittenCode: string;
    sourceFile?: string;
    sourceInChangeSet?: boolean;
  };
}

// ---- Macro-native scorecard (v3, improve mode) ----

// Per-macro roll-up score sent by the API in improve mode. One of the 4 macros
// (scope / structure / guidance / coherence). Drives the 4-row macro score table.
export interface MacroScore {
  macro: string;        // 'scope' | 'structure' | 'guidance' | 'coherence'
  score: number;        // 1-10, rounded mean of the macro's sub-factors
  scoreLabel: string;
  subFactors: string[]; // sub-factor ids rolled into this macro
}

// ---- Custom Principles Result (improve mode) ----

export interface CustomPrinciplesResult {
  score: number;
  scoreLabel: string;
  tableRationale: string;
  findings: Finding[];
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
  targetModelFamily?: string;
  targetModelName?: string;
  changeSummary?: ChangeItem[];
  diffSnippet?: string;
  scopeSummary?: string;
  synthesis: SynthesisResult;
  factorResults: FactorEvaluationResult[];
  deltas: FactorDelta[];
  hasRegression: boolean;
  hasCriticalIssue: boolean;
  promptContent?: string;
  customPrinciplesResult?: CustomPrinciplesResult;
  macroScores?: MacroScore[]; // v3 macro roll-up (improve mode); drives the 4-row score table
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
