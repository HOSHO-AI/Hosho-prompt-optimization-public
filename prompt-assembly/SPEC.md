# Prompt-assembly contract (one approach)

This file is the **single source of truth** for how a prompt is bundled with its
skills / siblings / shared references before review, how the provenance
**manifest** (`Segment[]`) is built, and how a finding is resolved back to its
source file. It is committed **identically** to both implementations:

- **Python** — `Kite_Customer_Experience_Triage/src/prompt_assembly.py` (bundling +
  manifest + resolution).
- **TypeScript** — `Hosho-prompt-optimization-public/src/file-fetcher.ts` (bundling
  + manifest). Resolution lives in the private engine, mirroring §4 here.

`prompt-assembly/golden_vectors.json` (also committed identically to both repos)
encodes this spec as executable fixtures. Each repo's parity test asserts its
native implementation reproduces the fixtures byte-for-byte. **If you change
behaviour, change this spec, regenerate the vectors, and update BOTH repos in
lockstep** — the parity tests are what stop the two from silently drifting.

## 1. Skill bundling

- Harvest backticked tokens matching `` `([a-z][a-z0-9_-]{1,})` `` in first-seen
  order, **deduped preserving order** (JS `Set` / Python `dict.fromkeys` — never a
  hash-ordered `set`; ordering is part of the contract).
- Resolve each, per `skills_dir`, in this exact order: `<dir>/<name>/SKILL.md`,
  `<dir>/<kebab>/SKILL.md`, `<dir>/<name>.md`, `<dir>/<kebab>.md` (kebab =
  underscores→hyphens; the kebab variants are only tried when `kebab != name`).
  First existing file wins.
- Caps: ≤20 skills, ≤100 KiB total (UTF-8 bytes). Over a cap → drop, keep order.
- Each resolved skill is **appended** as: `\n\n---\n\n## Skill: <name>\n\n<body>\n`
  (the header carries the bare display `<name>`).
- Return `(assembled, bundled_names, name→resolved_path)`.

## 2. Sibling + reference bundling

- **Siblings**: non-recursive directory listing; match basename globs
  (`*prompt*.md`, `*addendum*.md`); exclude the file itself; when the reviewed
  file is a `system-prompt*`, exclude other `system-prompt*` siblings (different
  agent). Caps: ≤10 files / ≤50 KiB. Appended as `## Companion file: <name>`.
- **References** (`inject_when_referenced`): injected only when the prompt
  references the path (§5). Caps: ≤10 / ≤100 KiB. Appended as `## Reference: <path>`.
  The reference header is **already a path**.

## 3. Manifest (`Segment[]`)

- Always starts with `{source: <main file path>, kind: "main", blob_start_line: 1,
  source_start_line: 1}`.
- For each appended section, the header line must be immediately preceded by a
  blank line then `---` (the bundler's separator); a body line that merely looks
  like a header is ignored. `known_sections` (the names actually bundled) further
  guards this.
- A section's `blob_start_line` is the 1-based blob line where its **body** begins
  (`header_line_index + 3`, 0-based: header, blank, body).
- **`Segment.source` is the resolved repo PATH**, not the display name (G1). The
  caller threads the bundler's name→path map in; skills/siblings map name→path,
  references are already paths, the main file is its own path. The blob header
  still shows the display name. *(Both repos do this — it is not a divergence.)*

## 4. Resolution (Python + private engine)

Given the raw blob, the manifest, the main source, an echoed `[start,end]`, and the
verbatim snippet:

- **Anchor** the snippet: exact match on the first non-blank trimmed line; else, for
  lines ≥8 chars, a substring match; with multiple hits pick the one nearest the
  echoed start. Anchoring beats the echoed line.
- If neither anchoring nor a usable echoed line is available → **file-level**
  (`source_start_line = 0`); prefer file-level over a confidently-wrong line.
- Pick the segment with the greatest `blob_start_line ≤ blob_start`; translate
  `source_line = blob_line - seg.blob_start_line + seg.source_start_line`.
- `source_in_change_set` is true **iff** the segment is the main file. Bundled
  segments are informational.

## 5. Path matching & globs

- `prompt_references_path(content, path)` — true if any path-suffix of `path`
  (aligned to `/` boundaries, down to the bare basename) appears in `content`.
- **`require_reference.for` globs use minimatch semantics** (path-aware), NOT
  fnmatch: `*` matches within a single segment (not `/`); `**` (and `**/`) crosses
  segments. e.g. `backend/app/llm/**/*prompt*.md` matches
  `backend/app/llm/system-prompt.md` AND
  `backend/app/llm/orchestrator_agent/system-prompt.md`, but
  `backend/app/llm/*.md` matches neither nested file.
- Sibling **basename** globs use simple `*`→`.*` (no `/` involved).

## 6. Template variables (`{{ var }}`)

**Resolution rule (shared):** a `{{ name }}` is an *include* only when a
same-directory companion `<dir>/<name>.md` (or `<dir>/<name-kebab>.md`) exists.
Otherwise it is a **runtime-data placeholder** (e.g. `{{ msg.content }}`,
`{{ requirements_spec }}`, `{{ tc.name }}`) and is left untouched. In appsmith-v2
essentially every `{{ }}` is a runtime placeholder — there are no companion `.md`
includes — so include-inlining does not fire for the prompts cx-triage reviews.

**cx-triage (Python):** does **not** inline `{{ }}`. The reviewed blob keeps the
raw placeholders, which is the provenance-correct baseline — every main-file line
maps 1:1 to the source file. (Inlining a multi-line companion mid-file with no
provenance segment would shift every subsequent line; see M1 below.) This is a
deliberate, justified difference from the action's diff-focus heuristic and is
asserted nowhere in the cross-impl vectors.

**Public action (TS):** `resolveTemplateVariables` inlines PR-*changed* companion
includes (diff-focus) and strips Jinja `{# … #}` comments. **Known limitation
(M1):** inlined content is not represented in the `Segment` manifest, so when an
include actually resolves, main-file lines after it shift and the engine can
mis-cite. The correct fix is to emit each inlined companion as a `reference`
segment (split the main segment with `source_start_line` offsets — the resolution
math in §4 already supports this). That changes the manifest the **private engine**
consumes, so it is gated on confirming the engine tolerates mid-file segments
before shipping — tracked as a follow-up, not applied blind.

## 7. Config

The assembly config (`inject_when_referenced` + `require_reference`) is authored
once, in **appsmith-v2** at `.github/hosho/assembly.yml`. The public action reads it
via its `assembly_config:` input; cx-triage fetches the same file from appsmith-v2
(not a local copy). `customer_context/assembly_config.yaml` is a local override only.
