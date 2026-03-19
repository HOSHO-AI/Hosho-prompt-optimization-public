# Hosho Prompt Reviewer

Evaluates your AI agent prompts against research-backed prompt engineering best practices — pinpoints what's weak and gives you concrete fixes with before/after snippets you can apply immediately.

## How It Works

Your prompts are evaluated across 6 quality factors drawn from prompt engineering research and model-provider guidelines (Claude, GPT, Gemini). Each factor is rated green, yellow, or red so you can see at a glance where to focus:

| Factor | What It Checks |
|--------|---------------|
| Scope | Single clear goal, tightly coupled tasks |
| Structure & Flow | Logical sections, information density, delimiters |
| Context & Guidance | Goals, inputs, examples, chain-of-thought |
| Constraints | Boundaries, priority handling, positive framing |
| Output Validation | Format spec, validation steps, substance checks |
| Model-Specific Prompting | Alignment with Claude, GPT, and Gemini best practices |

For every factor that isn't green, you get specific findings — what's missing, a snippet from your prompt, and a proposed fix you can drop in.

**PR mode** automatically posts a review summary on your pull request — verdict, what changed, and suggested fixes. For detailed scoring and improvement suggestions, comment `/hosho-improve` on the PR. **On-demand mode** writes full results to the Job Summary in the Actions tab.

---

## Setup

### 1. Get your API key

Request an API key at [otto@hoshoai.com](mailto:otto@hoshoai.com).

### 2. Store it as a secret in your repo

In your GitHub repo, go to **Settings > Secrets and variables > Actions > New repository secret** and add:

| Secret name | Value |
|-------------|-------|
| `HOSHO_API_KEY` | The API key you received |

### 3. Create a workflow file

Create the file `.github/workflows/hosho-prompt-review.yml` in your repo (create the `.github/workflows/` directory if it doesn't exist yet) and paste the following:

```yaml
name: Hosho Prompt Review
run-name: >-
  Hosho Prompt Review —
  ${{ github.event_name == 'pull_request'
      && format('PR #{0}', github.event.pull_request.number)
      || github.event_name == 'issue_comment'
      && format('PR #{0} (slash cmd)', github.event.issue.number)
      || inputs.prompt_file }}

on:
  pull_request:
    paths:
      - '**/*system-prompt*.md'   # Adjust to match your prompt file naming pattern
      # To match multiple patterns, add more lines:
      # - '**/*user-prompt*.md'
  issue_comment:
    types: [created]              # Enables /hosho-review and /hosho-improve slash commands
  workflow_dispatch:
    inputs:
      prompt_file:
        description: "Path to prompt file to review"
        required: true

concurrency:
  group: hosho-review-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  issues: write       # Required — GitHub's PR comment API uses the issues endpoint
  actions: write      # Optional — enables showing prompt names in the run list

jobs:
  review:
    runs-on: ubuntu-latest
    if: >-
      github.event_name == 'workflow_dispatch'
      || (github.event_name == 'pull_request' && github.event.pull_request.draft == false)
      || (github.event_name == 'issue_comment'
          && github.event.issue.pull_request != null
          && (contains(github.event.comment.body, '/hosho-review')
              || contains(github.event.comment.body, '/hosho-improve')))
    steps:
      # Slash commands need to look up the PR branch before checkout
      - name: Get PR branch (slash command only)
        if: github.event_name == 'issue_comment'
        id: pr_details
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          PR_NUMBER=${{ github.event.issue.number }}
          PR_BRANCH=$(gh pr view $PR_NUMBER --repo ${{ github.repository }} --json headRefName -q '.headRefName')
          if [ -z "$PR_BRANCH" ]; then
            echo "::error::Could not find PR branch for #$PR_NUMBER"
            exit 1
          fi
          echo "pr_number=$PR_NUMBER" >> $GITHUB_OUTPUT
          echo "pr_branch=$PR_BRANCH" >> $GITHUB_OUTPUT

      - uses: actions/checkout@v4
        if: github.event_name != 'issue_comment'
        with:
          fetch-depth: 0   # Required — the action needs git history to compare versions

      - uses: actions/checkout@v4
        if: github.event_name == 'issue_comment'
        with:
          fetch-depth: 0
          ref: ${{ steps.pr_details.outputs.pr_branch }}

      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # Provided automatically by GitHub — do not create this secret
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          # Supports comma-separated patterns to match multiple naming conventions:
          #   file_pattern: '**/*system-prompt*.md, **/*user-prompt*.md'
          file_pattern: '**/*system-prompt*.md'
          prompt_file: ${{ github.event.inputs.prompt_file || '' }}
          pr_number: ${{ steps.pr_details.outputs.pr_number || '' }}
          # system_overview: docs/system-overview.md       # Optional — see step 4
          # custom_principles: docs/prompt-principles.md   # Optional — see step 5
```

That's it — one file handles PR reviews, slash commands, and on-demand reviews. Every PR that changes matching files gets an automated review comment. You can also comment `/hosho-improve` on a PR for detailed scoring, or run manually from the Actions tab to evaluate any prompt file on demand.

The `file_pattern` input supports comma-separated glob patterns (e.g., `**/*system-prompt*.md, **/*user-prompt*.md`) to match multiple naming conventions. Make sure the `paths:` trigger at the top of the workflow matches the same patterns so the workflow triggers correctly.

> **Note:** The `file_pattern` input uses glob matching (powered by [minimatch](https://github.com/isaacs/minimatch)), so `**/*system-prompt*.md` matches files named `system-prompt.md` or `my-agent-system-prompt.md` in any directory.

> **Note:** The `issue_comment` trigger fires on *all* PR comments. The `if` condition filters it down to only `/hosho-review` and `/hosho-improve` commands, so other comments are ignored.

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
- Model: Claude Sonnet
- Role: Creates project plan from requirements
- Inputs: Requirements spec from Requirements Gatherer
- Outputs: Project plan, fed to Builder

## Data Flow
User → Requirements Gatherer → Planner → Builder → Reviewer → User
```

### 5. (Optional) Add custom review principles

If your team has specific prompt engineering standards, create a markdown file listing them and pass it via the `custom_principles` input. The reviewer will evaluate PR diffs against these principles in addition to the standard 6-factor review.

Write each principle as a numbered item — short, actionable, and specific to your team's conventions:

```markdown
# Prompt Review Principles

1. Clear & unambiguous with minimal tokens
2. Each agent does one thing (single responsibility)
3. Standard 3-part structure: Role, Context, Instructions
4. Use positive instructions over negative ones ("do X" not "don't do Y")
5. Design for prompt caching — keep stable content at the top
```

Add the input to your workflow:

```yaml
      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          file_pattern: '**/*system-prompt*.md'
          custom_principles: 'docs/prompt-principles.md'
```

Custom principles only activate in PR mode (when a diff exists). Findings from custom principles are deduplicated against the standard review — no redundant feedback.

### 6. Using on-demand mode

On-demand mode is already included in the workflow above via the `workflow_dispatch` trigger. To run it: go to the **Actions** tab in your GitHub repo → select **Hosho Prompt Review** → click **Run workflow** → enter the path to your prompt file → click the green **Run workflow** button. Results appear in the Job Summary for that run.

### Verify it works

**PR mode:** Create a branch, edit a prompt file, and open a pull request. A review comment will appear within 1-2 minutes.

**On-demand mode:** Go to the **Actions** tab → select **Hosho Prompt Review** → click **Run workflow** → enter a prompt file path. Results appear in the Job Summary at the bottom of the workflow run page (click the run, then scroll down past the logs).

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | Hosho API key |
| `prompt_file` | No | `''` | Path to a specific prompt file (on-demand mode) |
| `file_pattern` | No | `''` | Glob pattern(s) for identifying prompt files in PRs. Supports comma-separated patterns (e.g. `**/*system-prompt*.md, **/*user-prompt*.md`) |
| `prompt_path` | No | `''` | Directory prefix for identifying prompt files in PRs (e.g. `prompts/`). Alternative to `file_pattern` |
| `system_overview` | No | `''` | Path to a system overview markdown file |
| `custom_principles` | No | `''` | Path to a markdown file with team-specific prompt review principles |
| `api_url` | No | Built-in | API endpoint URL — override for enterprise/self-hosted deployments |
| `timeout` | No | `600` | API call timeout in seconds |
| `pr_number` | No | `''` | PR number — set automatically when using slash commands (see workflow above) |

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

### Slash Commands

Comment on any open PR to trigger a review:

| Command | What it does |
|---------|-------------|
| `/hosho-review` | Re-runs the review summary (same as the automatic PR review) |
| `/hosho-improve` | Full evaluation with detailed scoring, improvement suggestions, and before/after code snippets |

Slash commands require the `issue_comment` trigger in your workflow — already included in the setup workflow above. The action automatically detects which command was used and adjusts the output accordingly.

### On-Demand Mode

Triggered via `workflow_dispatch` (manual run) or any non-PR event. Requires the `prompt_file` input. Writes full evaluation results to the Job Summary in the Actions tab.

The workflow in step 3 above already includes on-demand support via the `workflow_dispatch` trigger. See [`examples/on-demand.yml`](examples/on-demand.yml) for a standalone alternative.

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

### Licensing

This GitHub Action client is open source under the [MIT License](LICENSE). The Hosho API service that performs the evaluations is proprietary to Hosho Private Limited and is not covered by this license.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `401 Unauthorized` from API | Check that `HOSHO_API_KEY` is set correctly in your repo secrets |
| "GITHUB_TOKEN environment variable is required" | Add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the action step |
| "fatal: bad revision" or "path not found" in logs | Add `fetch-depth: 0` to your `actions/checkout` step |
| "Resource not accessible by integration" (403) | Add `permissions: pull-requests: write` and `issues: write` to the workflow |
| No PR comment appears but action succeeds | Check that `GITHUB_TOKEN` has write permissions and the workflow has the permissions block |
| Action times out | Default timeout is 600s (10 minutes). Evaluations take 60-90 seconds per file. For many files, increase with `timeout: 600` |
| Slash command doesn't trigger | Ensure your workflow has the `issue_comment` trigger and the `if` condition checks for the command (see setup workflow above) |

---

## Disclaimer

This tool is provided as-is for informational purposes. It does not constitute professional advice. Use at your own risk. The authors are not liable for any damages or losses arising from its use.
