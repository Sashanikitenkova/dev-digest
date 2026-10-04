import { describe, it, expect } from "vitest";
import { findingToMarkdown } from "./helpers";

const BASE = {
  severity: "WARNING" as const,
  category: "perf" as const,
  title: "N+1 query in loop",
  file: "src/orders.ts",
  start_line: 20,
  end_line: 24,
  rationale: "Each iteration issues a query.",
  suggestion: undefined as string | undefined,
};

describe("findingToMarkdown", () => {
  it("renders a line range and omits the fix section without a suggestion", () => {
    expect(findingToMarkdown(BASE)).toBe(
      "**[WARNING] N+1 query in loop** · perf\n\n`src/orders.ts:L20-24`\n\nEach iteration issues a query.",
    );
  });

  it("appends the suggested fix when present", () => {
    const md = findingToMarkdown({ ...BASE, start_line: 20, end_line: 20, suggestion: "Batch the lookups." });
    expect(md).toContain("`src/orders.ts:L20`");
    expect(md.endsWith("**Suggested fix:**\nBatch the lookups.")).toBe(true);
  });
});
