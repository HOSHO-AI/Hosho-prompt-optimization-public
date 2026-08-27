/**
 * Content-hash dedupe state, carried inside the bot's own PR comment.
 *
 * WHY: `pull_request: synchronize` re-fires on every push, and GitHub evaluates the workflow's
 * `paths` filter against the PR's WHOLE diff rather than the push — so once a PR touches one prompt
 * file, every later push re-reviews every prompt file the PR ever touched, at full price. Measured
 * on appsmithorg/appsmith-v2 over 8 days: 30 real prompt changes landed on main, 1,688 reviews were
 * billed (17.8x amplification); PR #15717 alone was reviewed 265 times for 53 genuine content
 * states. Replaying the git history of the three heaviest PRs shows a content hash removes ~85%.
 *
 * DESIGN: the delimiters ARE the state. Each file's rendered section in the comment is wrapped in
 * `<!-- hosho-file "path" <sha> -->` … `<!-- /hosho-file -->`, which does two jobs at once:
 *   1. the sha lets the next run skip files whose content is unchanged;
 *   2. the captured markdown lets a PARTIAL run (1 of 9 files changed) re-render only that file and
 *      carry the other eight forward verbatim — nothing disappears from the comment.
 * A separate state blob was rejected: the live comment on PR #15717 is 65,986 chars, already at
 * GitHub's 65,536 limit and being truncated, so there is no room to duplicate results.
 *
 * TRUNCATION. GitHub hard-caps a comment at 65,536 chars and appsmith's busiest PRs sit above it —
 * #17312 (67,825 B) and #17467 (66,365 B) both carry the `Comment truncated` marker with ELEVEN
 * opening `hosho-file` tags and TEN closing. The tail section loses its closer, `parseSections`
 * (correctly) drops it, and that file then re-bills on every future push, forever. Truncating the
 * tail is therefore not a display problem — it is an unbounded cost leak.
 *
 * So the SKIP DECISION reads a compact `<!-- hosho-state v1 {…} -->` block emitted immediately after
 * the bot marker: ~80 B per file, at the TOP, where a tail truncation structurally cannot reach it.
 * The inline per-section delimiters remain, but their only remaining job is carrying rendered
 * markdown forward. The two are read together by `readPriorState`, which falls back to the inline
 * shas so comments written before this shipped still dedupe.
 *
 * FAIL OPEN, ALWAYS. Missing, malformed or truncation-damaged state means "review everything". The
 * only acceptable failure direction is spending money we did not need to — never withholding a
 * review the customer should have had.
 */
import { createHash } from 'crypto';

/** One file's previously-rendered section, recovered from the last comment. */
export interface CarriedSection {
  sha: string;
  markdown: string;
}

const OPEN_RE = /<!--\s*hosho-file\s+"([^"]+)"\s+([a-f0-9]{64})\s*-->/g;
const CLOSE = '<!-- /hosho-file -->';

/**
 * The dedupe key for one file: the exact pair of strings we would send to the API.
 *
 * Hashes the ASSEMBLED content (post skills/siblings bundling), so a changed skill still
 * re-reviews the prompts that pull it in. Hashes BOTH sides, because `before` is the content at the
 * merge base — if main advances and someone else edits the same prompt, the diff genuinely changed.
 * Content rather than commit sha, so it survives rebases and force-pushes that change nothing.
 */
export function fileHash(before: string | null, after: string): string {
  return createHash('sha256')
    .update(before ?? '')
    .update('\0')
    .update(after)
    .digest('hex');
}

/** Wrap a rendered section so the next run can both skip it and carry it forward. */
export function wrapSection(path: string, sha: string, markdown: string): string {
  return `<!-- hosho-file "${path}" ${sha} -->\n${markdown}${CLOSE}\n`;
}

/**
 * Recover per-file sections from a previous comment body.
 *
 * Deliberately tolerant: an unterminated section (the tail was truncated at the 65k limit) is
 * DROPPED rather than half-recovered, so its file is treated as changed and re-reviewed. Any parse
 * surprise yields fewer entries, never a wrong one.
 */
export function parseSections(body: string | undefined | null): Map<string, CarriedSection> {
  const out = new Map<string, CarriedSection>();
  if (!body) return out;
  OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(body)) !== null) {
    const [openTag, path, sha] = m;
    const start = m.index + openTag.length;
    const end = body.indexOf(CLOSE, start);
    if (end === -1) continue; // truncated tail — treat as absent
    out.set(path, { sha, markdown: body.slice(start, end).replace(/^\n/, '') });
  }
  return out;
}

const STATE_RE = /<!--\s*hosho-state v1 (\{.*?\})\s*-->/;

/**
 * The authoritative skip state, rendered directly under the bot marker.
 *
 * One flat `{path: sha}` object, so its size is ~80 B per file (1.7 KB at 21 files) and it stays
 * far inside the budget even when the rendered verdicts do not.
 */
export function renderStateBlock(hashes: Map<string, string>): string {
  if (hashes.size === 0) return '';
  return `<!-- hosho-state v1 ${JSON.stringify(Object.fromEntries(hashes))} -->\n`;
}

/** Read the top state block. Any malformed or non-sha entry is skipped, never guessed at. */
export function parseStateBlock(body: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!body) return out;
  const m = STATE_RE.exec(body);
  if (!m) return out;
  try {
    const parsed = JSON.parse(m[1]) as Record<string, unknown>;
    for (const [path, sha] of Object.entries(parsed)) {
      if (typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha)) out.set(path, sha);
    }
  } catch {
    return new Map(); // unparseable ⇒ no state ⇒ review everything
  }
  return out;
}

/**
 * Everything recoverable from the previous comment, in the two roles the two stores now have:
 *   `shas`     — what may be SKIPPED. Prefers the truncation-proof top block; falls back to the
 *                inline delimiters so a comment written before the top block shipped still dedupes
 *                (without this, every customer pays one full re-review on upgrade).
 *   `sections` — what can be CARRIED FORWARD verbatim. Necessarily incomplete after a truncation;
 *                that is what `renderedPaths` below is for.
 */
export function readPriorState(body: string | undefined | null): {
  shas: Map<string, string>;
  sections: Map<string, CarriedSection>;
} {
  const sections = parseSections(body);
  const shas = parseStateBlock(body);
  for (const [path, sec] of sections) if (!shas.has(path)) shas.set(path, sec.sha);
  return { shas, sections };
}

/** Files whose assembled content is unchanged since the last review, and those that must re-run. */
export interface Partitioned<T> {
  changed: T[];
  unchanged: T[];
  hashes: Map<string, string>;
}

/**
 * Split candidate files by whether their content hash matches the carried state.
 *
 * `force` (the `/hosho-review` slash command, or `dedupe: false`) sends everything to `changed`.
 * A file with no carried section is always `changed` — first run reviews everything.
 */
export function partitionByHash<T extends { path: string; before: string | null; after: string }>(
  files: T[],
  priorShas: Map<string, string>,
  force = false
): Partitioned<T> {
  const changed: T[] = [];
  const unchanged: T[] = [];
  const hashes = new Map<string, string>();
  for (const f of files) {
    const h = fileHash(f.before, f.after);
    hashes.set(f.path, h);
    if (!force && priorShas.get(f.path) === h) unchanged.push(f);
    else changed.push(f);
  }
  return { changed, unchanged, hashes };
}
