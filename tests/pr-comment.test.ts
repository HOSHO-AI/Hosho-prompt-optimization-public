import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  findBotComment,
  placeholderBody,
  postPlaceholder,
  removePlaceholder,
  type CommentApi,
} from '../src/pr-comment';
import { parseStateBlock } from '../src/review-state';
import { BOT_MARKER } from '../src/output-formatter';

vi.mock('@actions/core', () => ({
  info: vi.fn(), warning: vi.fn(), error: vi.fn(), setFailed: vi.fn(), debug: vi.fn(),
  getInput: vi.fn(() => ''), summary: { addRaw: vi.fn(() => ({ write: vi.fn() })) },
}));

/** The exact jq predicate appsmith's scheduled scan greps comment bodies with. */
const SCAN_GATE = /prompt-factor-reviewer/;

function fakeApi(comments: Array<{ id: number; body?: string | null }> = []) {
  const createComment = vi.fn(async () => ({ data: { id: 999 } }));
  const deleteComment = vi.fn(async () => ({}));
  const paginate = vi.fn(async () => comments);
  const api: CommentApi = {
    paginate,
    rest: { issues: { listComments: 'listComments', createComment, deleteComment } },
  };
  return { api, createComment, deleteComment, paginate };
}

describe('the in-progress comment is what a scheduled scan sees', () => {
  it('matches the scan predicate verbatim - this is the whole point of posting early', () => {
    expect(placeholderBody(3)).toMatch(SCAN_GATE);
    expect(placeholderBody(3)).toContain(BOT_MARKER);
  });

  it('carries NO dedupe state, so it can never suppress a review', () => {
    // parseStateBlock is what decides which files may be skipped. An empty result means
    // "nothing has been reviewed" - the only safe reading for a review still in flight.
    expect(parseStateBlock(placeholderBody(5)).size).toBe(0);
  });

  it('says how many files, singular and plural', () => {
    expect(placeholderBody(1)).toContain('1 prompt file.');
    expect(placeholderBody(4)).toContain('4 prompt files.');
  });
});

describe('findBotComment', () => {
  it('returns the id as well as the body - the id is what lets a failed run clean up', async () => {
    const { api } = fakeApi([
      { id: 1, body: 'a human comment' },
      { id: 7, body: `${BOT_MARKER}\nthe review` },
    ]);
    expect(await findBotComment(api, 'o', 'r', 5)).toEqual({ id: 7, body: `${BOT_MARKER}\nthe review` });
  });

  it('returns undefined when no bot comment exists', async () => {
    const { api } = fakeApi([{ id: 1, body: 'unrelated' }]);
    expect(await findBotComment(api, 'o', 'r', 5)).toBeUndefined();
  });

  it('paginates every page of comments', async () => {
    const { api, paginate } = fakeApi([]);
    await findBotComment(api, 'o', 'r', 5);
    expect(paginate).toHaveBeenCalledWith('listComments', expect.objectContaining({ per_page: 100 }));
  });

  it('fails OPEN when the lookup throws - never skip a review we owe', async () => {
    const api = {
      paginate: vi.fn(async () => { throw new Error('502'); }),
      rest: { issues: { listComments: 'l', createComment: vi.fn(), deleteComment: vi.fn() } },
    } as unknown as CommentApi;
    expect(await findBotComment(api, 'o', 'r', 5)).toBeUndefined();
  });
});

describe('postPlaceholder / removePlaceholder', () => {
  it('posts the placeholder and hands back a self-contained cleanup handle', async () => {
    const { api, createComment } = fakeApi();
    const handle = await postPlaceholder(api, 'o', 'r', 5, 3);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 5, body: expect.stringMatching(SCAN_GATE) }),
    );
    expect(handle).toMatchObject({ owner: 'o', repo: 'r', id: 999 });
    expect(handle?.api).toBe(api);
  });

  it('a failed post is not fatal - the run continues and the end-of-run write still creates it', async () => {
    const api = {
      paginate: vi.fn(async () => []),
      rest: { issues: {
        listComments: 'l',
        createComment: vi.fn(async () => { throw new Error('403'); }),
        deleteComment: vi.fn(),
      } },
    } as unknown as CommentApi;
    expect(await postPlaceholder(api, 'o', 'r', 5, 3)).toBeUndefined();
  });

  it('removes the placeholder by id', async () => {
    const { api, deleteComment } = fakeApi();
    await removePlaceholder({ api, owner: 'o', repo: 'r', id: 42 });
    expect(deleteComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 42 });
  });

  it('a failed removal is swallowed so it cannot mask the original error', async () => {
    const api = {
      paginate: vi.fn(async () => []),
      rest: { issues: {
        listComments: 'l',
        createComment: vi.fn(),
        deleteComment: vi.fn(async () => { throw new Error('404'); }),
      } },
    } as unknown as CommentApi;
    await expect(removePlaceholder({ api, owner: 'o', repo: 'r', id: 42 })).resolves.toBeUndefined();
  });
});

// run() self-invokes at import, so the ORDER of statements inside reviewPR cannot be executed in a
// test. Pin it against the source instead - the repo's established pattern (tests/plan-metering).
describe('the in-progress comment is posted before any file is reviewed', () => {
  const src = readFileSync(join(__dirname, '..', 'src/index.ts'), 'utf8');

  it('posts the placeholder before the review loop starts', () => {
    const post = src.indexOf('held.placeholder = (await postPlaceholder(');
    const loop = src.indexOf('for (const file of changed) {');
    expect(post).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(post).toBeLessThan(loop);
  });

  it('posts it AFTER the all-unchanged early return, which must leave the PR untouched', () => {
    const skipReturn = src.indexOf('skippedEntirely: true');
    const post = src.indexOf('held.placeholder = (await postPlaceholder(');
    expect(skipReturn).toBeLessThan(post);
  });

  it('only posts when no bot comment exists yet', () => {
    expect(src).toMatch(/if \(!existing\) held\.placeholder = \(await postPlaceholder\(/);
  });

  it('looks the comment up unconditionally, so a slash command cannot post a duplicate', () => {
    // The old code gated the LOOKUP on `dedupe`; with dedupe off (slash command) it then believed
    // no comment existed. Only the trust in its STATE may depend on dedupe.
    expect(src).toMatch(/const existing = await findBotComment\(octokit, owner, repo, pullNumber\);/);
    expect(src).toMatch(/const priorBody = dedupe \? existing\?\.body : undefined;/);
  });

  it('clears the handle once the real comment has landed', () => {
    const postComment = src.indexOf('await postOrUpdatePRComment(octokit, owner, repo, pullNumber, commentBody);');
    const clear = src.indexOf('held.placeholder = null;', postComment);
    expect(postComment).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(postComment);
  });

  it('removes the placeholder when the review throws', () => {
    expect(src).toMatch(/if \(held\.placeholder\) await removePlaceholder\(held\.placeholder\);\s*\n\s*throw e;/);
  });
});

describe('an allowance already spent stays green', () => {
  const src = readFileSync(join(__dirname, '..', 'src/index.ts'), 'utf8');

  it('does not throw when the cap hit before any file was reviewed', () => {
    // Previously this fell into `All N file(s) failed` -> setFailed -> red check with no comment,
    // contradicting the README, and would now strand the in-progress comment as well.
    const capBranch = src.indexOf('if (allResults.length === 0 && capMessage) {');
    const throwBranch = src.indexOf('throw new Error(`All ${changed.length} file(s) failed');
    expect(capBranch).toBeGreaterThan(-1);
    expect(capBranch).toBeLessThan(throwBranch);
  });

  it('posts a cap banner comment and reports the run as capped', () => {
    expect(src).toContain('formatCapBanner(capMessage, capSkipped)');
    expect(src).toMatch(/capBlocked: true,\s*\n\s*commentBytes: capOnlyBody\.length/);
  });
});
