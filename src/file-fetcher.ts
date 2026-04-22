import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
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
export function gitShowFile(ref: string, filePath: string): string | null {
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

const TEMPLATE_VAR_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const JINJA_COMMENT_REGEX = /\{#[\s\S]*?#\}/g;

/**
 * Resolves Jinja2-style {{ variable_name }} template placeholders by looking for
 * matching .md files in the same directory. Only injects content from files that
 * were changed in the current PR — unchanged files are left as placeholders.
 *
 * Graceful failure: on any error, returns the original content unchanged.
 */
export function resolveTemplateVariables(
  content: string,
  filePath: string,
  commitSha: string,
  changedFiles: string[],
): string {
  try {
    // Strip Jinja2 comments to avoid matching variable names inside comments
    const cleanContent = content.replace(JINJA_COMMENT_REGEX, '');

    // Find all {{ variable_name }} placeholders
    const variables = new Set<string>();
    let match;
    const regex = new RegExp(TEMPLATE_VAR_REGEX.source, 'g');
    while ((match = regex.exec(cleanContent)) !== null) {
      variables.add(match[1]);
    }

    if (variables.size === 0) return content;

    const dir = path.dirname(filePath);
    let resolved = content;
    let resolvedCount = 0;

    for (const varName of variables) {
      // Try to find a matching .md file in the same directory
      const candidates = [
        `${dir}/${varName}.md`,                        // exact: sitemap_section_rules.md
        `${dir}/${varName.replace(/_/g, '-')}.md`,     // underscore→hyphen: branding-rules.md
      ];

      let matchedPath: string | null = null;
      for (const candidate of candidates) {
        // Quick check: does the file exist at this commit?
        if (gitShowFile(commitSha, candidate) !== null) {
          matchedPath = candidate;
          break;
        }
      }

      if (matchedPath === null) continue; // No file found — runtime variable, leave as-is

      // Only inject if the file was changed in this PR
      if (!changedFiles.includes(matchedPath)) continue;

      // Read the file content and inject
      const injectedContent = gitShowFile(commitSha, matchedPath);
      if (injectedContent === null) continue; // Read failed — leave placeholder

      const placeholder = new RegExp(`\\{\\{\\s*${varName}\\s*\\}\\}`, 'g');
      resolved = resolved.replace(placeholder, injectedContent);
      resolvedCount++;
      core.info(`  Resolved template {{ ${varName} }} from ${matchedPath}`);
    }

    // Strip Jinja2 comments from the resolved content
    resolved = resolved.replace(JINJA_COMMENT_REGEX, '');

    if (resolvedCount > 0) {
      core.info(`  Template resolution: ${resolvedCount} variable(s) injected, ${variables.size - resolvedCount} left as placeholders`);
    }

    return resolved;
  } catch (error) {
    core.warning(`Template resolution failed for ${filePath}: ${error}. Continuing with raw content.`);
    return content;
  }
}
