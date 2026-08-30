import { describe, it, expect } from "vitest";
import type { ConventionCandidate } from "@devdigest/shared";
import { buildSkillBody, skillNameForRepo, evidenceRange } from "./helpers";
import { partitionByStatus } from "../ConventionsView/helpers";

const base: ConventionCandidate = {
  id: "c1",
  category: "naming",
  rule: "Always use async/await instead of .then() chains.",
  evidence_path: "src/api/users.ts",
  evidence_line: 23,
  evidence_snippet: "const user = await db.users.find(id);",
  confidence: 0.91,
  status: "accepted",
  created_at: "2026-07-19T10:00:00.000Z",
};

describe("skillNameForRepo", () => {
  it("slugifies the repo short name", () => {
    expect(skillNameForRepo("acme/payments-api")).toBe("payments-api-conventions");
  });

  it("handles a bare name and odd characters", () => {
    expect(skillNameForRepo("Some_Repo.v2")).toBe("some-repo-v2-conventions");
  });

  it("falls back when the repo is unknown", () => {
    expect(skillNameForRepo(undefined)).toBe("repo-conventions");
  });
});

describe("evidenceRange", () => {
  it("formats single and multi-line ranges", () => {
    expect(evidenceRange("a.ts", 3)).toBe("a.ts:3");
    expect(evidenceRange("a.ts", 3, 9)).toBe("a.ts:3-9");
    expect(evidenceRange("a.ts", null)).toBe("a.ts");
  });
});

describe("buildSkillBody", () => {
  it("includes every accepted rule and its evidence citation", () => {
    const body = buildSkillBody("acme/payments-api", [
      base,
      { ...base, id: "c2", category: "api", rule: "All handlers return Result<T, ApiError>." },
    ]);
    expect(body).toContain("# payments-api-conventions");
    expect(body).toContain("Always use async/await instead of .then() chains.");
    expect(body).toContain("All handlers return Result<T, ApiError>.");
    // The citation is what lets a reviewer verify the rule against real code.
    expect(body).toContain("`src/api/users.ts:23`");
    expect(body).toContain("const user = await db.users.find(id);");
  });

  it("produces a non-empty body — POST /skills rejects an empty one", () => {
    expect(buildSkillBody("acme/x", []).trim().length).toBeGreaterThan(0);
  });

  it("fences the snippet so markdown renders it as code", () => {
    const body = buildSkillBody("acme/x", [base]);
    const fences = body.match(/```/g) ?? [];
    expect(fences.length).toBe(2);
  });
});

describe("partitionByStatus", () => {
  const rows: ConventionCandidate[] = [
    { ...base, id: "p", status: "pending" },
    { ...base, id: "a", status: "accepted" },
    { ...base, id: "r", status: "rejected" },
  ];

  it("keeps accepted rows in the queue so Create-skill can consume them", () => {
    const { triageable, accepted } = partitionByStatus(rows);
    expect(triageable.map((c) => c.id)).toEqual(["p", "a"]);
    expect(accepted.map((c) => c.id)).toEqual(["a"]);
  });

  it("drops rejected rows from the queue", () => {
    expect(partitionByStatus(rows).triageable.some((c) => c.id === "r")).toBe(false);
  });
});
