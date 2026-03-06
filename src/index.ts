import * as core from '@actions/core';
import * as github from '@actions/github';
import { basename } from 'path';
import { readFileSync } from 'fs';
import { identifyChangedPromptFiles } from './file-identifier';
import { fetchFileVersions, fetchFileFromDisk } from './file-fetcher';
import { callReviewAPI, ReviewAPIRequest, ReviewFileResult, DEFAULT_API_URL } from './api-client';
import {
  formatPRComment,
  formatReviewComment,
  formatJobSummary,
  formatReviewJobSummary,
  formatOnDemandSummary,
  BOT_MARKER,
} from './output-formatter';
import { ComparisonResult } from './types';

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
    const prNumberInput = core.getInput('pr_number');

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
      await runPRMode(apiKey, apiUrl, filePattern, promptPath, systemOverview, timeoutMs, prNumberInput, outputMode);
    } else {
      await runOnDemandMode(apiKey, apiUrl, promptFile, systemOverview, timeoutMs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

// ---- PR Mode ----

async function runPRMode(
  apiKey: string,
  apiUrl: string,
  filePattern: string,
  promptPath: string,
  systemOverview: string,
  timeoutMs: number,
  prNumberInput?: string,
  outputMode: 'review' | 'improve' = 'review',
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
    core.info(`PR #${pullNumber}: base=${baseSha.substring(0, 7)} head=${headSha.substring(0, 7)}`);
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

  for (const change of changedFiles) {
    const { before, after } = fetchFileVersions(change, baseSha, headSha);
    apiFiles.push({
      path: change.filename,
      name: basename(change.filename),
      status: change.status,
      after,
      before,
    });
  }

  // Step 3: Call Lambda API (one file at a time to avoid connection timeout on large PRs)
  core.info(`Reviewing ${apiFiles.length} file(s)...`);
  const allResults: ReviewFileResult[] = [];
  const errors: string[] = [];

  for (const file of apiFiles) {
    core.info(`  → ${file.name} (${allResults.length + 1}/${apiFiles.length})...`);
    try {
      const resp = await callReviewAPI(apiUrl, {
        apiKey,
        mode: 'pr',
        outputMode,
        systemOverview: systemOverview || undefined,
        files: [file],
        metadata: { repository: `${owner}/${repo}`, prNumber: pullNumber },
      }, timeoutMs);

      if (resp.status !== 'success' || !resp.results) {
        errors.push(`${file.name}: ${resp.message || 'Unknown API error'}`);
        core.warning(`API error for ${file.name}: ${resp.message || 'Unknown error'}. Skipping.`);
        continue;
      }
      allResults.push(...resp.results);
      const modelInfo = resp.results[0]?.targetModelFamily
        ? ` (model: ${resp.results[0].targetModelFamily}${resp.results[0].targetModelName ? ` / ${resp.results[0].targetModelName}` : ''})`
        : '';
      core.info(`  ✓ ${file.name} done${modelInfo}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${file.name}: ${msg}`);
      core.warning(`Failed to review ${file.name}: ${msg}. Skipping.`);
    }
  }

  if (allResults.length === 0) {
    throw new Error(`All ${apiFiles.length} file(s) failed: ${errors.join('; ')}`);
  }

  if (errors.length > 0) {
    core.warning(`${errors.length}/${apiFiles.length} file(s) failed: ${errors.join('; ')}`);
  }

  core.info(`Received ${allResults.length}/${apiFiles.length} evaluation(s).`);

  // Step 4: Map API results to ComparisonResult[]
  const comparisons: ComparisonResult[] = allResults.map(r => ({
    ...r.comparison,
    targetModelFamily: r.targetModelFamily,
    targetModelName: r.targetModelName,
    changeSummary: r.changeSummary,
  }));

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
  core.info(`Posting PR ${outputMode === 'review' ? 'review' : 'improve'} comment...`);
  const commentBody = outputMode === 'review'
    ? formatReviewComment(comparisons, pullNumber)
    : formatPRComment(comparisons, pullNumber);
  await postOrUpdatePRComment(octokit, owner, repo, pullNumber, commentBody);

  // Step 6: Write Job Summary
  core.info('Writing Job Summary...');
  const summaryBody = outputMode === 'review'
    ? formatReviewJobSummary(comparisons, pullNumber)
    : formatJobSummary(comparisons, pullNumber);
  await core.summary.addRaw(summaryBody).write();

  // Step 8: Set outputs
  const overallScores = comparisons.map((c) => c.synthesis.overallScore);
  core.setOutput('overall_score', overallScores.join(', '));
  core.setOutput('review_summary', comparisons.map((c) => c.synthesis.promptDescription).join(' | '));

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
  const summaryBody = formatOnDemandSummary(result.synthesis, result.factorResults, result.targetModelFamily, result.targetModelName);
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
