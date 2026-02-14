# Prompt Factor Reviewer

A GitHub Action that evaluates AI agent prompts against 6 prompt engineering quality factors. It scores each factor, identifies gaps with specific code references, and suggests concrete improvements. In PR mode, it also analyzes what changed between versions and whether the changes improved or regressed quality.

## What You Get

**PR mode** posts a review comment on your pull request containing:
- Per-factor score table with traffic-light indicators
- Impact column showing whether each factor improved, regressed, or stayed the same
- Collapsible findings with code snippets from your prompt and proposed fixes
- Review verdict (APPROVE or REQUEST_CHANGES if regressions detected)

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

Contact Hosho to receive your API key and endpoint URL.

### 2. Store them as secrets in your repo

In your GitHub repo, go to **Settings > Secrets and variables > Actions > New repository secret** and add two secrets:

| Secret name | Value |
|-------------|-------|
| `HOSHO_API_KEY` | The API key you received |
| `HOSHO_API_URL` | The endpoint URL you received |

### 3. Create a workflow file

Create the file `.github/workflows/prompt-review.yml` in your repo and paste the following:

```yaml
name: Prompt Review

on:
  pull_request:
    paths:
      - 'prompts/**'   # Adjust to match where your prompt files live

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # Required — the action needs git history to compare versions

      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          api_url: ${{ secrets.HOSHO_API_URL }}
          prompt_path: prompts/
          # system_overview: docs/system-overview.md   # Optional — see step 4
```

That's it. Every PR that changes files in `prompts/` will now get an automated review comment.

For on-demand mode (manual trigger to evaluate any prompt file), see [`examples/on-demand.yml`](examples/on-demand.yml).

### 4. (Optional) Add a system overview

If your prompts are part of a multi-agent pipeline, create a markdown file describing how your agents connect and pass it via the `system_overview` input. This helps the reviewer understand what inputs each prompt receives and what downstream agents consume its output.

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

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | Hosho API key |
| `api_url` | Yes | — | API endpoint URL |
| `prompt_file` | No | `''` | Path to a specific prompt file (on-demand mode) |
| `prompt_path` | No | `prompts/` | Directory prefix for identifying prompt files in PRs |
| `system_overview` | No | `''` | Path to a system overview markdown file |

## Outputs

| Output | Description |
|--------|-------------|
| `overall_score` | Overall score label (Excellent / Good / Needs Work / Critical) |
| `review_summary` | Brief summary of the review findings |

---

## Modes

### PR Mode

Triggered automatically on `pull_request` events. The action identifies prompt files changed in the PR, evaluates the current version of each file, analyzes what changed from the base version, and posts a review comment with scores, findings, and a verdict.

If you push additional commits to the same PR, the existing comment is updated (not duplicated).

### On-Demand Mode

Triggered via `workflow_dispatch` (manual run) or any non-PR event. Requires the `prompt_file` input. Writes results to the Job Summary in the Actions tab.

See [`examples/on-demand.yml`](examples/on-demand.yml) for a complete workflow.

---

## Security & Privacy

- Evaluations run on Hosho's infrastructure (AWS Lambda). Your prompts are **not** evaluated locally in the GitHub Action runner — the action sends file content to the API and receives results back.
- **Prompt content is not stored.** It is processed in-memory during evaluation and discarded after the response is returned. No prompt text, code snippets, or evaluation results are written to any database.
- **Only usage metadata is stored:** request timestamps, file counts, and repository name — for billing and rate limiting. No content data.
- **No prompt content is logged.** Server logs contain only transaction metadata (e.g., "Evaluating: prompts/agent.md", "Overall: Needs Work"), not file contents or assessment details.
- All API communication is encrypted via HTTPS.
- Every request is authenticated with your API key.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `401 Unauthorized` from API | Check that `HOSHO_API_KEY` and `HOSHO_API_URL` secrets are set correctly in your repo |
| "GITHUB_TOKEN environment variable is required" | Add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the action step |
| "fatal: bad revision" or "path not found" in logs | Add `fetch-depth: 0` to your `actions/checkout` step |
| "Resource not accessible by integration" (403) | Add `permissions: pull-requests: write` and `issues: write` to the workflow |
| No PR comment appears but action succeeds | Check that `GITHUB_TOKEN` has write permissions and the workflow has the permissions block |
| Action times out | Evaluations take 60-90 seconds per file. If reviewing many files, consider splitting into smaller PRs |

---

## Requirements

- **API key and URL** from Hosho
- **`GITHUB_TOKEN`** — automatically provided by GitHub Actions, but your workflow must declare `pull-requests: write` and `issues: write` permissions for PR mode
- **`fetch-depth: 0`** on the checkout step — required for PR mode so the action can access the base version of changed files
