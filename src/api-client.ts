import * as core from '@actions/core';
import { ComparisonResult, ChangeItem, FactorEvaluationResult, SynthesisResult, CustomPrinciplesResult, MacroScore, Segment } from './types';

const DEFAULT_API_URL = 'https://2pdp5lkd4g5a4hi3aigcdxighe0ebgjy.lambda-url.us-east-1.on.aws/';
const MAX_RETRIES = 3;
const BACKOFF_DELAYS_MS = [5000, 10000, 20000]; // 5s, 10s, 20s

export { DEFAULT_API_URL };

export interface ReviewAPIRequest {
  apiKey: string;
  mode: 'pr' | 'on-demand';
  outputMode?: 'review' | 'improve';
  systemOverview?: string;
  customPrinciples?: string;
  files: Array<{
    path: string;
    name: string;
    status: 'added' | 'modified' | 'renamed';
    after: string;
    before: string | null;
    segments?: Segment[];
    // Per-file model, resolved deterministically from .github/hosho/models.yaml (models-config.ts).
    // When set, the Lambda honors it over its own Haiku inference (explicit > detected).
    targetModelFamily?: string;
    modelClass?: 'standard' | 'reasoning';
  }>;
  metadata?: { repository?: string; prNumber?: number; prTitle?: string; prDescription?: string; prFileSummary?: string };
  /** Caller identity stamped onto every cx.llm_costs row the request produces. */
  telemetry?: { callerKind?: string; clientName?: string; clientVersion?: string; runKind?: string; branch?: string };
  /**
   * What this call costs the customer's monthly allowance. 'action_pr' = a PR review, billed
   * ONCE PER EXECUTION rather than per file: `meterFirst` is true only on the first file's call,
   * so a 30-file PR is one PR review. Old pinned versions of this Action send neither field and
   * remain unmetered - upgrading is what starts the counting, never a surprise bill.
   */
  meterClass?: 'action_pr' | 'run';
  meterFirst?: boolean;
}

export interface ReviewFileResult {
  file: string;
  targetModelFamily?: string;
  targetModelName?: string;
  changeSummary?: ChangeItem[];
  scopeSummary?: string;
  factorResults: FactorEvaluationResult[];
  synthesis: SynthesisResult;
  comparison: ComparisonResult;
  customPrinciplesResult?: CustomPrinciplesResult;
  macroScores?: MacroScore[]; // v3 macro roll-up (improve mode)
  /** Review mode: whether each engine stage actually ran and parsed. Every stage fails OPEN on
   *  the engine side, so `main: 'failed'` is the only way to tell "found nothing" from "could not
   *  review" - and since the engine's per-stage Haiku fallback it means both transports failed. */
  pipeline?: ReviewPipelineStatus;
}

export interface ReviewPipelineStatus {
  coverage: 'ok' | 'empty' | 'failed' | 'skipped';
  enumerate: 'ok' | 'empty' | 'failed' | 'skipped';
  main: 'ok' | 'failed';
  customPrinciples?: 'ok' | 'failed' | 'skipped';
}

/**
 * How the action should treat a review result's pipeline status. `failed` ⇒ treat the file as
 * NOT reviewed: no comment section, no hash stamp, re-reviewed on the next push. Anything less
 * is a warning: the review landed, one supporting stage did not.
 *
 * Why this exists: a review whose main diff call failed comes back as status 'success' with
 * every factor no-change and an empty summary. Rendered, that is a green "Approve This PR", and
 * the hash stamp then hid the file from every later run until someone edited it.
 */
export function assessPipeline(result: Pick<ReviewFileResult, 'pipeline'> | undefined): { failed: boolean; warnings: string[] } {
  const p = result?.pipeline;
  if (!p) return { failed: false, warnings: [] };
  if (p.main === 'failed') return { failed: true, warnings: [] };
  const warnings: string[] = [];
  for (const stage of ['coverage', 'enumerate', 'customPrinciples'] as const) {
    if (p[stage] === 'failed') warnings.push(`${stage} stage failed; the review ran without it`);
  }
  return { failed: false, warnings };
}

export interface ReviewAPIResponse {
  status: 'success' | 'error';
  results?: ReviewFileResult[];
  message?: string;
}

/**
 * The monthly plan allowance is exhausted. Distinct from every other 4xx because it is the ONE
 * failure where continuing to the next file is wrong: the allowance is gone for the whole run.
 *
 * ⚠ IT IS NOT DETECTED BY STATUS CODE. The engine's per-key rate limiter also answers 429, is
 * live and enforcing, and a rate-limit blip must keep today's warn-and-continue behaviour - a
 * paying customer's PR review must not stop, and must never be shown an upgrade banner, because
 * their CI was briefly too fast. The cap sets `upgrade: true` in the body; nothing else does.
 */
export class PlanCapReachedError extends Error {
  readonly isPlanCap = true;
  constructor(message: string) {
    super(message);
    this.name = 'PlanCapReachedError';
  }
}

export async function callReviewAPI(
  apiUrl: string,
  request: ReviewAPIRequest,
  timeoutMs: number = 600_000
): Promise<ReviewAPIResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // A RETRY MUST NEVER RE-CLAIM THE UNIT. The engine consumes at the start of a request, so a
    // response lost in transit (abort, socket hang-up, a 5xx after the work ran) leaves the unit
    // already spent; re-sending `meterFirst` would spend a second one - up to three for a single
    // PR. Only the first attempt carries the claim.
    const attemptRequest = attempt === 0 ? request : { ...request, meterFirst: false };

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attemptRequest),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Don't retry 4xx — auth/validation errors won't self-heal
      if (response.status >= 400 && response.status < 500) {
        const data = await response.json().catch(() => ({}));
        const message = (data as any).message || `API error: ${response.status}`;
        // The plan cap, and ONLY the plan cap (see PlanCapReachedError): keyed on the body's
        // `upgrade` flag, never on the 429 status the rate limiter shares.
        if ((data as any).upgrade === true) throw new PlanCapReachedError(message);
        throw new Error(message);
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

/**
 * Fire-and-forget PR-bot beacon: counts only, no LLM call, no cost, no content.
 *
 * WHY. The action calls the Lambda directly, so `mcp_usage_events` never sees it — and on a dedupe
 * SKIP there is no request at all, so the reviews we AVOID leave no trace in any store. That means
 * the single number that says whether the content-hash dedupe is working (suppression rate) could
 * only be obtained by a hand census of GitHub Actions logs; it measured 42.4% on appsmith-v2.
 *
 * Deliberately fragile-by-design: 5-second timeout, every failure swallowed, never awaited in a way
 * that can fail the run. A telemetry write must not be able to turn a customer's PR check red.
 */
export async function sendBotEvent(
  apiUrl: string,
  apiKey: string,
  botEvent: {
    repository: string;
    prNumber?: number;
    event?: string;
    filesTotal: number;
    filesReviewed: number;
    filesSkipped: number;
    actionVersion?: string;
    /** The monthly PR-review allowance stopped this run part-way. */
    capBlocked?: boolean;
    skippedEntirely?: boolean;
    commentBytes?: number;
    stateEntries?: number;
  }
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, mode: 'pr', botEvent }),
      signal: controller.signal,
    });
  } catch {
    // Swallowed on purpose — see above. No core.warning either: a noisy telemetry failure in every
    // customer's log is worse than a missing counter.
  } finally {
    clearTimeout(timer);
  }
}
