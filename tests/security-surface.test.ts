import { describe, it, expect } from 'vitest';
import {
  parseAssemblyConfig,
  checkRequiredReferences,
  refineReferenceViolations,
  hasSecuritySurface,
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

// End-to-end as the action runs it: raw spec primitive → action-level refinement.
function review(content: string, filePath: string) {
  return refineReferenceViolations(content, filePath, checkRequiredReferences(content, filePath, CFG));
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

describe('review() — end-to-end outcome for PR #12522 (config unchanged)', () => {
  it('compliant prompts (already cite the doc) → no finding', () => {
    expect(review(ORCHESTRATOR, 'backend/app/llm/orchestrator_agent/system-prompt.md')).toHaveLength(0);
  });

  it('user-prompts → suppressed', () => {
    expect(review(USER_PROMPT_TEMPLATE, 'backend/app/llm/cmo_agent/user-prompt.md')).toHaveLength(0);
    expect(review(USER_PROMPT_TEMPLATE, 'backend/app/llm/coding/team_task/user-prompt.md')).toHaveLength(0);
  });

  it('pure generators → never flagged', () => {
    expect(review(DRAFT_NAME, 'backend/app/llm/content/draft_name/system-prompt.md')).toHaveLength(0);
    expect(review(KEYWORD_GEN, 'backend/app/llm/keyword_opportunity_generator/system-prompt.md')).toHaveLength(0);
    expect(review(LOGO_DESCRIBER, 'backend/app/llm/design/logo_describer/logo-describe-prompt.md')).toHaveLength(0);
    expect(review(WEBSITE_NAME, 'backend/app/llm/content/website_name/system-prompt.md')).toHaveLength(0);
  });

  it('sandbox/task agents → exactly one ADVISORY suggestion (never critical)', () => {
    const cases: Array<[string, string]> = [
      [CODING_AGENT, 'backend/app/llm/coding_agent/system-prompt.md'],
      [SEO_AGENT, 'backend/app/llm/seo/system-prompt.md'],
      [CMO_AGENT, 'backend/app/llm/cmo_agent/system-prompt.md'],
    ];
    for (const [content, file] of cases) {
      const out = review(content, file);
      expect(out).toHaveLength(1);
      expect(out[0].severity).toBe('suggestion');
      expect(out[0].file).toBe('backend/docs/rules/agent-security.md');
      expect(out[0].reason).toBeTruthy();
    }
  });

  it('never emits a critical (blocking) finding for this check', () => {
    const all = [CODING_AGENT, SEO_AGENT, CMO_AGENT, TEAM_TASK_SYSTEM].flatMap((c, i) =>
      review(c, `backend/app/llm/agent${i}/system-prompt.md`),
    );
    expect(all.every(v => v.severity === 'suggestion')).toBe(true);
  });

  it('files outside the for-glob are untouched', () => {
    expect(review(CODING_AGENT, 'frontend/src/App.tsx')).toHaveLength(0);
  });
});
