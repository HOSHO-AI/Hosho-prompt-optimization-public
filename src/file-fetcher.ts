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

// Backticked tokens that look like skill names: kebab-case lowercase, ≥2 chars,
// no slashes/dots/spaces inside backticks.
const BACKTICK_TOKEN_REGEX = /`([a-z][a-z0-9_-]{1,})`/g;

// Bundling caps — hard limits to prevent runaway context.
const MAX_SKILLS_PER_PROMPT = 20;
const MAX_SKILLS_BYTES = 100 * 1024;
const MAX_SIBLINGS_PER_PROMPT = 10;
const MAX_SIBLINGS_BYTES = 50 * 1024;

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

/**
 * List file entries (non-recursive) in a directory at a specific git ref.
 * Returns null on error (e.g. directory doesn't exist at that ref).
 */
export function gitListDir(ref: string, dirPath: string): string[] | null {
  try {
    const refPath = dirPath ? `"${ref}:${dirPath}"` : `"${ref}:"`;
    const output = execSync(`git ls-tree --name-only ${refPath}`, {
      encoding: 'utf-8',
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Translate a simple glob (`*` only) into an anchored regex.
 * Examples: '*prompt*.md' → /^.*prompt.*\.md$/
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Scan content for backticked tokens (e.g. `copy-rules`) and, for each token
 * that resolves to `<skillsDir>/<name>/SKILL.md` or `<skillsDir>/<name>.md`
 * (kebab/snake variants tried), inline the resolved skill content as an
 * appended `## Skill: <name>` section.
 *
 * Reads skills via `gitShowFile(commitSha, ...)` so the content reflects the
 * skill state at the PR commit, regardless of whether the skill itself was
 * touched in this PR.
 *
 * Graceful failure: on any error, returns original content unchanged.
 */
export function bundleSkillsForPrompt(
  content: string,
  commitSha: string,
  skillsDirs: string[],
): { assembled: string; bundled: string[] } {
  try {
    if (!skillsDirs || skillsDirs.length === 0) {
      return { assembled: content, bundled: [] };
    }

    // Collect candidate skill names from backticked tokens (deduped).
    const candidates = new Set<string>();
    let match;
    const regex = new RegExp(BACKTICK_TOKEN_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
      candidates.add(match[1]);
    }

    if (candidates.size === 0) {
      return { assembled: content, bundled: [] };
    }

    const resolved: Array<{ name: string; body: string }> = [];
    let totalBytes = 0;
    const droppedForCap: string[] = [];

    for (const name of candidates) {
      if (resolved.length >= MAX_SKILLS_PER_PROMPT) {
        droppedForCap.push(name);
        continue;
      }
      // Try exact, then kebab-normalized (underscore → hyphen)
      const kebab = name.replace(/_/g, '-');
      const candidatePaths: string[] = [];
      for (const dir of skillsDirs) {
        candidatePaths.push(`${dir}/${name}/SKILL.md`);
        if (kebab !== name) candidatePaths.push(`${dir}/${kebab}/SKILL.md`);
        candidatePaths.push(`${dir}/${name}.md`);
        if (kebab !== name) candidatePaths.push(`${dir}/${kebab}.md`);
      }

      let body: string | null = null;
      for (const candidate of candidatePaths) {
        body = gitShowFile(commitSha, candidate);
        if (body !== null) break;
      }
      if (body === null) continue;

      const bodyBytes = Buffer.byteLength(body, 'utf-8');
      if (totalBytes + bodyBytes > MAX_SKILLS_BYTES) {
        droppedForCap.push(name);
        continue;
      }
      totalBytes += bodyBytes;
      resolved.push({ name, body });
    }

    if (resolved.length === 0) {
      return { assembled: content, bundled: [] };
    }

    let assembled = content;
    for (const { name, body } of resolved) {
      assembled += `\n\n---\n\n## Skill: ${name}\n\n${body}\n`;
    }

    if (droppedForCap.length > 0) {
      core.warning(`  Skill bundling: dropped ${droppedForCap.length} skill(s) due to caps (${MAX_SKILLS_PER_PROMPT} skills / ${MAX_SKILLS_BYTES} bytes): ${droppedForCap.join(', ')}`);
    }
    core.info(`  Bundled ${resolved.length} skill(s): ${resolved.map(r => r.name).join(', ')}`);

    return { assembled, bundled: resolved.map(r => r.name) };
  } catch (error) {
    core.warning(`Skill bundling failed: ${error}. Continuing with raw content.`);
    return { assembled: content, bundled: [] };
  }
}

/**
 * Find sibling files in the same directory as `filePath` (non-recursive) that
 * match any of the `patterns` globs (e.g. ['*prompt*.md', '*addendum*.md']),
 * read each via `gitShowFile`, and append as `## Companion file: <name>`
 * sections. Excludes the file itself.
 *
 * Graceful failure: on any error, returns original content unchanged.
 */
export function bundleSiblingsForPrompt(
  content: string,
  filePath: string,
  commitSha: string,
  patterns: string[],
): { assembled: string; bundled: string[] } {
  try {
    if (!patterns || patterns.length === 0) {
      return { assembled: content, bundled: [] };
    }
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const entries = gitListDir(commitSha, dir);
    if (!entries) {
      return { assembled: content, bundled: [] };
    }

    const compiled = patterns.map(globToRegex);
    const matching = entries.filter(e => {
      if (e === base) return false;
      return compiled.some(r => r.test(e));
    });

    if (matching.length === 0) {
      return { assembled: content, bundled: [] };
    }

    const resolved: Array<{ name: string; body: string }> = [];
    let totalBytes = 0;
    const droppedForCap: string[] = [];

    for (const name of matching) {
      if (resolved.length >= MAX_SIBLINGS_PER_PROMPT) {
        droppedForCap.push(name);
        continue;
      }
      const body = gitShowFile(commitSha, `${dir}/${name}`);
      if (body === null) continue;
      const bodyBytes = Buffer.byteLength(body, 'utf-8');
      if (totalBytes + bodyBytes > MAX_SIBLINGS_BYTES) {
        droppedForCap.push(name);
        continue;
      }
      totalBytes += bodyBytes;
      resolved.push({ name, body });
    }

    if (resolved.length === 0) {
      return { assembled: content, bundled: [] };
    }

    let assembled = content;
    for (const { name, body } of resolved) {
      assembled += `\n\n---\n\n## Companion file: ${name}\n\n${body}\n`;
    }

    if (droppedForCap.length > 0) {
      core.warning(`  Sibling bundling: dropped ${droppedForCap.length} file(s) due to caps (${MAX_SIBLINGS_PER_PROMPT} files / ${MAX_SIBLINGS_BYTES} bytes): ${droppedForCap.join(', ')}`);
    }
    core.info(`  Bundled ${resolved.length} sibling(s): ${resolved.map(r => r.name).join(', ')}`);

    return { assembled, bundled: resolved.map(r => r.name) };
  } catch (error) {
    core.warning(`Sibling bundling failed for ${filePath}: ${error}. Continuing with raw content.`);
    return { assembled: content, bundled: [] };
  }
}
