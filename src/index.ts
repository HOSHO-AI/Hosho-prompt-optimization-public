import * as core from '@actions/core';
import * as github from '@actions/github';
import { basename } from 'path';
import { readFileSync } from 'fs';
import { identifyChangedPromptFiles } from './file-identifier';
import { fetchFileVersions, fetchFileFromDisk } from './file-fetcher';
import { callReviewAPI, ReviewAPIRequest } from './api-client';
import {
  formatPRComment,
  formatJobSummary,
  formatOnDemandSummary,
  BOT_MARKER,
} from './output-formatter';
import { ComparisonResult } from './types';

async function run(): Promise<void> {
  try {
    // Read inputs
    const apiKey = core.getInput('api_key', { required: true });
    const apiUrl = core.getInput('api_url', { required: true });
    const promptFile = core.getInput('prompt_file');
    const promptPath = core.getInput('prompt_path') || 'prompts/';
    const systemOverviewPath = core.getInput('system_overview');

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
    const isPRMode = eventName === 'pull_request' || eventName === 'pull_request_target';

    core.info(`Mode: ${isPRMode ? 'Pull Request' : 'On-Demand'}`);

    if (isPRMode) {
      await runPRMode(apiKey, apiUrl, promptPath, systemOverview);
    } else {
      await runOnDemandMode(apiKey, apiUrl, promptFile, systemOverview);
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
  promptPath: string,
  systemOverview: string
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR mode');
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const pr = github.context.payload.pull_request;

  if (!pr) {
    throw new Error('No pull request found in event payload');
  }

  const pullNumber = pr.number;
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;

  core.info(`PR #${pullNumber}: base=${baseSha.substring(0, 7)} head=${headSha.substring(0, 7)}`);

  // Step 1: Identify changed prompt files
  const changedFiles = await identifyChangedPromptFiles(
    octokit, owner, repo, pullNumber, promptPath
  );

  if (changedFiles.length === 0) {
    core.info('No prompt files changed in this PR. Exiting.');
    return;
  }

  core.info(`Found ${changedFiles.length} changed prompt file(s): ${changedFiles.map((f) => f.filename).join(', ')}`);

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

  // Step 3: Call Lambda API
  core.info(`Calling review API with ${apiFiles.length} file(s)...`);
  const apiResponse = await callReviewAPI(apiUrl, {
    apiKey,
    mode: 'pr',
    systemOverview: systemOverview || undefined,
    files: apiFiles,
    metadata: {
      repository: `${owner}/${repo}`,
      prNumber: pullNumber,
    },
  });

  if (apiResponse.status !== 'success' || !apiResponse.results) {
    throw new Error(`API returned error: ${apiResponse.message || 'Unknown error'}`);
  }

  core.info(`API returned ${apiResponse.results.length} evaluation(s).`);

  // Step 4: Map API results to ComparisonResult[]
  const comparisons: ComparisonResult[] = apiResponse.results.map(r => r.comparison);

  // Step 5: Post PR comment
  core.info('Posting PR review comment...');
  const commentBody = formatPRComment(comparisons);
  await postOrUpdatePRComment(octokit, owner, repo, pullNumber, commentBody);

  // Step 6: Post review verdict
  const anyCritical = comparisons.some((c) => c.hasCriticalIssue);
  await postReviewVerdict(octokit, owner, repo, pullNumber, headSha, anyCritical);

  // Step 7: Write Job Summary
  core.info('Writing Job Summary...');
  const summaryBody = formatJobSummary(comparisons, 'claude-opus-4-6');
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
  systemOverview: string
): Promise<void> {
  if (!promptFile) {
    throw new Error('prompt_file input is required for on-demand mode (workflow_dispatch)');
  }

  core.info(`On-demand evaluation of: ${promptFile}`);

  // Read file from disk
  const content = fetchFileFromDisk(promptFile);
  const promptName = basename(promptFile);

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
  });

  if (apiResponse.status !== 'success' || !apiResponse.results || apiResponse.results.length === 0) {
    throw new Error(`API returned error: ${apiResponse.message || 'Unknown error'}`);
  }

  const result = apiResponse.results[0];

  // Write Job Summary
  core.info('Writing Job Summary...');
  const summaryBody = formatOnDemandSummary(result.synthesis, result.factorResults, 'claude-opus-4-6');
  await core.summary.addRaw(summaryBody).write();

  // Set outputs
  core.setOutput('overall_score', result.synthesis.overallScore);
  core.setOutput('review_summary', result.synthesis.promptDescription);

  core.info(`Done. Overall: ${result.synthesis.overallScore}`);
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

async function postReviewVerdict(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  hasCriticalIssues: boolean
): Promise<void> {
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

    const event = hasCriticalIssues ? 'REQUEST_CHANGES' : 'COMMENT';
    const body = hasCriticalIssues
      ? 'Prompt Factor Review found critical issues. See the review comment above for details.'
      : 'Prompt Factor Review complete. See the review comment above for details.';

    await octokit.rest.pulls.createReview({
      owner, repo, pull_number: pullNumber,
      commit_id: pr.head.sha,
      event: event as 'REQUEST_CHANGES' | 'COMMENT',
      body,
    });

    core.info(`Posted review verdict: ${event}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to post review verdict: ${message}`);
  }
}

// Run
run();
