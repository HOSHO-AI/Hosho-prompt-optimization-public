import * as core from '@actions/core';
import { ComparisonResult, FactorEvaluationResult, SynthesisResult } from './types';

const DEFAULT_API_URL = 'https://2pdp5lkd4g5a4hi3aigcdxighe0ebgjy.lambda-url.us-east-1.on.aws/';
const MAX_RETRIES = 3;
const BACKOFF_DELAYS_MS = [5000, 10000, 20000]; // 5s, 10s, 20s

export { DEFAULT_API_URL };

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
  request: ReviewAPIRequest,
  timeoutMs: number = 180_000
): Promise<ReviewAPIResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Don't retry 4xx — auth/validation errors won't self-heal
      if (response.status >= 400 && response.status < 500) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as any).message || `API error: ${response.status}`);
      }

      // Retry 5xx — server/Lambda transient errors
      if (response.status >= 500) {
        lastError = new Error(`API returned ${response.status}`);
        if (attempt < MAX_RETRIES - 1) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          core.warning(`API call failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}. Retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      const data = await response.json();
      return data as ReviewAPIResponse;
    } catch (error: unknown) {
      clearTimeout(timer);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Retry on timeout/abort and network errors
      if (isRetryableError(error)) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = BACKOFF_DELAYS_MS[attempt];
          core.warning(`API call failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}. Retrying in ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error('All retry attempts exhausted');
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
  if (error instanceof Error) {
    return (
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('socket hang up') ||
      error.message.includes('network') ||
      error.name === 'AbortError'
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
