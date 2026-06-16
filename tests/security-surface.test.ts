import { describe, it, expect } from 'vitest';
import {
  parseAssemblyConfig,
  checkRequiredReferences,
  refineReferenceViolations,
  checkRemovedReferences,
  evaluateReferenceConvention,
  hasSecuritySurface,
  hasInlineSecurityRules,
  isStructurallyExempt,
} from '../src/file-fetcher';

// The appsmith-v2 convention config, verbatim: every prompt under backend/app/llm
// matching *prompt*.md "must" reference the shared security doc, severity critical.
const CFG = parseAssemblyConfig(`
inject_when_referenced:
  - backend/docs/rules/agent-security.md
require_reference:
  - file: backend/docs/rules/agent-security.md
    for: "backend/app/llm/**/*prompt*.md"
    severity: critical
`);

// Drive through the real per-mode composition (evaluateReferenceConvention), the same
// path index.ts uses. `improve` with no before = the absolute full-assessment case.
function improve(content: string, filePath: string) {
  return evaluateReferenceConvention(null, content, filePath, CFG, 'improve');
}
function improveDiff(before: string | null, after: string, filePath: string) {
  return evaluateReferenceConvention(before, after, filePath, CFG, 'improve');
}
function reviewDiff(before: string | null, after: string, filePath: string) {
  return evaluateReferenceConvention(before, after, filePath, CFG, 'review');
}

// ---- Corpus snippets (grounded in real appsmith-v2 prompts) -----------------

// Group A — agents that already cite the doc → compliant, never flagged.
const ORCHESTRATOR = `# Role
You build websites using HTML, JavaScript and CSS.
Follow the shared security rules in \`docs/rules/agent-security.md\`. Key points for this agent:`;

// Group B — sandbox/task agents (should get an advisory nudge).
const CODING_AGENT = `---
description: General-purpose coding agent for team tasks. Implements changes in an isolated sandbox and submits website edits as reviewable drafts.
allowed_skills: null
streaming: false
---
Role: You are the Kite coding agent. You handle general implementation tasks.`;

const SEO_AGENT = `---
description: SEO analyst that audits a deployed website.
allowed_skills: ["sitemap-rules", "sitemap-redirects", "structured-data-suggester", "llms-txt-generator"]
streaming: false
---
Your skills cover sitemap rules, redirects, structured data, and \`llms.txt\` generation.`;

const CMO_AGENT = `---
description: Team-level CMO agent advising on website conversion, content, SEO, and go-to-market.
streaming: true
# allowed_skills intentionally omitted (NULL = no whitelist). CMO is the
# user-facing conversational agent; its sandbox skills are managed in code via
# an exclude-list (cmo_agent._EXCLUDED_SKILLS), not a whitelist here.
---
You delegate execution by creating team tasks. Run \`kite-tasks create "<title>"\` to delegate a piece of work. Each task runs its own specialist agent in its own sandbox.`;

const TEAM_TASK_SYSTEM = `Role: You are the Kite coding agent. You handle general implementation tasks.
2. If the task asks to inspect an existing website, run \`kite-websites list\`, then \`kite-websites clone <website_id>\`. Edit only the returned clone path.
7. Set the task result with the \`set-task-result\` command.`;

// Group C — pure generators (must never be flagged).
const DRAFT_NAME = `You generate a short label for the user's intent.
Generate a concise label (maximum 60 characters) that captures the intent.
Output an empty string when the user's intent is unclear.`;

const KEYWORD_GEN = `You analyse competitor keywords.
Your output is consumed programmatically. Return exactly the JSON schema you have been given, with two arrays: \`branded_picks\` and \`non_branded_picks\`.`;

const LOGO_DESCRIBER = `Analyse this logo image and return a structured description with the following fields.
Return only the structured description, no preamble.`;

const WEBSITE_NAME = `Extract or generate a name for the user's website.
Priority order: if the user states a name, output it exactly. Maximum 50 characters.`;

// Group B input templates / non-agents (structurally exempt).
const USER_PROMPT_TEMPLATE = `{# title: str — task title #}
{# description: str | None #}
Complete this task, then report the outcome with \`set-task-result\`. The sandbox is not preloaded with a website.`;

describe('hasSecuritySurface — strong signals', () => {
  it('frontmatter allowed_skills → surface', () => {
    expect(hasSecuritySurface(CODING_AGENT).surface).toBe(true);
    expect(hasSecuritySurface(SEO_AGENT).surface).toBe(true);
  });
  it('tool/command invocation → surface (even without allowed_skills)', () => {
    expect(hasSecuritySurface(CMO_AGENT).surface).toBe(true);
    expect(hasSecuritySurface(TEAM_TASK_SYSTEM).surface).toBe(true);
  });
});

describe('hasSecuritySurface — generators stay silent', () => {
  for (const [name, content] of Object.entries({ DRAFT_NAME, KEYWORD_GEN, LOGO_DESCRIBER, WEBSITE_NAME })) {
    it(`${name} → no surface`, () => {
      expect(hasSecuritySurface(content).surface).toBe(false);
    });
  }
  it('a generator that merely mentions a credential word is not pulled in', () => {
    // weak INFRA signal ("token") is ignored when the prompt is framed as a generator
    const c = 'Return exactly the JSON schema. Estimate the token budget for each keyword.';
    expect(hasSecuritySurface(c).surface).toBe(false);
  });
});

describe('isStructurallyExempt', () => {
  it('user-prompt / task-input templates are exempt', () => {
    expect(isStructurallyExempt('backend/app/llm/cmo_agent/user-prompt.md', USER_PROMPT_TEMPLATE)).toBe(true);
    expect(isStructurallyExempt('backend/app/llm/coding/team_task/user-prompt.md', USER_PROMPT_TEMPLATE)).toBe(true);
  });
  it('eval / skills / spec / authoring prompts are exempt', () => {
    expect(isStructurallyExempt('backend/app/llm/coding/evals/judge-system-prompt.md', 'judge')).toBe(true);
    expect(isStructurallyExempt('backend/app/llm/skills/images/references/prompt-authoring.md', 'x')).toBe(true);
    expect(isStructurallyExempt('backend/app/llm/scrape_visual_spec/visual-spec-prompt.md', 'x')).toBe(true);
  });
  it('a normal agent system-prompt is NOT exempt', () => {
    expect(isStructurallyExempt('backend/app/llm/coding_agent/system-prompt.md', CODING_AGENT)).toBe(false);
  });
});

describe('improve() — full-assessment outcome for PR #12522 files (config unchanged)', () => {
  it('compliant prompts (already cite the doc) → no finding', () => {
    expect(improve(ORCHESTRATOR, 'backend/app/llm/orchestrator_agent/system-prompt.md')).toHaveLength(0);
  });

  it('user-prompts → suppressed', () => {
    expect(improve(USER_PROMPT_TEMPLATE, 'backend/app/llm/cmo_agent/user-prompt.md')).toHaveLength(0);
    expect(improve(USER_PROMPT_TEMPLATE, 'backend/app/llm/coding/team_task/user-prompt.md')).toHaveLength(0);
  });

  it('pure generators → never flagged', () => {
    expect(improve(DRAFT_NAME, 'backend/app/llm/content/draft_name/system-prompt.md')).toHaveLength(0);
    expect(improve(KEYWORD_GEN, 'backend/app/llm/keyword_opportunity_generator/system-prompt.md')).toHaveLength(0);
    expect(improve(LOGO_DESCRIBER, 'backend/app/llm/design/logo_describer/logo-describe-prompt.md')).toHaveLength(0);
    expect(improve(WEBSITE_NAME, 'backend/app/llm/content/website_name/system-prompt.md')).toHaveLength(0);
  });

  it('sandbox/task agents → exactly one ADVISORY suggestion (never critical)', () => {
    const cases: Array<[string, string]> = [
      [CODING_AGENT, 'backend/app/llm/coding_agent/system-prompt.md'],
      [SEO_AGENT, 'backend/app/llm/seo/system-prompt.md'],
      [CMO_AGENT, 'backend/app/llm/cmo_agent/system-prompt.md'],
    ];
    for (const [content, file] of cases) {
      const out = improve(content, file);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('suggestion');
      expect(out[0].file).toBe('backend/docs/rules/agent-security.md');
      expect(out[0].reason).toBeTruthy();
    }
  });

  it('a security-surface agent that STATES the rules inline (no link) → suppressed (covered)', () => {
    const inlined = `---
allowed_skills: null
---
Role: Kite coding agent. Do not create API proxy or relay endpoints, do not read or forward
environment variables containing KEY/SECRET/TOKEN, do not create HTTP servers on custom ports,
and do not install AI provider SDKs for proxying.`;
    expect(hasInlineSecurityRules(inlined)).toBe(true);
    expect(improve(inlined, 'backend/app/llm/coding_agent/system-prompt.md')).toHaveLength(0);
  });

  it('improve mode never emits a critical (blocking) finding', () => {
    const all = [CODING_AGENT, SEO_AGENT, CMO_AGENT, TEAM_TASK_SYSTEM].flatMap((c, i) =>
      improve(c, `backend/app/llm/agent${i}/system-prompt.md`),
    );
    expect(all.every(v => v.severity === 'suggestion')).toBe(true);
  });

  it('files outside the for-glob are untouched', () => {
    expect(improve(CODING_AGENT, 'frontend/src/App.tsx')).toHaveLength(0);
  });
});

describe('reviewDiff() — review mode flags ONLY a removed reference', () => {
  const file = 'backend/app/llm/coding/system-prompt.md';
  const WITH_REF = 'See `docs/rules/agent-security.md` for the full policy.\nRole: coding agent.';
  const WITHOUT_REF = 'Role: coding agent.';

  it('PR removes an existing reference → one finding at the config severity (critical)', () => {
    const out = reviewDiff(WITH_REF, WITHOUT_REF, file);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('backend/docs/rules/agent-security.md');
    expect(out[0].severity).toBe('critical');   // honors config severity for a real removal
    expect(out[0].reason).toBe('removed-reference');
  });

  it('new file (no before) → never flagged, regardless of content', () => {
    expect(reviewDiff(null, WITHOUT_REF, file)).toHaveLength(0);
  });

  it('pre-existing absence (before also lacked it) → not flagged (not a regression)', () => {
    expect(reviewDiff(WITHOUT_REF, WITHOUT_REF, file)).toHaveLength(0);
  });

  it('reference still present after → not flagged', () => {
    expect(reviewDiff(WITH_REF, WITH_REF, file)).toHaveLength(0);
  });

  it('removal in a file outside the for-glob → not flagged', () => {
    expect(reviewDiff(WITH_REF, WITHOUT_REF, 'frontend/src/App.tsx')).toHaveLength(0);
  });

  it('#12522 reality: no prompt removes the reference → zero review findings', () => {
    // The PR adds frontmatter; none of these touch an agent-security reference.
    for (const f of [
      'backend/app/llm/cmo_agent/system-prompt.md',
      'backend/app/llm/coding_agent/system-prompt.md',
      'backend/app/llm/seo/system-prompt.md',
    ]) {
      // before === after (no security-reference change) → no removal
      expect(reviewDiff('Role: agent.', 'Role: agent.\n---\ndescription: x\n---', f)).toHaveLength(0);
    }
  });
});

describe('improve mode mirrors the standard pipeline: full assessment + diff regression', () => {
  const file = 'backend/app/llm/coding_agent/system-prompt.md';
  // A sandbox agent (allowed_skills) that links the doc AND inlines the rules.
  const COVERED_WITH_LINK = `---
allowed_skills: null
---
See \`docs/rules/agent-security.md\`. Do not create API proxy or relay endpoints; do not read
environment variables containing KEY/SECRET/TOKEN.`;
  // Same agent, link removed, but the inline rules remain (absolute check would say "covered").
  const LINK_REMOVED_INLINE_KEPT = `---
allowed_skills: null
---
Do not create API proxy or relay endpoints; do not read environment variables containing KEY/SECRET/TOKEN.`;
  // Same agent, link removed AND no inline rules left (genuinely non-compliant now).
  const LINK_REMOVED_NOTHING_LEFT = `---
allowed_skills: null
---
Role: Kite coding agent. You handle general implementation tasks.`;

  it('THE GAP v1.38.0 missed: removal with inline rules still present → improve flags the REMOVAL', () => {
    // Absolute check alone would suppress (inline rules present) — but the standard diff
    // analysis would flag the removal in improve mode, so we must too.
    expect(refineReferenceViolations(LINK_REMOVED_INLINE_KEPT, file,
      checkRequiredReferences(LINK_REMOVED_INLINE_KEPT, file, CFG))).toHaveLength(0); // absolute alone: silent
    const out = improveDiff(COVERED_WITH_LINK, LINK_REMOVED_INLINE_KEPT, file);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('removed-reference');
    expect(out[0].severity).toBe('critical'); // removal honors config severity
  });

  it('removal AND now non-compliant → exactly ONE finding (removal wins, not double-counted)', () => {
    const out = improveDiff(COVERED_WITH_LINK, LINK_REMOVED_NOTHING_LEFT, file);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('removed-reference');
  });

  it('pre-existing gap (no before, never linked, no inline) → absolute advisory only', () => {
    const out = improveDiff(null, LINK_REMOVED_NOTHING_LEFT, file);
    expect(out).toHaveLength(1);
    expect(out[0].reason).not.toBe('removed-reference');
    expect(out[0].severity).toBe('suggestion');
  });

  it('review mode of the same removal also flags it (parity)', () => {
    const out = reviewDiff(COVERED_WITH_LINK, LINK_REMOVED_INLINE_KEPT, file);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('removed-reference');
  });
});
