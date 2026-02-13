import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import * as core from '@actions/core';
import { PromptFileChange } from './types';

/**
 * Fetches the "after" (PR head) and "before" (base branch) content
 * of a prompt file. Uses git CLI to avoid GitHub API size limits.
 *
 * Requires actions/checkout with fetch-depth: 0.
 */
export function fetchFileVersions(
  change: PromptFileChange,
  baseSha: string,
  headSha: string
): { before: string | null; after: string } {
  // Fetch AFTER version (current PR head)
  const after = gitShowFile(headSha, change.filename);
  if (after === null) {
    throw new Error(
      `Could not read file "${change.filename}" at HEAD (${headSha}). ` +
        'Ensure actions/checkout with fetch-depth: 0 is configured.'
    );
  }

  // Fetch BEFORE version (base branch)
  let before: string | null = null;

  if (change.status === 'added') {
    // New file — no before version
    before = null;
  } else {
    // For renames, the "before" path is the previous filename
    const beforePath =
      change.status === 'renamed' && change.previousFilename
        ? change.previousFilename
        : change.filename;

    before = gitShowFile(baseSha, beforePath);

    if (before === null) {
      core.warning(
        `Could not read base version of "${beforePath}" at ${baseSha}. ` +
          'Treating as new file.'
      );
    }
  }

  return { before, after };
}

/**
 * Reads a file from a specific git commit using `git show`.
 * Returns null if the file doesn't exist at that commit.
 */
function gitShowFile(ref: string, filePath: string): string | null {
  try {
    const output = execSync(`git show "${ref}:${filePath}"`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB — more than enough for prompt files
      stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr
    });
    return output;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Expected: file doesn't exist at this ref (new file, deleted file)
    if (message.includes('does not exist') || message.includes('exists on disk, but not in')) {
      return null;
    }
    // Unexpected error — log warning but still return null to avoid breaking the flow
    core.warning(`Unexpected error reading "${filePath}" at ${ref}: ${message}`);
    return null;
  }
}

/**
 * Reads a file from the local filesystem (for on-demand mode).
 * The repo is already checked out by actions/checkout.
 */
export function fetchFileFromDisk(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: "${filePath}"`);
  }

  return readFileSync(filePath, 'utf-8');
}
