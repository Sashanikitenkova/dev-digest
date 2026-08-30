import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, EvalCase, EvalRunRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/eval.json";
import { formatMetric, passSummary, targetLabel, caseStatus } from "./helpers";

const useEvalCases = vi.fn();
const useEvalDashboard = vi.fn();
const startRun = vi.fn();
vi.mock("../../../../../../../lib/hooks/eval", () => ({
  useEvalCases: (id: string) => useEvalCases(id),
  useEvalDashboard: (id: string) => useEvalDashboard(id),
  useEvalBatch: () => ({ data: undefined }),
  useStartEvalRun: () => ({ mutateAsync: startRun, isPending: false }),
  useDeleteEvalCase: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { EvalsTab } from "./EvalsTab";

const AGENT = { id: "ag1", name: "Security Reviewer" } as Agent;

const evalCase = (over: Partial<EvalCase> = {}): EvalCase =>
  ({
    id: "c1",
    owner_kind: "agent",
    owner_id: "ag1",
    name: "stripe-key-leak",
    input_diff: "@@ -10,3 +10,4 @@",
    input_files: null,
    input_meta: null,
    expected_output: {
      kind: "must_find",
      targets: [{ file: "src/config.ts", start_line: 11, end_line: 11 }],
    },
    notes: null,
    source_finding_id: "f1",
    created_at: "2026-08-30T10:00:00.000Z",
    ...over,
  }) as EvalCase;

const run = (over: Partial<EvalRunRecord> = {}): EvalRunRecord =>
  ({ id: "r1", case_id: "c1", pass: true, ...over }) as EvalRunRecord;

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: messages }}>
      <EvalsTab agent={AGENT} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useEvalCases.mockReset();
  useEvalDashboard.mockReset();
  startRun.mockReset();
});

describe("EvalsTab", () => {
  it("lists the agent's cases with the expectation kind that produced them", () => {
    useEvalCases.mockReturnValue({
      data: { cases: [evalCase(), evalCase({ id: "c2", name: "noisy-nit", expected_output: { kind: "must_not_flag", targets: [{ file: "a.ts", start_line: 1, end_line: 1 }] } })], latest: {} },
      isLoading: false,
      isError: false,
    });
    useEvalDashboard.mockReturnValue({ data: undefined });
    renderTab();

    expect(screen.getByText("stripe-key-leak")).toBeInTheDocument();
    expect(screen.getByText("must find")).toBeInTheDocument();
    expect(screen.getByText("must not flag")).toBeInTheDocument();
  });

  it("shows '—' for a metric with no evidence rather than 0%", () => {
    // A never-run agent has measured nothing. Rendering that as 0% would read
    // as a total failure, and as 100% would be a score it never earned.
    useEvalCases.mockReturnValue({ data: { cases: [evalCase()], latest: {} }, isLoading: false, isError: false });
    useEvalDashboard.mockReturnValue({ data: undefined });
    renderTab();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("still shows '—' when the API reports zeros for an agent that never ran", () => {
    // The live shape, not the undefined one: `EvalDashboard.current` types its
    // metrics as plain numbers, so a never-run agent comes back as three zeros.
    // Zero TRACES is the sentinel — without it the tab reports a clean 0%
    // regression for an agent nobody has evaluated.
    useEvalCases.mockReturnValue({ data: { cases: [evalCase()], latest: {} }, isLoading: false, isError: false });
    useEvalDashboard.mockReturnValue({
      data: {
        cases_total: 9,
        current: {
          recall: 0,
          precision: 0,
          citation_accuracy: 0,
          traces_passed: 0,
          traces_total: 0,
          cost_usd: null,
        },
        delta: { recall: 0, precision: 0, citation_accuracy: 0 },
        trend: [],
        recent_runs: [],
        alert: null,
      },
    });
    renderTab();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBe(4);
  });

  it("shows real percentages once a run has actually measured something", () => {
    useEvalCases.mockReturnValue({ data: { cases: [evalCase()], latest: {} }, isLoading: false, isError: false });
    useEvalDashboard.mockReturnValue({
      data: {
        cases_total: 9,
        current: {
          recall: 0.82,
          precision: 0.91,
          citation_accuracy: 0.95,
          traces_passed: 5,
          traces_total: 9,
          cost_usd: 0.02,
        },
        delta: { recall: 0.04, precision: -0.02, citation_accuracy: 0.01 },
        trend: [],
        recent_runs: [],
        alert: null,
      },
    });
    renderTab();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("5/9")).toBeInTheDocument();
  });

  it("disables the run control when the set is empty", () => {
    useEvalCases.mockReturnValue({ data: { cases: [], latest: {} }, isLoading: false, isError: false });
    useEvalDashboard.mockReturnValue({ data: undefined });
    renderTab();
    expect(screen.getByText(/Run all evals/)).toBeDisabled();
    expect(screen.getByText("No eval cases yet")).toBeInTheDocument();
  });

  it("starts a run over the whole set when there are cases", async () => {
    useEvalCases.mockReturnValue({ data: { cases: [evalCase()], latest: {} }, isLoading: false, isError: false });
    useEvalDashboard.mockReturnValue({ data: undefined });
    startRun.mockResolvedValue({ batch_id: "b1", cases_total: 1 });
    renderTab();
    // The handler awaits the mutation and then stores the batch id, so the
    // click has to be flushed inside act() or React warns about the late setState.
    await act(async () => {
      fireEvent.click(screen.getByText(/Run all evals/));
    });
    expect(startRun).toHaveBeenCalledWith("ag1");
  });

  it("summarises how many cases are passing", () => {
    useEvalCases.mockReturnValue({
      data: {
        cases: [evalCase(), evalCase({ id: "c2", name: "b" })],
        latest: { c1: run(), c2: run({ id: "r2", case_id: "c2", pass: false }) },
      },
      isLoading: false,
      isError: false,
    });
    useEvalDashboard.mockReturnValue({ data: undefined });
    renderTab();
    expect(screen.getByText("1 / 2 passing")).toBeInTheDocument();
  });
});

describe("EvalsTab helpers", () => {
  it("formatMetric returns null for no evidence, never a number", () => {
    expect(formatMetric(null)).toBeNull();
    expect(formatMetric(undefined)).toBeNull();
    expect(formatMetric(0)).toBe("0");
    expect(formatMetric(0.824)).toBe("82");
  });

  it("targetLabel renders a single line and a range differently", () => {
    expect(targetLabel(evalCase())).toBe("src/config.ts:11");
    expect(
      targetLabel(
        evalCase({
          expected_output: {
            kind: "must_find",
            targets: [{ file: "src/api/users.ts", start_line: 44, end_line: 46 }],
          },
        }),
      ),
    ).toBe("src/api/users.ts:44-46");
  });

  it("caseStatus distinguishes never-run from failed", () => {
    expect(caseStatus(undefined)).toBe("never");
    expect(caseStatus(run({ pass: false }))).toBe("failed");
    expect(caseStatus(run({ pass: true }))).toBe("passed");
  });

  it("passSummary counts only cases that have actually run", () => {
    const cases = [evalCase(), evalCase({ id: "c2" }), evalCase({ id: "c3" })];
    expect(passSummary(cases, { c1: run(), c2: run({ case_id: "c2", pass: false }) })).toEqual({
      passed: 1,
      ran: 2,
    });
  });
});
