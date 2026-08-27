import { describe, it, expect } from "vitest";
import { diffSnippetBudget } from "../src/index";

// Measured on the live comment for appsmithorg/appsmith-v2 PR #17312: 66,679 B across 11 files,
// carrying the truncation marker, with ```diff blocks accounting for 23,177 B — 35% of the whole
// body and its single largest component. The pre-existing 15-line cap did not bind, because prompt
// diffs are a handful of ~140-char lines rather than many short ones. Hence a byte budget.
//
// Three live comments were over GitHub's 65,536 limit when this was written: #17467 (69,321 B),
// #15789 (67,849 B), #17312 (66,679 B).

describe("diffSnippetBudget", () => {
  it("bounds the TOTAL diff spend regardless of how many prompt files a PR touches", () => {
    for (const files of [1, 5, 11, 25, 60]) {
      expect(diffSnippetBudget(files) * files).toBeLessThanOrEqual(11_000);
    }
  });

  it("keeps a single-file PR generous — there is nothing to share the budget with", () => {
    expect(diffSnippetBudget(1)).toBe(1_500);
    expect(diffSnippetBudget(5)).toBe(1_500); // 10000/5 = 2000, clamped to the per-file max
  });

  it("shrinks as the file count grows, then drops out rather than degrading into fragments", () => {
    expect(diffSnippetBudget(11)).toBe(909);
    expect(diffSnippetBudget(25)).toBe(400);   // exactly at the floor — still worth showing
    expect(diffSnippetBudget(26)).toBe(0);     // below it: no snippet, not a useless stub
    expect(diffSnippetBudget(200)).toBe(0);
  });

  it("is safe at the degenerate inputs", () => {
    expect(diffSnippetBudget(0)).toBe(1_500);
    expect(diffSnippetBudget(-3)).toBe(1_500);
  });

  it("would have brought PR #17312 back under the cap", () => {
    // 66,679 B measured, of which 23,177 B was diff. Replacing that with the new bounded total:
    const projected = 66_679 - 23_177 + diffSnippetBudget(11) * 11;
    expect(projected).toBeLessThan(65_536);
    expect(projected).toBeLessThan(56_000); // ~12 KB of headroom, not a hair's breadth
  });
});
