# Declaring which model each prompt runs on (`.github/hosho/models.md`)

Hosho's **model-fit** check scores a prompt against the best practices of the model it actually runs
on — so it needs to know that model. Two ways it learns it:

- **In the editor**, you pick the model when you review — that's stored per review.
- **In CI**, if you don't tell it, Hosho *infers* the model by having an LLM read your architecture
  notes and guess which model each file uses. That guess drifts (notes lag the code), collides (many
  files are named `system-prompt.md`), and silently falls back to "model-fit not evaluated" when it
  can't tell.

Add a `models.md` and the guess is replaced by an exact, deterministic lookup.

## The file

Put it at **`.github/hosho/models.md`** — same folder and same markdown convention as any other Hosho
doc. It's a plain markdown **table**: each row maps a **path glob** to a **model family**, optionally
with a class. Hosho reads the table *exactly* — it is never fed to an LLM.

```markdown
# Models — which model each prompt runs on

| Prompt path (glob)   | Model            |
| -------------------- | ---------------- |
| `agents/router/**`   | openai/reasoning |
| `agents/summarizer/**` | gemini         |
| `agents/**`          | claude           |  <!-- everything else under agents/ -->
| `**/*prompt*.md`     | gemini           |  <!-- a catch-all -->
```

- **family** — one of: `claude`, `openai`, `gemini`, `deepseek`, `qwen`, `kimi`, `glm`.
- **class** — `reasoning` or `standard` (default `standard`), written `family/class`. Reasoning models
  are scored against a different set of best-practice rows.
- **Most-specific wins.** A file matched by several globs takes the one with the longest fixed
  prefix, so row order doesn't matter — put catch-alls and specifics wherever you like.
- **Forgiving.** Prose, headings and HTML comments (any line without a `|`) are ignored; the first
  table row is treated as the header. An unknown family, a bad class, or a malformed row is skipped
  with a warning in the Action log; the rest still apply, and any file that matches nothing simply
  falls back to the old inference. A broken `models.md` never fails your review.

## Turn it on

Point the Action at it (alongside your other Hosho inputs):

```yaml
- uses: HOSHO-AI/Hosho-prompt-optimization-public@v1
  with:
    api_key: ${{ secrets.HOSHO_API_KEY }}
    models_config: .github/hosho/models.md
```

That's it. Model-fit now scores every prompt against the model you declared — no inference, no drift.

> You maintain this file; Hosho only reads it. Keep it next to your prompts so a model change and the
> prompt change land in the same PR.
