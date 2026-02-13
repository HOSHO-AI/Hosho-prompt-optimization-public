import { ComparisonResult, FactorEvaluationResult, SynthesisResult } from './types';

export interface ReviewAPIRequest {
  apiKey: string;
  mode: 'pr' | 'on-demand';
  systemOverview?: string;
  files: Array<{
    path: string;
    name: string;
    status: 'added' | 'modified' | 'renamed';
    after: string;
    before: string | null;
  }>;
  metadata?: { repository?: string; prNumber?: number };
}

export interface ReviewFileResult {
  file: string;
  factorResults: FactorEvaluationResult[];
  synthesis: SynthesisResult;
  comparison: ComparisonResult;
}

export interface ReviewAPIResponse {
  status: 'success' | 'error';
  results?: ReviewFileResult[];
  message?: string;
}

export async function callReviewAPI(
  apiUrl: string,
  request: ReviewAPIRequest
): Promise<ReviewAPIResponse> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error((data as any).message || `API error: ${response.status}`);
  }

  return data as ReviewAPIResponse;
}
