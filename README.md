# Prompt Factor Reviewer

A GitHub Action that evaluates AI agent prompts against 6 prompt engineering quality factors, powered by the Hosho review API.

## Features

- **PR Mode**: Automatically reviews prompt files changed in pull requests, posts a detailed review comment with scores and recommendations
- **On-Demand Mode**: Evaluate any prompt file via `workflow_dispatch`
- **6 Quality Factors**: Scope, Structure & Flow, Context & Guidance, Constraints, Output Validation, Model-Specific Prompting
- **Diff Analysis**: In PR mode, identifies what improved or regressed between the base and head versions

## Quick Start

```yaml
name: Prompt Review

on:
  pull_request:
    paths:
      - 'prompts/**'

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          api_url: ${{ secrets.HOSHO_API_URL }}
          prompt_path: prompts/
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | Yes | — | Hosho Prompt Reviewer API key |
| `api_url` | Yes | — | API endpoint URL |
| `prompt_file` | No | `''` | Path to prompt file (on-demand mode only) |
| `prompt_path` | No | `prompts/` | Directory prefix for identifying prompt files in PRs |
| `system_overview` | No | `''` | Path to system overview markdown file describing the multi-agent pipeline |

## Outputs

| Output | Description |
|--------|-------------|
| `overall_score` | Overall score label (Excellent/Good/Needs Work/Critical) |
| `review_summary` | Brief summary of the review findings |

## Modes

### PR Mode

Triggered on `pull_request` events. The action:
1. Identifies prompt files changed in the PR (matching `prompt_path`)
2. Sends file content (before and after) to the review API
3. Posts a PR comment with factor scores, findings, and recommendations
4. Posts a review verdict (COMMENT or REQUEST_CHANGES if critical issues found)
5. Writes a Job Summary

### On-Demand Mode

Triggered on `workflow_dispatch` or other non-PR events. Requires `prompt_file` input:

```yaml
on:
  workflow_dispatch:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
        with:
          api_key: ${{ secrets.HOSHO_API_KEY }}
          api_url: ${{ secrets.HOSHO_API_URL }}
          prompt_file: prompts/my-agent.md
```

## System Overview (Optional)

For multi-agent systems, provide a system overview file that describes the pipeline. This helps the reviewer understand context about what inputs the prompt receives and what downstream agents consume its output.

```yaml
- uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
  with:
    api_key: ${{ secrets.HOSHO_API_KEY }}
    api_url: ${{ secrets.HOSHO_API_URL }}
    system_overview: docs/system-overview.md
```

## Requirements

- **API Key**: Contact Hosho to obtain an API key
- **`GITHUB_TOKEN`**: Required for PR mode (posting comments and reviews)
- **`fetch-depth: 0`**: Required for PR mode (accessing base version of files)
