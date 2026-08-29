import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@actions/core', () => ({
  info: vi.fn(), warning: vi.fn(), error: vi.fn(), setFailed: vi.fn(), debug: vi.fn(),
  getInput: vi.fn(() => ''), summary: { addRaw: vi.fn(() => ({ write: vi.fn() })) },
}));

import { callReviewAPI, PlanCapReachedError } from '../src/api-client';
import { formatPRComment } from '../src/output-formatter';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });
beforeEach(() => vi.clearAllMocks());

function respond(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status < 400,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('a cap 429 and a rate-limit 429 are NOT the same thing', () => {
  // THE TRAP THIS PINS: the engine's per-key rate limiter is live, enforcing, and answers 429
  // too. Keying the abort on the status code would turn a rate-limit blip into "we stopped
  // reviewing your PR" plus a misleading upgrade banner - for a paying customer whose CI was
  // briefly too fast. The cap sets `upgrade: true`; nothing else does.
  it('throws the typed cap error ONLY when the body says upgrade', async () => {
    respond(429, { status: 'error', message: 'Monthly limit reached - 51 of 50 PR reviews', upgrade: true });
    await expect(callReviewAPI('https://x', { apiKey: 'k', mode: 'pr' } as never))
      .rejects.toBeInstanceOf(PlanCapReachedError);
  });

  it('treats a rate-limit 429 as an ordinary error, exactly as before', async () => {
    respond(429, { status: 'error', message: 'Rate limit exceeded - retry shortly' });
    const err = await callReviewAPI('https://x', { apiKey: 'k', mode: 'pr' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PlanCapReachedError);
    expect(err.message).toContain('Rate limit exceeded');
  });

  it('treats an auth 403 as an ordinary error', async () => {
    respond(403, { status: 'error', message: 'This API key has been disabled.' });
    const err = await callReviewAPI('https://x', { apiKey: 'k', mode: 'pr' } as never).catch((e) => e);
    expect(err).not.toBeInstanceOf(PlanCapReachedError);
  });
});

describe('the review loop bills once per execution and stops only on the cap', () => {
  const src = readFileSync(join(__dirname, '..', 'src/index.ts'), 'utf8');

  it('stamps action_pr on every call but meterFirst only on the first', () => {
    expect(src).toContain("meterClass: 'action_pr'");
    expect(src).toMatch(/meterFirst: allResults\.length === 0 && failedPaths\.size === 0/);
  });

  it('aborts the remaining files on the cap - and leaves them UNSTAMPED so they come back', () => {
    // Reviewing 29 of 30 files and marking the 30th as done would hide a real gap.
    expect(src).toContain('PlanCapReachedError');
    expect(src).toMatch(/if \(capMessage\) \{[\s\S]{0,500}failedPaths\.add\(file\.path\)/);
  });

  it('keeps warn-and-continue for every OTHER failure', () => {
    expect(src).toMatch(/Failed to review \$\{file\.name\}: \$\{msg\}\. Skipping\./);
  });
});

describe('the PR comment says why the review is short', () => {
  // A minimally-complete ComparisonResult. The formatter walks BOTH synthesis.factorInsights and
  // factorResults, so both must exist - a stub that omits either passes by not reaching the code
  // the banner lives in.
  const comparisons = [{
    promptFile: 'prompts/agent.md',
    isNewFile: false,
    scopeSummary: 'one change',
    factorResults: [],
    synthesis: {
      promptName: 'agent.md',
      promptFile: 'prompts/agent.md',
      promptDescription: 'An agent prompt',
      overallScore: 'Good',
      hasCriticalIssues: false,
      factorInsights: [],
    },
  }] as never;

  it('renders a cap banner at the top, naming the unreviewed files', () => {
    const md = formatPRComment(comparisons, 42, 'acme/repo', undefined, undefined, {
      message: 'Monthly limit reached - 51 of 50 PR reviews on the Free plan.',
      unreviewed: ['prompts/b.md', 'prompts/c.md'],
    });
    expect(md).toContain('Monthly PR-review allowance reached');
    expect(md).toContain('51 of 50 PR reviews');
    expect(md).toContain('prompts/b.md');
    expect(md).toContain('next push');
    // Above the per-file sections - it is the first thing a reader needs.
    expect(md.indexOf('allowance reached')).toBeLessThan(md.indexOf('prompts/agent.md'));
  });

  it('renders NOTHING when there is no cap - the normal comment is untouched', () => {
    const md = formatPRComment(comparisons, 42, 'acme/repo');
    expect(md).not.toContain('allowance');
    expect(md).not.toContain('[!IMPORTANT]');
  });
});
