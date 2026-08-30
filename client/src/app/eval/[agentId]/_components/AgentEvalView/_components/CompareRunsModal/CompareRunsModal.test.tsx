import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord, EvalCompare } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/eval.json";
import { diffPromptLines } from "./helpers";

const useEvalCompare = vi.fn();
vi.mock("../../../../../../../lib/hooks/eval", () => ({
  useEvalCompare: () => useEvalCompare(),
}));

import { CompareRunsModal } from "./CompareRunsModal";

const batch = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord =>
  ({
    id: "b1",
    owner_kind: "agent",
    owner_id: "ag1",
    status: "done",
    started_at: "2026-08-27T16:40:00.000Z",
    finished_at: null,
    agent_version: 6,
    system_prompt: "You are a security reviewer.\nReturn at most 5 findings.",
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

const compare = (over: Partial<EvalCompare> = {}): EvalCompare =>
  ({
    a: batch(),
    b: batch({
      id: "b2",
      agent_version: 7,
      system_prompt:
        "You are a security reviewer.\nReturn at most 5 findings.\nEvery finding MUST cite file and line.",
      recall: 0.82,
      precision: 0.91,
      citation_accuracy: 0.95,
      cost_usd: 0.23,
    }),
    delta: { recall: 0.04, precision: -0.02, citation_accuracy: 0.01, cost_usd: 0.02 },
    case_set_mismatch: false,
    skills_changed: false,
    ...over,
  }) as EvalCompare;

function renderModal() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: messages }}>
      <CompareRunsModal aId="b1" bId="b2" onClose={() => {}} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useEvalCompare.mockReset();
});

describe("CompareRunsModal", () => {
  it("shows before → after with a signed delta per metric", () => {
    useEvalCompare.mockReturnValue({ data: compare(), isLoading: false, isError: false });
    renderModal();
    expect(screen.getByText("78%")).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByText("+4pts")).toBeInTheDocument();
    // A precision drop must read as a drop, not an unsigned number.
    expect(screen.getByText("-2pts")).toBeInTheDocument();
  });

  it("highlights the line the new prompt added", () => {
    useEvalCompare.mockReturnValue({ data: compare(), isLoading: false, isError: false });
    renderModal();
    expect(screen.getByText("Every finding MUST cite file and line.")).toBeInTheDocument();
  });

  it("warns when the two runs did not execute the same case set", () => {
    // Without this the deltas look conclusive and are not — the comparison is
    // measuring a different set, not a better agent.
    useEvalCompare.mockReturnValue({
      data: compare({ case_set_mismatch: true }),
      isLoading: false,
      isError: false,
    });
    renderModal();
    expect(screen.getByText(/did not execute the same set/i)).toBeInTheDocument();
  });

  it("warns when a linked skill changed between the runs", () => {
    useEvalCompare.mockReturnValue({
      data: compare({ skills_changed: true }),
      isLoading: false,
      isError: false,
    });
    renderModal();
    expect(screen.getByText(/linked skills also changed/i)).toBeInTheDocument();
  });

  it("stays quiet when both runs are comparable", () => {
    useEvalCompare.mockReturnValue({ data: compare(), isLoading: false, isError: false });
    renderModal();
    expect(screen.queryByText(/did not execute the same set/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/linked skills also changed/i)).not.toBeInTheDocument();
  });

  it("lists each run's snapshotted skills, including 'none'", () => {
    useEvalCompare.mockReturnValue({
      data: compare({
        b: batch({ id: "b2", agent_version: 7, skills_snapshot: [{ skill_id: "s1", name: "pr-quality-rubric", version: 4 }] }),
        skills_changed: true,
      }),
      isLoading: false,
      isError: false,
    });
    renderModal();
    expect(screen.getByText(/pr-quality-rubric v4/)).toBeInTheDocument();
    expect(screen.getByText(/none/)).toBeInTheDocument();
  });
});

describe("diffPromptLines", () => {
  it("marks a line only present in the new prompt as added", () => {
    const lines = diffPromptLines("a\nb", "a\nb\nc");
    expect(lines.find((l) => l.text === "c")?.kind).toBe("added");
    expect(lines.find((l) => l.text === "a")?.kind).toBe("same");
  });

  it("marks a line dropped from the old prompt as removed", () => {
    const lines = diffPromptLines("a\nb", "a");
    expect(lines.find((l) => l.text === "b")?.kind).toBe("removed");
  });

  it("treats a reordered line as unchanged — the model reads the same instruction", () => {
    const lines = diffPromptLines("a\nb", "b\na");
    expect(lines.every((l) => l.kind === "same")).toBe(true);
  });

  it("ignores indentation-only differences", () => {
    const lines = diffPromptLines("a", "  a");
    expect(lines.every((l) => l.kind === "same")).toBe(true);
  });
});
