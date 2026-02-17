# Prompt Reviewer

A GitHub Action that evaluates AI agent prompts against 6 prompt engineering quality factors. It scores each factor, identifies gaps with specific code references, and suggests concrete improvements. In PR mode, it also analyzes what changed between versions and whether the changes improved or regressed quality.

## What You Get

**PR mode** posts a review comment on your pull request containing:
- Per-factor score table with traffic-light indicators
- Impact column showing whether each factor improved, regressed, or stayed the same
- Collapsible findings with code snippets from your prompt and proposed fixes
- Review verdict (APPROVE, or REQUEST_CHANGES if any factor scores Critical or any factor regressed)

**On-demand mode** writes a Job Summary (visible in the Actions tab) with the full evaluation.

### Scoring Scale

| Score | Label | Meaning |
|-------|-------|---------|
| 8-10 | Good | Meets quality criteria |
| 5-7 | Needs Work | Gaps identified with recommendations |
| 1-4 | Critical | Significant issues that need attention |

### Quality Factors

| Factor | What It Measures |
|--------|-----------------|
| Scope | Single clear goal, tightly coupled tasks |
| Structure & Flow | Logical sections, information density, delimiters |
| Context & Guidance | Goals, inputs, examples, chain-of-thought |
| Constraints | Compatibility, priority, positive framing |
| Output Validation | Format spec, validation steps, substance checks |
| Model-Specific Prompting | Claude, GPT, and Gemini best practices |

---

## Setup

### 1. Get your API key

Contact Hosho to receive your API key.

### 2. Store it as a secret in your repo

In your GitHub repo, go to **Settings > Secrets and variables > Actions > New repository secret** and add:

| Secret name | Value |
|-------------|-------|
| `HOSHO_API_KEY` | The API key you received |

### 3. Create a workflow file

Create the file `.github/workflows/prompt-review.yml` in your repo (create the `.github/workflows/` directory if it doesn't exist yet) and paste the following:

```yaml
name: Prompt Review
run-name: "Prompt Review — PR #${{ github.event.pull_request.number }}"

on:
  pull_request:
    paths:
      - 'prompts/**'   # Adjust to match where your prompt files live

permissions:
  contents: read
  pull-requests: write
  issues: write       # Required — GitHub's PR comment API uses the issues endpoint
  actions: write      # Optional — enables showing prompt names in the run list

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # Required — the action needs git history to compare versions

      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # Provided automatically by GitHub — do not create this secret
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          prompt_path: prompts/   # Same directory you listed under paths: above
          # system_overview: docs/system-overview.md   # Optional — see step 4
```

That's it. Every PR that changes files in `prompts/` will now get an automated review comment. The `run-name` field customizes the initial name in the Actions tab run list. With the `actions: write` permission, the action updates the run name to show the actual prompt filenames (e.g., "Prompt Review — agent.md, planner.md — PR #23").

A copy of this workflow is also available at [`examples/pr-review.yml`](examples/pr-review.yml).

> **Note:** Make sure `prompt_path` points to the same directory as the `paths:` trigger at the top of the workflow, so the action reviews the same files that triggered it. The action reviews every file under this directory — there's no file extension filter, so any text file (`.md`, `.txt`, `.yaml`, etc.) will be evaluated.

### 4. (Optional) Add a system overview

If your prompts are part of a multi-agent pipeline, create a markdown file describing how your agents connect and pass it via the `system_overview` input. This helps the reviewer understand what inputs each prompt receives and what downstream agents consume its output.

For each agent in your system, include:
- **Prompt file** — which file contains its prompt
- **Model** — which LLM it targets (e.g., Claude Sonnet, GPT-4o, Gemini Pro)
- **Role** — what it does in one sentence
- **Inputs** — what data it receives and from where
- **Outputs** — what it produces and which agents consume it

For complex pipelines, you can also document execution phases, parallel groups, and key constraints.

Three of the six factors benefit from this context:
- **Scope** — understands what's intentionally delegated to other agents
- **Context & Guidance** — knows what inputs come from upstream
- **Model-Specific Prompting** — knows which model each prompt targets

Example format:

```markdown
# System Overview

## Agent: Requirements Gatherer
- Prompt: prompts/requirements-gatherer.md
- Model: Claude Sonnet
- Role: Gathers user requirements via conversation
- Inputs: User messages (direct user input)
- Outputs: Structured requirements spec, fed to Planner

## Agent: Planner
- Prompt: prompts/planner.md
- Model: Claude Opus
- Role: Creates project plan from requirements
- Inputs: Requirements spec from Requirements Gatherer
- Outputs: Project plan, fed to Builder

## Data Flow
User → Requirements Gatherer → Planner → Builder → Reviewer → User
```

### 5. (Optional) Set up on-demand mode

To evaluate a prompt without opening a PR, add a second workflow — see [`examples/on-demand.yml`](examples/on-demand.yml) for the complete file.

To run it: go to the **Actions** tab in your GitHub repo → select **Prompt Review (On-Demand)** → click **Run workflow** → enter the path to your prompt file → click the green **Run workflow** button. Results appear in the Job Summary for that run.

### Verify it works

**PR mode:** Create a branch, add or edit a file in your `prompts/` directory, and open a pull request. A review comment will appear within 1-2 minutes.

**On-demand mode:** Go to the **Actions** tab → select the on-demand workflow → click **Run workflow** → enter a prompt file path. Results appear in the Job Summary at the bottom of the workflow run page (click the run, then scroll down past the logs).

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | Hosho API key |
| `prompt_file` | No | `''` | Path to a specific prompt file (on-demand mode) |
| `prompt_path` | No | `prompts/` | Directory prefix for identifying prompt files in PRs |
| `system_overview` | No | `''` | Path to a system overview markdown file |
| `api_url` | No | Built-in | API endpoint URL — override for enterprise/self-hosted deployments |
| `timeout` | No | `180` | API call timeout in seconds |

## Outputs

| Output | Description |
|--------|-------------|
| `overall_score` | Overall score label (Excellent / Good / Needs Work / Critical) |
| `review_summary` | Brief summary of the review findings |

---

## Modes

### PR Mode

Triggered automatically on `pull_request` events. The action identifies prompt files changed in the PR, evaluates the current version of each file, analyzes what changed from the base version, and posts a review comment with scores, findings, and a verdict.

If multiple prompt files are changed in the same PR, each file is evaluated independently and all results appear in a single review comment. If you push additional commits to the same PR, the existing comment is updated (not duplicated).

For newly added files, the action scores the prompt but skips the impact analysis (since there's no previous version to compare against). The Impact column appears only for modified or renamed files. Deleted files are skipped.

### On-Demand Mode

Triggered via `workflow_dispatch` (manual run) or any non-PR event. Requires the `prompt_file` input. Writes results to the Job Summary in the Actions tab.

See [`examples/on-demand.yml`](examples/on-demand.yml) for a complete workflow.

---

## Security & Privacy

### What data is sent

When the action runs, it sends the following to the Hosho API:
- **File content** — the full text of each prompt file being evaluated (and the base version for PR diffs)
- **File paths** — e.g., `prompts/agent.md`
- **PR metadata** — repository name and PR number (for usage tracking only)

### Where it's processed

- Evaluations run on **Hosho's infrastructure** (AWS Lambda, us-east-1). Your prompts are **not** evaluated locally in the GitHub Action runner.
- Prompt content is sent to **Anthropic's Claude API** for evaluation. Anthropic does not train on API inputs. See [Anthropic's usage policy](https://www.anthropic.com/policies) for details.

### Data retention

- **Prompt content is not stored.** It is processed in-memory during evaluation and discarded after the response is returned. No prompt text, code snippets, or evaluation results are written to any database or log.
- **Only usage metadata is stored:** request timestamps, file counts, and repository name — for billing and rate limiting. No content data.

### Security

- All API communication is encrypted via **HTTPS**.
- Every request is authenticated with your **API key**.
- No prompt content is logged — server logs contain only transaction metadata (e.g., "Evaluating: prompts/agent.md"), not file contents or assessment details.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `401 Unauthorized` from API | Check that `HOSHO_API_KEY` is set correctly in your repo secrets |
| "GITHUB_TOKEN environment variable is required" | Add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the action step |
| "fatal: bad revision" or "path not found" in logs | Add `fetch-depth: 0` to your `actions/checkout` step |
| "Resource not accessible by integration" (403) | Add `permissions: pull-requests: write` and `issues: write` to the workflow |
| No PR comment appears but action succeeds | Check that `GITHUB_TOKEN` has write permissions and the workflow has the permissions block |
| Action times out | Default timeout is 180s (3 minutes). Evaluations take 60-90 seconds per file. For many files, increase with `timeout: 300` |
