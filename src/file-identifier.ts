import * as github from '@actions/github';
import { PromptFileChange } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Identifies which files changed in a PR that match the prompt path prefix.
 * Excludes deleted files (nothing to review). Handles renames.
 */
export async function identifyChangedPromptFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  promptPath: string
): Promise<PromptFileChange[]> {
  // Normalize: ensure trailing slash
  const normalizedPath = promptPath.endsWith('/') ? promptPath : `${promptPath}/`;

  // Paginate to handle PRs with >100 changed files
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const promptFiles: PromptFileChange[] = [];

  for (const file of files) {
    // Check if this file is in the prompt directory
    const matchesCurrent = file.filename.startsWith(normalizedPath);
    const matchesPrevious = file.previous_filename?.startsWith(normalizedPath) ?? false;

    if (!matchesCurrent && !matchesPrevious) {
      continue;
    }

    // Map GitHub status to our simplified status
    const status = normalizeStatus(file.status);
    if (!status) {
      continue; // Skip deleted or unrecognized statuses
    }

    promptFiles.push({
      filename: file.filename,
      previousFilename: file.previous_filename ?? undefined,
      status,
    });
  }

  return promptFiles;
}

function normalizeStatus(
  githubStatus: string
): 'added' | 'modified' | 'renamed' | null {
  switch (githubStatus) {
    case 'added':
    case 'copied':
      return 'added';
    case 'modified':
    case 'changed':
      return 'modified';
    case 'renamed':
      return 'renamed';
    case 'removed':
      return null; // Deleted files are skipped
    default:
      return null;
  }
}
