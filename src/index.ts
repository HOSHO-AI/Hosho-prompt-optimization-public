import * as core from '@actions/core';
import * as github from '@actions/github';
import { basename } from 'path';
import { readFileSync } from 'fs';
import { parseModelsConfig, resolveModel, type ModelRule } from './models-config';
import { createTwoFilesPatch } from 'diff';
import { identifyChangedPromptFiles } from './file-identifier';
import {
  fetchFileVersions, fetchFileFromDisk, resolveTemplateVariables, bundleSkillsForPrompt, planSkillBundle, bundleSiblingsForPrompt,
  resolveSharedReferences, parseAssemblyConfig, buildSegmentManifest,
  AssemblyConfig, EMPTY_ASSEMBLY_CONFIG, ReferenceViolation, evaluateReferenceConvention,
  resolveMergeBase,
} from './file-fetcher';
import { callReviewAPI, sendBotEvent, PlanCapReachedError, ReviewAPIRequest, ReviewFileResult, DEFAULT_API_URL, assessPipeline } from './api-client';
import {
  formatPRComment,
  formatReviewComment,
  formatJobSummary,
  formatReviewJobSummary,
  formatOnDemandSummary,
  formatCapBanner,
  BOT_MARKER,
} from './output-formatter';
import { ComparisonResult, ChangeItem } from './types';
import { readPriorState, partitionByHash, parseStateBlock } from './review-state';
import { findBotComment, postPlaceholder, removePlaceholder, type PlaceholderHandle } from './pr-comment';

// Stamped on every bot beacon so a fleet still running an old build is VISIBLE rather than
// inferred from behaviour. Bump on release alongside the git tag.
const ACTION_VERSION = 'v1.49.0';

/**
 * The trigger, at the resolution that distinguishes a PR's FIRST review from its Nth.
 *
 * `github.context.eventName` is only ever `pull_request` for the push path, which collapses
 * `opened` and `synchronize` into one bucket — and the whole dedupe thesis is that `synchronize`
 * re-fires on every push while GitHub applies the workflow's `paths` filter to the PR's WHOLE diff.
 * Without the action, "is the dedupe holding on re-pushes?" is unanswerable from the stored data.
 */
function triggerName(): string {
  const action = github.context.payload?.action;
  return typeof action === 'string' && action
    ? `${github.context.eventName}:${action}`
    : github.context.eventName;
}

/**
 * Strip boilerplate from custom principles file: HTML comments and # headings.
 * Returns empty string if only boilerplate remains.
 */
function stripPrinciplesBoilerplate(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')  // Remove HTML comments (including multiline)
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))  // Remove heading lines
    .join('\n')
    .trim();
}

/**
 * The whole comment's budget for diff snippets, shared across every file in the run.
 *
 * MEASURED on the live comment for appsmith-v2 PR #17312 (66,679 B, 11 files, truncated): the
 * ```diff blocks were 23,177 B — 35% of the entire body, and the single largest component. A
 * 15-LINE cap was already in place and did not bind, because prompt diffs are a few very long lines
 * (~140 chars each), not many short ones. So the cap has to be in BYTES.
 *
 * Snippets are the right thing to cut first: they are a courtesy preview of a change the reader can
 * see in full, with better rendering, one click away in the PR's own Files tab. Everything else in
 * the comment (verdict, what-changed, suggested edits) exists nowhere else.
 */
const DIFF_SNIPPET_TOTAL_BUDGET = 10_000;
const DIFF_SNIPPET_MIN = 400;
const DIFF_SNIPPET_MAX = 1_500;

/**
 * Per-file byte budget, so the TOTAL stays bounded however many prompt files a PR touches.
 *
 * Returns 0 — no snippet at all — once the share would fall below DIFF_SNIPPET_MIN. A floor plus a
 * per-file allocation cannot both hold at high file counts (60 files x a 400 B floor is 24 KB, more
 * than twice the whole budget), and of the two, dropping the snippet is the honest resolution:
 * under ~400 bytes a "diff snippet" is a fragment that shows the reader nothing they could act on,
 * while the PR's own Files tab shows the change in full, one click away.
 */
export function diffSnippetBudget(fileCount: number): number {
  const share = Math.floor(DIFF_SNIPPET_TOTAL_BUDGET / Math.max(1, fileCount));
  if (share < DIFF_SNIPPET_MIN) return 0;
  return Math.min(DIFF_SNIPPET_MAX, share);
}

/**
 * Compute a compact diff snippet showing only +/- lines, truncated by BOTH line count and bytes.
 */
function computeDiffSnippet(
  before: string | null,
  after: string,
  maxLines = 15,
  maxChars = DIFF_SNIPPET_MAX,
): string {
  if (!before) return '';
  const patch = createTwoFilesPatch('before', 'after', before, after, '', '', { context: 0 });
  const lines = patch.split('\n');
  const diffLines = lines
    .filter(l => l.startsWith('+') || l.startsWith('-'))
    .filter(l => !l.startsWith('+++') && !l.startsWith('---'));
  if (diffLines.length === 0) return '';

  // Take whole lines until the byte budget is spent — never split a line mid-way, which would show
  // the reader a fragment that reads as the actual content of the change.
  const kept: string[] = [];
  let used = 0;
  for (const line of diffLines.slice(0, maxLines)) {
    if (kept.length > 0 && used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = diffLines.length - kept.length;
  let result = kept.join('\n');
  if (omitted > 0) {
    result += `\n... (${omitted} more changed line${omitted === 1 ? '' : 's'} — see the Files tab)`;
  }
  return result;
}

async function run(): Promise<void> {
  try {
    // Read inputs
    const apiKey = core.getInput('api_key', { required: true });
    const apiUrl = core.getInput('api_url') || DEFAULT_API_URL;
    const promptFile = core.getInput('prompt_file');
    const filePattern = core.getInput('file_pattern');
    const promptPath = core.getInput('prompt_path');
    const systemOverviewPath = core.getInput('system_overview');
    const timeoutMs = parseInt(core.getInput('timeout') || '180', 10) * 1000;
    const customPrinciplesPath = core.getInput('custom_principles');
    const prNumberInput = core.getInput('pr_number');
    const skillsDirsRaw = core.getInput('skills_dir');
    const skillsDirs = skillsDirsRaw
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const bundleSiblings = core.getInput('bundle_siblings').trim().toLowerCase() === 'true';
    const assemblyConfigPath = core.getInput('assembly_config');
    const modelsConfigPath = core.getInput('models_config');

    // Mask the API key in logs
    core.setSecret(apiKey);

    // Read system overview file if provided
    let systemOverview = '';
    if (systemOverviewPath) {
      try {
        systemOverview = readFileSync(systemOverviewPath, 'utf-8');
        core.info(`Loaded system overview from ${systemOverviewPath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`System overview file not found at ${systemOverviewPath}: ${message}. Continuing without it.`);
      }
    }

    // Read custom principles file if provided (strip boilerplate headings + comments)
    let customPrinciples = '';
    if (customPrinciplesPath) {
      try {
        const raw = readFileSync(customPrinciplesPath, 'utf-8');
        customPrinciples = stripPrinciplesBoilerplate(raw);
        if (customPrinciples) {
          core.info(`Loaded custom principles from ${customPrinciplesPath}`);
        } else {
          core.info(`Custom principles file at ${customPrinciplesPath} contains only boilerplate — skipping.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Custom principles file not found at ${customPrinciplesPath}: ${message}. Continuing without it.`);
      }
    }

    // Read assembly config (minimal exception-list for abnormal reference injection + convention checks)
    let assemblyConfig: AssemblyConfig = EMPTY_ASSEMBLY_CONFIG;
    if (assemblyConfigPath) {
      try {
        assemblyConfig = parseAssemblyConfig(readFileSync(assemblyConfigPath, 'utf-8'));
        core.info(`Loaded assembly config from ${assemblyConfigPath} (${assemblyConfig.injectWhenReferenced.length} injectable reference(s), ${assemblyConfig.requireReference.length} required-reference rule(s))`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Assembly config not found at ${assemblyConfigPath}: ${message}. Continuing without it.`);
      }
    }

    // Model config (deterministic per-prompt family/class, replacing Haiku inference in CI).
    let modelRules: ModelRule[] = [];
    if (modelsConfigPath) {
      try {
        const parsed = parseModelsConfig(readFileSync(modelsConfigPath, 'utf-8'));
        modelRules = parsed.rules;
        core.info(`Loaded model config from ${modelsConfigPath} (${modelRules.length} rule(s))`);
        for (const w of parsed.warnings) core.warning(`models config: ${w}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Model config not found at ${modelsConfigPath}: ${message}. Continuing with model inference.`);
      }
    }

    // Determine mode
    const eventName = github.context.eventName;
    const isPRMode = eventName === 'pull_request' || eventName === 'pull_request_target' || !!prNumberInput;

    // Determine outputMode: review (slim) vs improve (full)
    const isImproveCommand = eventName === 'issue_comment' &&
      (github.context.payload.comment?.body || '').includes('/hosho-improve');
    const outputMode: 'review' | 'improve' = isImproveCommand ? 'improve' : 'review';

    core.info(`Mode: ${isPRMode ? 'Pull Request' : 'On-Demand'}, Output: ${isPRMode ? outputMode : 'improve'}`);

    if (isPRMode) {
      if (!filePattern && !promptPath) {
        throw new Error(
          'Either file_pattern or prompt_path must be set for PR mode. ' +
          'Use file_pattern for glob matching (e.g. "**/*system-prompt*.md") ' +
          'or prompt_path for directory prefix matching (e.g. "prompts/").'
        );
      }
      // A slash command is an explicit human ask for a fresh look, so it always bypasses the
      // content-hash skip.
      const dedupe = core.getInput('dedupe') !== 'false' && eventName !== 'issue_comment';
      await runPRMode(apiKey, apiUrl, filePattern, promptPath, systemOverview, customPrinciples, timeoutMs, prNumberInput, outputMode, skillsDirs, bundleSiblings, assemblyConfig, modelRules, dedupe);
    } else {
      await runOnDemandMode(apiKey, apiUrl, promptFile, systemOverview, timeoutMs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A BILLING condition must never fail a customer's build. The README promises exactly this,
    // and the PR path already honours it (the loop stops and the comment explains); on-demand had
    // no such handling, so an exhausted allowance would have turned the check red - the one
    // outcome this whole design set out to avoid.
    if (error instanceof PlanCapReachedError) {
      core.warning(`Monthly allowance reached: ${message}`);
      await core.summary
        .addRaw(`## Hosho\n\n> [!IMPORTANT]\n> **Monthly allowance reached.** ${message}\n`)
        .write();
      return;
    }
    core.setFailed(message);
  }
}

// ---- PR Mode ----

/**
 * Thin wrapper whose only job is cleanup. `reviewPR` posts an in-progress comment before it
 * starts calling the API (see src/pr-comment.ts for why); if the run then dies, that comment
 * must go, or its marker tells a scheduled scan the PR is reviewed and the review never comes.
 * The cleanup lives here rather than in run()'s catch because octokit, owner and repo are
 * locals of the review and never reach that far.
 */
async function runPRMode(
  // every parameter of reviewPR except its leading cleanup handle
  ...args: Parameters<typeof reviewPR> extends [unknown, ...infer Rest] ? Rest : never
): Promise<void> {
  const held: { placeholder: PlaceholderHandle | null } = { placeholder: null };
  try {
    await reviewPR(held, ...args);
  } catch (e) {
    if (held.placeholder) await removePlaceholder(held.placeholder);
    throw e;
  }
}

async function reviewPR(
  held: { placeholder: PlaceholderHandle | null },
  apiKey: string,
  apiUrl: string,
  filePattern: string,
  promptPath: string,
  systemOverview: string,
  customPrinciples: string,
  timeoutMs: number,
  prNumberInput?: string,
  outputMode: 'review' | 'improve' = 'review',
  skillsDirs: string[] = [],
  bundleSiblings: boolean = false,
  assemblyConfig: AssemblyConfig = EMPTY_ASSEMBLY_CONFIG,
  modelRules: ModelRule[] = [],
  dedupe: boolean = true,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR mode');
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  let pullNumber: number;
  let baseSha: string;
  let headSha: string;

  let prTitle = '';
  let prDescription = '';

  if (prNumberInput) {
    // Slash command path — PR data not in payload, fetch via API
    pullNumber = parseInt(prNumberInput, 10);
    if (isNaN(pullNumber)) {
      throw new Error(`Invalid pr_number input: "${prNumberInput}"`);
    }
    const { data: prData } = await octokit.rest.pulls.get({
      owner, repo, pull_number: pullNumber,
    });
    baseSha = prData.base.sha;
    headSha = prData.head.sha;
    prTitle = prData.title || '';
    prDescription = (prData.body || '').slice(0, 500);
    core.info(`Slash command: fetched PR #${pullNumber} — base=${baseSha.substring(0, 7)} head=${headSha.substring(0, 7)}`);
  } else {
    // Normal pull_request event — SHAs in payload
    const pr = github.context.payload.pull_request;
    if (!pr) {
      throw new Error('No pull request found in event payload');
    }
    pullNumber = pr.number;
    baseSha = pr.base.sha;
    headSha = pr.head.sha;
    prTitle = pr.title || '';
    prDescription = ((pr.body as string) || '').slice(0, 500);
    core.info(`PR #${pullNumber}: base=${baseSha.substring(0, 7)} head=${headSha.substring(0, 7)}`);
  }

  // The BEFORE side is read at the merge base, not the base-branch tip.
  //
  // GitHub's own file LIST (pulls.listFiles, below) is already three-dot — it reports what this PR
  // changed relative to where it diverged. Reading before-side CONTENT at `pr.base.sha` made the two
  // disagree: the list said "this PR changed 3 files", the content diff showed everything anyone
  // else had landed on main since. That both re-billed the PR on other people's commits and could
  // render a PR as reverting a change it never touched. Fails open to the base tip.
  const contentBaseSha = resolveMergeBase(baseSha, headSha);
  if (contentBaseSha !== baseSha) {
    core.info(`Merge base: ${contentBaseSha.substring(0, 7)} (base tip is ${baseSha.substring(0, 7)})`);
  }

  // Step 0.5: Gather full PR file summary for context (all files, not just prompts)
  let prFileSummary = '';
  let allPRFilenames: string[] = [];
  try {
    const { data: allFiles } = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: pullNumber, per_page: 100,
    });
    prFileSummary = allFiles.map(f =>
      `${f.filename}: ${f.status} (+${f.additions} -${f.deletions})`
    ).join('\n');
    allPRFilenames = allFiles.map(f => f.filename);
  } catch (error) {
    core.warning(`Could not fetch PR file list: ${error}. Continuing without file context.`);
  }

  // Step 1: Identify changed prompt files
  const changedFiles = await identifyChangedPromptFiles(
    octokit, owner, repo, pullNumber,
    filePattern ? { filePattern } : { promptPath }
  );

  if (changedFiles.length === 0) {
    core.info('No prompt files changed in this PR. Exiting.');
    return;
  }

  core.info(`Found ${changedFiles.length} changed prompt file(s): ${changedFiles.map((f) => f.filename).join(', ')}`);

  // Update workflow run name to show prompt filenames
  const promptNames = changedFiles.map(f => basename(f.filename));
  await updateWorkflowRunName(promptNames, pullNumber);

  // Step 2: Fetch file content and build API request
  const apiFiles: ReviewAPIRequest['files'] = [];
  // Per-file record of what got bundled in (skills + sibling filenames), used
  // for the PR-comment footer so reviewers can see what context was attached.
  const bundledByFile = new Map<string, { skills: string[]; siblings: string[] }>();
  // Deterministic convention-check violations (WS-2), keyed by file path.
  const referenceViolationsByFile = new Map<string, ReferenceViolation[]>();

  const siblingPatterns = ['*prompt*.md', '*addendum*.md'];

  for (const change of changedFiles) {
    const { before, after } = fetchFileVersions(change, contentBaseSha, headSha);

    // Resolve template variables — inject content from changed companion files
    let assembledAfter = resolveTemplateVariables(after, change.filename, headSha, allPRFilenames);
    let assembledBefore = before ? resolveTemplateVariables(before, change.filename, contentBaseSha, allPRFilenames) : null;

    const fileBundled = { skills: [] as string[], siblings: [] as string[] };
    // Maps each bundled section's display name → resolved repo path, threaded
    // into buildSegmentManifest so Segment.source is the real path (G1 parity).
    const sourcePaths: Record<string, string> = {};

    // Skill bundling — both sides need it so diff analysis sees consistent
    // assembled content rather than flagging "all skills newly added"
    if (skillsDirs.length > 0) {
      // One cap decision for both sides (planSkillBundle): a skill the caps drop is dropped on
      // both, so a grown skill can no longer make an unrelated one "vanish" on the after side.
      const plan = planSkillBundle(assembledBefore, contentBaseSha, assembledAfter, headSha, skillsDirs);
      const r = bundleSkillsForPrompt(assembledAfter, headSha, skillsDirs, plan.allow);
      assembledAfter = r.assembled;
      fileBundled.skills = r.bundled;
      Object.assign(sourcePaths, r.paths);
      if (assembledBefore !== null) {
        assembledBefore = bundleSkillsForPrompt(assembledBefore, contentBaseSha, skillsDirs, plan.allow).assembled;
      }
    }

    // Sibling bundling — same dual-sided treatment. Handle renames: the
    // `before` content lives at `previousFilename`, so use its dir for lookup.
    if (bundleSiblings) {
      const r = bundleSiblingsForPrompt(assembledAfter, change.filename, headSha, siblingPatterns);
      assembledAfter = r.assembled;
      fileBundled.siblings = r.bundled;
      Object.assign(sourcePaths, r.paths);
      if (assembledBefore !== null) {
        const beforePath = (change.status === 'renamed' && change.previousFilename) ? change.previousFilename : change.filename;
        assembledBefore = bundleSiblingsForPrompt(assembledBefore, beforePath, contentBaseSha, siblingPatterns).assembled;
      }
    }

    // Shared-reference injection (WS-1) — dual-sided, same treatment as skills/siblings
    // so the diff sees consistent assembled content. Config-driven exception list only.
    const refResult = resolveSharedReferences(assembledAfter, headSha, assemblyConfig);
    assembledAfter = refResult.assembled;
    const injectedRefs = refResult.injected;
    if (assembledBefore !== null) {
      assembledBefore = resolveSharedReferences(assembledBefore, contentBaseSha, assemblyConfig).assembled;
    }

    // Convention check (WS-2) — run on the AUTHORED content (pre-injection). No LLM.
    // Mirrors the standard pipeline's per-mode structure (review = diff-only regression;
    // improve = full-assessment gap + diff regression, deduped). See file-fetcher.ts.
    const violations = evaluateReferenceConvention(before, after, change.filename, assemblyConfig, outputMode);
    if (violations.length > 0) {
      referenceViolationsByFile.set(change.filename, violations);
      core.info(`  Convention check (${outputMode}): ${violations.length} reference finding(s) in ${change.filename}`);
    }

    if (fileBundled.skills.length > 0 || fileBundled.siblings.length > 0) {
      bundledByFile.set(change.filename, fileBundled);
    }

    // Provenance manifest (WS-3) — authoritative: only headers for sections we
    // actually bundled become segments. Only sent when something was bundled.
    const knownSections = new Set<string>([...fileBundled.skills, ...fileBundled.siblings, ...injectedRefs]);
    const segments = buildSegmentManifest(assembledAfter, change.filename, knownSections, sourcePaths);

    const resolvedModel = modelRules.length ? resolveModel(change.filename, modelRules) : null;
    apiFiles.push({
      path: change.filename,
      name: basename(change.filename),
      status: change.status,
      after: assembledAfter,
      before: assembledBefore,
      segments: segments.length > 1 ? segments : undefined,
      // Deterministic per-file model from models.md, if it matched; else undefined ⇒ the Lambda
      // falls back to its own inference exactly as before.
      targetModelFamily: resolvedModel?.family,
      modelClass: resolvedModel?.modelClass,
    });
  }

  // Step 2b: CONTENT-HASH DEDUPE. `synchronize` re-fires on every push and GitHub applies the
  // workflow `paths` filter to the PR's whole diff, so a PR that once touched a prompt re-reviews
  // every prompt file on every later push — measured at 17.8x amplification on appsmith-v2
  // (1,688 billed reviews for 30 real prompt changes in a week). Everything needed to stop that is
  // already in hand here: apiFiles carries the ASSEMBLED before/after read from local git, at no
  // API cost. Skip files whose content pair is unchanged since the last review.
  //
  // FAIL OPEN: no prior comment, unparseable state, or dedupe disabled ⇒ review everything.
  // Unconditional lookup. Whether the comment EXISTS decides the in-progress comment below; only
  // whether its state may be TRUSTED depends on `dedupe`. Gating the lookup itself on `dedupe` -
  // as this did - makes a slash-command run (dedupe off) believe there is no comment and post a
  // second one alongside the real review.
  const existing = await findBotComment(octokit, owner, repo, pullNumber);
  const priorBody = dedupe ? existing?.body : undefined;
  // Two roles, two stores: the top state block decides what may be SKIPPED (truncation-proof), the
  // inline sections supply the markdown to CARRY FORWARD (truncatable, and handled as such below).
  const { shas: priorShas, sections: carriedSections } = readPriorState(priorBody);
  const { changed, unchanged, hashes } = partitionByHash(apiFiles, priorShas, !dedupe);

  if (dedupe && changed.length === 0 && unchanged.length > 0) {
    // Every file is byte-identical to what we already reviewed. Leave the existing comment
    // completely untouched — not even rewritten, so GitHub does not mark it edited and the
    // reviewer sees the same current review. The skip is invisible and the run is a SUCCESS.
    core.info(
      `No prompt content changed since the last review (${unchanged.length} file(s) unchanged). ` +
      `Skipping — existing review comment left as-is.`
    );
    core.summary.addRaw(
      `### Hosho: no re-review needed\n\n${unchanged.length} prompt file(s) unchanged since the ` +
      `last review; no API calls made.\n`
    );
    await core.summary.write();
    // The whole point of the dedupe, and the only place it is observable: no review ran, so nothing
    // else in any store will ever record that this push happened.
    await sendBotEvent(apiUrl, apiKey, {
      repository: `${owner}/${repo}`, prNumber: pullNumber, event: triggerName(),
      filesTotal: apiFiles.length, filesReviewed: 0, filesSkipped: unchanged.length,
      actionVersion: ACTION_VERSION, skippedEntirely: true,
    });
    return;
  }
  if (dedupe && unchanged.length > 0) {
    core.info(
      `Dedupe: ${changed.length} changed, ${unchanged.length} unchanged (carried forward): ` +
      unchanged.map(f => f.name).join(', ')
    );
  }

  // Claim the PR before spending a cent on it. Until the end-of-run write lands, a scheduled
  // re-scan that greps for the bot marker sees nothing and starts a duplicate review of the same
  // PR - 55 of 519 billed reviews over five days on appsmithorg/kite, every one a duplicate.
  // Posted only when no bot comment exists yet; an existing one already carries the marker.
  // Deliberately AFTER the all-unchanged early return above, which must leave the PR untouched.
  if (!existing) held.placeholder = (await postPlaceholder(octokit, owner, repo, pullNumber, changed.length)) ?? null;

  // Step 3: Call Lambda API (one file at a time to avoid connection timeout on large PRs)
  core.info(`Reviewing ${changed.length} file(s)...`);
  const allResults: ReviewFileResult[] = [];
  const errors: string[] = [];
  // Paths whose review did not complete this run. They must NOT be stamped into the dedupe state:
  // a hash in the state block means "we reviewed this content and here is the verdict", and writing
  // one for a file we never reviewed makes every future push SKIP it — silently withholding a review
  // the customer should have had, which is the one thing this whole change set must never do.
  const failedPaths = new Set<string>();
  // Set when the monthly PR-review allowance runs out mid-loop. The remaining files are left
  // UNREVIEWED and unstamped (see failedPaths below), so they come back for review on the next
  // push once the customer has upgraded or the month has rolled over.
  let capMessage: string | null = null;
  // Has this EXECUTION already claimed its one PR-review unit? An explicit latch, not a condition
  // derived from the result arrays: `allResults.length === 0 && failedPaths.size === 0` looked
  // equivalent but was not - a response with status:'success' and an EMPTY results array pushes
  // nothing and records no failure, so the next file re-claimed the unit and the customer was
  // billed twice for one PR. Latched at DISPATCH rather than on success, because a call that
  // errors after reaching the engine may already have been billed there: under-billing by one is
  // recoverable, double-billing a customer is not.
  let billedOnce = false;
  // Files the CAP withheld - a strict subset of failedPaths, which also collects ordinary
  // failures. The banner must name only these: telling a customer their allowance withheld a file
  // that actually timed out is a false accusation about their bill.
  const capSkipped: string[] = [];

  for (const file of changed) {
    if (capMessage) {
      // Allowance gone: stop calling. Every remaining file joins failedPaths so its content hash
      // is not stamped - reviewing 29 of 30 files and silently marking the 30th as done would
      // hide a real gap in the review.
      failedPaths.add(file.path);
      capSkipped.push(file.path);
      continue;
    }
    core.info(`  → ${file.name} (${allResults.length + 1}/${changed.length})...`);
    const meterFirst = !billedOnce;
    if (meterFirst) billedOnce = true;
    try {
      const resp = await callReviewAPI(apiUrl, {
        apiKey,
        mode: 'pr',
        outputMode,
        systemOverview: systemOverview || undefined,
        customPrinciples: customPrinciples || undefined,
        files: [file],
        metadata: { repository: `${owner}/${repo}`, prNumber: pullNumber, prTitle, prDescription, prFileSummary: prFileSummary || undefined },
        // Caller identity on every cost row. Without it the bot's spend lands with caller_kind
        // null and cannot be told apart from an MCP agent's in the by-caller breakdowns — which is
        // how "is this the bot or a customer's script?" became a week-long question in the first place.
        telemetry: { callerKind: 'bot', clientName: 'hosho-action', clientVersion: ACTION_VERSION },
        // One PR review per EXECUTION, not per file: this loop calls the engine once per changed
        // file, so only the first call carries the unit. A 30-file PR is one PR review.
        meterClass: 'action_pr',
        meterFirst,
      }, timeoutMs);

      if (resp.status !== 'success' || !resp.results) {
        errors.push(`${file.name}: ${resp.message || 'Unknown API error'}`);
        failedPaths.add(file.path);
        core.warning(`API error for ${file.name}: ${resp.message || 'Unknown error'}. Skipping.`);
        continue;
      }
      // A 'success' whose diff stage failed is not a review. Treat it exactly like an API error:
      // no section, no hash stamp, re-reviewed on the next push - never a green Approve on an
      // empty summary.
      const pipeline = assessPipeline(resp.results[0]);
      if (pipeline.failed) {
        errors.push(`${file.name}: review engine could not complete the diff analysis`);
        failedPaths.add(file.path);
        core.warning(`Review pipeline failed for ${file.name} (main diff stage). Skipping; it will be reviewed on the next push.`);
        continue;
      }
      for (const w of pipeline.warnings) core.warning(`${file.name}: ${w}`);
      allResults.push(...resp.results);
      const modelInfo = resp.results[0]?.targetModelFamily
        ? ` (model: ${resp.results[0].targetModelFamily}${resp.results[0].targetModelName ? ` / ${resp.results[0].targetModelName}` : ''})`
        : '';
      core.info(`  ✓ ${file.name} done${modelInfo}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // The allowance, not a failure: stop the loop and say so in the PR rather than burying it
      // in the Actions log. Everything else keeps the warn-and-continue behaviour - a rate-limit
      // blip or one bad file must never stop a review that can still finish.
      if (error instanceof PlanCapReachedError) {
        capMessage = msg;
        failedPaths.add(file.path);
        capSkipped.push(file.path);
        core.warning(`Monthly PR-review allowance reached: ${msg}`);
        continue;
      }
      errors.push(`${file.name}: ${msg}`);
      failedPaths.add(file.path);
      core.warning(`Failed to review ${file.name}: ${msg}. Skipping.`);
    }
  }

  // Attach deterministic convention findings (WS-2) to the matching file result.
  // Works even for new files in review mode (the API returns an N/A result we can append to).
  for (const result of allResults) {
    const violations = referenceViolationsByFile.get(result.file);
    if (!violations || violations.length === 0) continue;
    const items: ChangeItem[] = violations.map(v => v.reason === 'removed-reference'
      ? {
          change: `This PR removes the reference to \`${v.file}\``,
          impact: `The previous version of this prompt referenced \`${v.file}\` (a configured convention for \`${v.for}\`); this change drops it.`,
          effect: 'negative' as const,
          severity: v.severity,
          category: 'Security doc reference',
          macroFactor: 'guidance',
          subFactor: 'inputs',
        }
      : {
          change: `Consider referencing \`${v.file}\``,
          impact: `This prompt ${v.reason} and operates in the surface \`${v.file}\` governs, but neither links to nor states those shared rules. Advisory: security is also enforced in code, so this is a maintainability suggestion.`,
          effect: 'negative' as const,
          severity: v.severity,
          category: 'Security doc reference',
          macroFactor: 'guidance',
          subFactor: 'inputs',
        });
    result.changeSummary = [...(result.changeSummary ?? []), ...items];
  }

  if (allResults.length === 0 && capMessage) {
    // The allowance was already spent when the run started, so the cap hit on file #1 and nothing
    // was reviewed. That is a BILLING condition, not a build failure - the same condition that,
    // hit mid-loop, posts a banner and stays green. Falling into the throw below instead turned it
    // red with no comment at all, contradicting what the README promises, and would now also
    // strand the in-progress comment and permanently silence a scheduled re-scan of this PR.
    core.warning(`Monthly allowance reached before any file was reviewed: ${capMessage}`);
    const capOnlyBody =
      `${BOT_MARKER}\n## Hosho PR Review: ${owner}/${repo}#${pullNumber}\n\n` +
      formatCapBanner(capMessage, capSkipped);
    await postOrUpdatePRComment(octokit, owner, repo, pullNumber, capOnlyBody);
    held.placeholder = null;
    await core.summary
      .addRaw(`## Hosho\n\n> [!IMPORTANT]\n> **Monthly allowance reached.** ${capMessage}\n`)
      .write();
    await sendBotEvent(apiUrl, apiKey, {
      repository: `${owner}/${repo}`, prNumber: pullNumber, event: triggerName(),
      filesTotal: apiFiles.length, filesReviewed: 0, filesSkipped: unchanged.length,
      actionVersion: ACTION_VERSION, capBlocked: true,
      commentBytes: capOnlyBody.length, stateEntries: 0,
    });
    return;
  }

  if (allResults.length === 0) {
    throw new Error(`All ${changed.length} file(s) failed: ${errors.join('; ')}`);
  }

  if (errors.length > 0) {
    core.warning(`${errors.length}/${changed.length} file(s) failed: ${errors.join('; ')}`);
  }

  core.info(`Received ${allResults.length}/${changed.length} evaluation(s).`);

  // Step 4: Map API results to ComparisonResult[]
  const comparisons: ComparisonResult[] = allResults.map(r => ({
    ...r.comparison,
    targetModelFamily: r.targetModelFamily,
    targetModelName: r.targetModelName,
    changeSummary: r.changeSummary,
    customPrinciplesResult: r.customPrinciplesResult,
    macroScores: r.macroScores,
  }));

  // Attach diff snippets and scopeSummary to comparisons. The snippet budget is shared across every
  // file the COMMENT will render (carried ones included), not just the ones reviewed this run —
  // otherwise a partial re-review of a wide PR would hand its one fresh file the whole budget.
  const snippetBudget = diffSnippetBudget(apiFiles.length);
  for (const comp of comparisons) {
    const file = apiFiles.find(f => f.path === comp.promptFile);
    if (file && file.before && snippetBudget > 0) {
      comp.diffSnippet = computeDiffSnippet(file.before, file.after, 15, snippetBudget);
    }
    const result = allResults.find(r => r.file === comp.promptFile);
    if (result?.scopeSummary) {
      comp.scopeSummary = result.scopeSummary;
    }
  }

  // Normalize after JSON round-trip (undefined fields get stripped by JSON.stringify)
  for (const comp of comparisons) {
    for (const insight of comp.synthesis.factorInsights) {
      if (!insight.findings) insight.findings = [];
    }
    for (const factor of comp.factorResults) {
      if (!factor.findings) factor.findings = [];
      if (!factor.assessments) factor.assessments = [];
    }
  }

  // Step 5: Post PR comment
  const repoFullName = `${owner}/${repo}`;
  core.info(`Posting PR ${outputMode === 'review' ? 'review' : 'improve'} comment...`);
  // Carry: the FULL ordered file list (so the scope header stays truthful) plus the previously
  // rendered markdown for files skipped this run, so a partial re-review never drops sections.
  // FAIL OPEN on anything that did not complete: a path with no hash is re-reviewed next push.
  // Without this, a file whose API call errored is rendered as "unchanged since the last review"
  // AND stamped at its current content hash, so it is never reviewed again until someone edits it.
  const stateHashes = new Map(hashes);
  for (const path of failedPaths) stateHashes.delete(path);
  const carry = {
    order: apiFiles.map(f => f.path),
    carried: carriedSections,
    hashes: stateHashes,
  };
  const capForComment = capMessage ? { message: capMessage, unreviewed: capSkipped } : undefined;
  const commentBody = outputMode === 'review'
    ? formatReviewComment(comparisons, pullNumber, repoFullName, bundledByFile, carry, capForComment)
    : formatPRComment(comparisons, pullNumber, repoFullName, bundledByFile, carry, capForComment);
  await postOrUpdatePRComment(octokit, owner, repo, pullNumber, commentBody);
  // The placeholder IS this comment now (postOrUpdatePRComment finds it by marker and updates it
  // in place), so there is nothing left to clean up if a later step throws.
  held.placeholder = null;

  // Step 6: Write Job Summary
  core.info('Writing Job Summary...');
  const summaryBody = outputMode === 'review'
    ? formatReviewJobSummary(comparisons, pullNumber, repoFullName, bundledByFile)
    : formatJobSummary(comparisons, pullNumber, repoFullName, bundledByFile);
  await core.summary.addRaw(summaryBody).write();

  // Step 8: Set outputs
  const overallScores = comparisons.map((c) => c.synthesis.overallScore);
  core.setOutput('overall_score', overallScores.join(', '));
  core.setOutput('review_summary', comparisons.map((c) => c.synthesis.promptDescription).join(' | '));

  // Counts for the run that just happened. `filesReviewed` also shows up in cx.llm_costs (it cost
  // money); `filesSkipped` appears nowhere but here, and it is the number that says whether the
  // content-hash dedupe is earning its keep.
  await sendBotEvent(apiUrl, apiKey, {
    repository: repoFullName, prNumber: pullNumber, event: triggerName(),
    // filesReviewed counts what was ACTUALLY reviewed, not what we set out to review: on a capped
    // run the files after the cap were never sent, and counting them would overstate both the
    // spend ledger and the operator's per-key usage view (which sums this very column).
    filesTotal: apiFiles.length,
    filesReviewed: changed.length - capSkipped.length,
    filesSkipped: unchanged.length,
    actionVersion: ACTION_VERSION,
    // Why a run reviewed fewer files than it found - otherwise a capped run is indistinguishable
    // from a quiet one in every dashboard downstream.
    ...(capMessage ? { capBlocked: true } : {}),
    // Comment health. `stateEntries < filesTotal` means the comment truncated and a file lost its
    // dedupe state — which then re-bills on every push, permanently. Measured on four live PRs.
    commentBytes: commentBody.length,
    stateEntries: parseStateBlock(commentBody).size,
  });

  core.info('Done.');
}

// ---- On-Demand Mode ----

async function runOnDemandMode(
  apiKey: string,
  apiUrl: string,
  promptFile: string,
  systemOverview: string,
  timeoutMs: number
): Promise<void> {
  if (!promptFile) {
    throw new Error('prompt_file input is required for on-demand mode (workflow_dispatch)');
  }

  core.info(`On-demand evaluation of: ${promptFile}`);

  // Read file from disk
  const content = fetchFileFromDisk(promptFile);
  const promptName = basename(promptFile);

  // Update workflow run name to show prompt filename
  await updateWorkflowRunName([promptName]);

  // Call Lambda API
  core.info('Calling review API...');
  const apiResponse = await callReviewAPI(apiUrl, {
    apiKey,
    mode: 'on-demand',
    // A manual (workflow_dispatch) run reviews one prompt on demand - it is a REVIEW RUN, not a
    // PR review, and draws the review pool. That is what the engine's unstamped fallback already
    // concluded from outputMode; stamping it makes the intent explicit rather than incidental,
    // and stops a future fallback change from silently re-pointing it at the PR pool.
    meterClass: 'run',
    systemOverview: systemOverview || undefined,
    files: [{
      path: promptFile,
      name: promptName,
      status: 'added',
      after: content,
      before: null,
    }],
  }, timeoutMs);

  if (apiResponse.status !== 'success' || !apiResponse.results || apiResponse.results.length === 0) {
    throw new Error(`API returned error: ${apiResponse.message || 'Unknown error'}`);
  }

  const result = apiResponse.results[0];

  // Write Job Summary
  core.info('Writing Job Summary...');
  const summaryBody = formatOnDemandSummary(result.synthesis, result.factorResults, result.targetModelFamily, result.targetModelName, result.macroScores);
  await core.summary.addRaw(summaryBody).write();

  // Set outputs
  core.setOutput('overall_score', result.synthesis.overallScore);
  core.setOutput('review_summary', result.synthesis.promptDescription);

  const modelInfo = result.targetModelFamily
    ? ` | Model: ${result.targetModelFamily}${result.targetModelName ? ` / ${result.targetModelName}` : ''}`
    : '';
  core.info(`Done. Overall: ${result.synthesis.overallScore}${modelInfo}`);
}

// ---- Run Name ----

async function updateWorkflowRunName(
  promptNames: string[],
  prNumber?: number
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const runId = github.context.runId;

    let label: string;
    if (promptNames.length <= 2) {
      label = promptNames.join(', ');
    } else {
      label = `${promptNames[0]} +${promptNames.length - 1} more`;
    }

    const name = prNumber
      ? `Hosho Bot — ${label} — PR #${prNumber}`
      : `Hosho Bot — ${label}`;

    await octokit.request('PATCH /repos/{owner}/{repo}/actions/runs/{run_id}', {
      owner, repo, run_id: runId, name,
    });
  } catch {
    // Requires actions:write permission — silent if not granted
    core.debug('Could not update workflow run name (actions:write permission may not be granted)');
  }
}

// ---- Shared Helpers ----

async function postOrUpdatePRComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: pullNumber, per_page: 100,
  });

  const existingComment = comments.find(
    (comment) => comment.body?.includes(BOT_MARKER)
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existingComment.id, body });
    core.info(`Updated existing PR comment (id: ${existingComment.id})`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    core.info('Created new PR comment');
  }
}

// Run
run();
