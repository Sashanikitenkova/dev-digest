import { describe, it, expect } from "vitest";
import type { EvalBatchRecord } from "@devdigest/shared";
import { deltaColor, deltaPts, orderPair, pct, skillsLabel, trendSeries } from "./helpers";

const batch = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord =>
  ({
    id: "b1",
    owner_kind: "agent",
    owner_id: "ag1",
    status: "done",
    started_at: "2026-08-27T16:40:00.000Z",
    finished_at: null,
    agent_version: 6,
    system_prompt: "p",
    skills_snapshot: [],
    provider: "openai",
    model: "gpt-4.1",
    recall: 0.78,
    precision: 0.93,
    citation_accuracy: 0.94,
    traces_passed: 16,
    traces_total: 20,
    duration_ms: 1,
    tokens_in: 1,
    tokens_out: 1,
    cost_usd: 0.21,
    error: null,
    ...over,
  }) as EvalBatchRecord;

describe("pct / deltaPts / deltaColor", () => {
  it("distinguishes no evidence from zero", () => {
    expect(pct(null)).toBeNull();
    expect(pct(0)).toBe("0%");
  });

  it("signs a delta and keeps zero unsigned", () => {
    expect(deltaPts(0.04)).toBe("+4pts");
    expect(deltaPts(-0.02)).toBe("-2pts");
    expect(deltaPts(0)).toBe("0pts");
    expect(deltaPts(null)).toBeNull();
  });

  it("colours a rise green, a fall red, and no movement neutral", () => {
    expect(deltaColor(0.04)).toBe("var(--ok)");
    expect(deltaColor(-0.02)).toBe("var(--crit)");
    expect(deltaColor(0)).toBe("var(--text-muted)");
    expect(deltaColor(null)).toBe("var(--text-muted)");
  });
});

describe("trendSeries", () => {
  it("reverses the newest-first API order so the chart reads left to right", () => {
    const series = trendSeries([
      batch({ recall: 0.9 }),
      batch({ recall: 0.8 }),
      batch({ recall: 0.7 }),
    ]);
    expect(series.recall).toEqual([0.7, 0.8, 0.9]);
  });

  it("excludes a still-running batch, which has no numbers yet", () => {
    const series = trendSeries([batch({ status: "running", recall: null }), batch({ recall: 0.8 })]);
    expect(series.recall).toEqual([0.8]);
  });
});

describe("orderPair", () => {
  it("puts the older run first regardless of which was ticked first", () => {
    // Otherwise every delta flips sign depending on click order.
    const older = batch({ id: "old", started_at: "2026-08-01T00:00:00.000Z" });
    const newer = batch({ id: "new", started_at: "2026-08-20T00:00:00.000Z" });
    expect(orderPair(newer, older).map((b) => b.id)).toEqual(["old", "new"]);
    expect(orderPair(older, newer).map((b) => b.id)).toEqual(["old", "new"]);
  });
});

describe("skillsLabel", () => {
  it("names each skill with the version that actually ran", () => {
    expect(
      skillsLabel([
        { skill_id: "s1", name: "pr-quality-rubric", version: 4 },
        { skill_id: "s2", name: "api-contract-guard", version: 1 },
      ]),
    ).toBe("pr-quality-rubric v4, api-contract-guard v1");
  });

  it("returns null when a run linked no skills", () => {
    expect(skillsLabel([])).toBeNull();
  });

  it("falls back to a short id when the snapshot has no name", () => {
    expect(skillsLabel([{ skill_id: "abcdef1234", version: 2 }])).toBe("abcdef12 v2");
  });
});
