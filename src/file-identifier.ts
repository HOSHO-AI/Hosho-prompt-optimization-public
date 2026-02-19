import * as github from '@actions/github';
import { minimatch } from 'minimatch';
import { PromptFileChange } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

interface FileFilterOptions {
  /** Glob pattern to match filenames against (e.g. "**\/*system-prompt*.md") */
  filePattern?: string;
  /** Directory prefix to match filenames against (e.g. "prompts/") */
  promptPath?: string;
}

/**
 * Identifies which files changed in a PR that match the given filter.
 * Supports two modes: glob pattern matching or directory prefix matching.
 * Excludes deleted files (nothing to review). Handles renames.
 */
export async function identifyChangedPromptFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: FileFilterOptions
): Promise<PromptFileChange[]> {
  const matchFile = buildMatcher(options);

  // Paginate to handle PRs with >100 changed files
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const promptFiles: PromptFileChange[] = [];

  for (const file of files) {
    const matchesCurrent = matchFile(file.filename);
    const matchesPrevious = file.previous_filename ? matchFile(file.previous_filename) : false;

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

function buildMatcher(options: FileFilterOptions): (filename: string) => boolean {
  if (options.filePattern) {
    return (filename: string) => minimatch(filename, options.filePattern!);
  }
  const normalizedPath = options.promptPath!.endsWith('/')
    ? options.promptPath!
    : `${options.promptPath!}/`;
  return (filename: string) => filename.startsWith(normalizedPath);
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
