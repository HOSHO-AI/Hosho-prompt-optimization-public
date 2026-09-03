/**
 * The bot's PR comment, as a THING THAT EXISTS rather than a thing written at the end.
 *
 * WHY: the review comment is written once, after every file has been reviewed
 * (`postOrUpdatePRComment` at the tail of the PR-mode run). A scheduled re-scan that asks
 * "does this PR already carry a review?" - the shape appsmith runs, an every-15-minutes cron
 * whose gate is `select(.body | test("prompt-factor-reviewer"))` - therefore sees NOTHING for the
 * whole 20-30 minutes a first review of a wide PR takes, and launches a second full review of the
 * same PR. Measured over 5 days on appsmithorg/kite: 55 of 519 billed file-reviews came from
 * that race, every one a duplicate, and it doubled the two most expensive PRs in the window.
 * The cron caught nothing genuine in that period - every scheduled review it billed was a
 * race with a review already in flight.
 *
 * FIX: post a comment carrying the marker BEFORE the review loop starts, so the question
 * "is this PR being reviewed?" has a true answer from the first second. The existing
 * end-of-run write finds the bot comment by marker and updates it in place, so the
 * placeholder becomes the review with no change to that path.
 *
 * SAFETY: the placeholder deliberately carries NO `hosho-state` block. `parseStateBlock` on a
 * body without one returns an empty Map, which `partitionByHash` reads as "nothing has been
 * reviewed" - so a placeholder can only ever cause MORE review, never a silent skip. That is
 * the same fail-open direction the dedupe state itself takes.
 *
 * Extracted into its own module because `src/index.ts` calls `run()` at import time, so
 * nothing declared there can be unit-tested without executing the whole action.
 */
import * as core from '@actions/core';
import { BOT_MARKER } from './output-formatter';

/**
 * The slice of octokit these helpers touch. Narrow on purpose: a test hands in three
 * `vi.fn()`s rather than mocking the GitHub client.
 */
export interface CommentApi {
  paginate: (route: unknown, params: Record<string, unknown>) => Promise<Array<{ id: number; body?: string | null }>>;
  rest: {
    issues: {
      listComments: unknown;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: { id: number } }>;
      deleteComment: (params: { owner: string; repo: string; comment_id: number }) => Promise<unknown>;
    };
  };
}

/**
 * A placeholder we posted and are therefore responsible for cleaning up. Carries its own client
 * so the cleanup path needs nothing but the handle - the failure site is a wrapper that has no
 * octokit of its own.
 */
export interface PlaceholderHandle {
  api: CommentApi;
  owner: string;
  repo: string;
  id: number;
}

/**
 * The bot's comment on this PR, id included.
 *
 * Supersedes a body-only lookup: the ID is what lets a failed run delete a placeholder it
 * posted, and the mere EXISTENCE of the comment is what decides whether to post one at all -
 * a question that must be asked even when dedupe is off, or a slash-command run believes no
 * comment exists and posts a second one beside the real review.
 *
 * Never throws: a lookup failure must fail OPEN (review everything, post nothing) rather than
 * skip a review we owe the customer.
 */
export async function findBotComment(
  api: CommentApi,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ id: number; body: string } | undefined> {
  try {
    const comments = await api.paginate(api.rest.issues.listComments, {
      owner, repo, issue_number: pullNumber, per_page: 100,
    });
    const found = comments.find((c) => c.body?.includes(BOT_MARKER));
    return found ? { id: found.id, body: found.body ?? '' } : undefined;
  } catch (e) {
    core.warning(`Could not read prior review comment (${e instanceof Error ? e.message : e}); reviewing all files.`);
    return undefined;
  }
}

/**
 * What the PR shows while the review runs.
 *
 * Two hard requirements, both pinned by tests:
 *   1. it contains BOT_MARKER, because that substring IS the predicate a scheduled scan greps
 *      for - the whole point of posting early;
 *   2. it contains no `hosho-state` block, so it can never be read as "these files are already
 *      reviewed".
 */
export function placeholderBody(fileCount: number): string {
  const files = fileCount === 1 ? '1 prompt file' : `${fileCount} prompt files`;
  return (
    `${BOT_MARKER}\n` +
    `## Hosho PR Review\n\n` +
    `Reviewing ${files}. This comment is replaced with the full review when it finishes.\n`
  );
}

/**
 * Post the placeholder. Returns the handle to delete on failure, or `undefined` if posting it
 * did not work - which is not fatal: the run continues and the end-of-run write creates the
 * comment as it always did. The only thing lost is the race protection for this one run.
 */
export async function postPlaceholder(
  api: CommentApi,
  owner: string,
  repo: string,
  pullNumber: number,
  fileCount: number,
): Promise<PlaceholderHandle | undefined> {
  try {
    const { data } = await api.rest.issues.createComment({
      owner, repo, issue_number: pullNumber, body: placeholderBody(fileCount),
    });
    core.info(`Posted in-progress review comment (id: ${data.id}) before reviewing ${fileCount} file(s).`);
    return { api, owner, repo, id: data.id };
  } catch (e) {
    core.warning(`Could not post the in-progress review comment (${e instanceof Error ? e.message : e}); continuing.`);
    return undefined;
  }
}

/**
 * Remove a placeholder whose run died before it could be filled in.
 *
 * Leaving one behind is worse than never posting it: the marker would tell a scheduled scan
 * this PR is reviewed, and the review would never arrive. Never throws - a failed cleanup is
 * reported and swallowed so it cannot mask the original error.
 */
export async function removePlaceholder(handle: PlaceholderHandle): Promise<void> {
  try {
    await handle.api.rest.issues.deleteComment({
      owner: handle.owner, repo: handle.repo, comment_id: handle.id,
    });
    core.info(`Removed the in-progress review comment (id: ${handle.id}) - the review did not complete.`);
  } catch (e) {
    core.warning(`Could not remove the in-progress review comment (id: ${handle.id}): ${e instanceof Error ? e.message : e}`);
  }
}
