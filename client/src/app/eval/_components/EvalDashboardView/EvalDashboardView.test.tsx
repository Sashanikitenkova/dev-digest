import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord } from "@devdigest/shared";
import messages from "../../../../../messages/en/eval.json";
import shellMessages from "../../../../../messages/en/shell.json";
import { pct, recallTrend, runTime } from "./helpers";

const useEvalOverview = vi.fn();
vi.mock("../../../../lib/hooks/eval", () => ({ useEvalOverview: () => useEvalOverview() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/eval",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { EvalDashboardView } from "./EvalDashboardView";

const batch = (over: Partial<EvalBatchRecord> = {}): EvalBatchRecord =>
  ({
    id: "b1",
    owner_kind: "agent",
    owner_id: "ag1",
    status: "done",
    started_at: "2026-08-30T09:14:00.000Z",
    finished_at: "2026-08-30T09:15:00.000Z",
    agent_version: 7,
    system_prompt: "p",
    skills_snapshot: [],
    provider: "openai",
    model: "gpt-4.1",
    recall: 0.82,
    precision: 0.91,
    citation_accuracy: 0.95,
    traces_passed: 17,
    traces_total: 20,
    duration_ms: 1000,
    tokens_in: 10,
    tokens_out: 5,
    cost_usd: 0.23,
    error: null,
    ...over,
  }) as EvalBatchRecord;

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: messages, shell: shellMessages }}>
      <EvalDashboardView />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useEvalOverview.mockReset();
});

describe("EvalDashboardView", () => {
  it("lists every agent with its latest three metrics", () => {
    useEvalOverview.mockReturnValue({
      data: {
        agents: [
          { agent_id: "ag1", agent_name: "Security Reviewer", model: "gpt-4.1", cases_total: 10, latest: batch() },
        ],
        recent_runs: [batch()],
      },
      isLoading: false,
      isError: false,
    });
    renderView();
    // Once on the agent card, once on its recent-run row.
    expect(screen.getAllByText("Security Reviewer").length).toBe(2);
    expect(screen.getAllByText("82%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("91%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("95%").length).toBeGreaterThan(0);
  });

  it("says 'no evidence' for an agent that has never run, not 0%", () => {
    // An unmeasured agent and a failing one are different states; collapsing
    // them is how a regression dashboard starts lying.
    useEvalOverview.mockReturnValue({
      data: {
        agents: [
          { agent_id: "ag2", agent_name: "Custom Mentor", model: "gpt-4o-mini", cases_total: 3, latest: null },
        ],
        recent_runs: [],
      },
      isLoading: false,
      isError: false,
    });
    renderView();
    expect(screen.getAllByText("no evidence").length).toBe(3);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("names the agent on each recent-run row rather than showing a raw id", () => {
    useEvalOverview.mockReturnValue({
      data: {
        agents: [
          { agent_id: "ag1", agent_name: "Security Reviewer", model: null, cases_total: 10, latest: batch() },
        ],
        recent_runs: [batch({ id: "r1" })],
      },
      isLoading: false,
      isError: false,
    });
    renderView();
    expect(screen.getAllByText("Security Reviewer").length).toBe(2);
    expect(screen.queryByText("ag1")).not.toBeInTheDocument();
  });

  it("renders an empty state when nothing has ever run", () => {
    useEvalOverview.mockReturnValue({
      data: { agents: [], recent_runs: [] },
      isLoading: false,
      isError: false,
    });
    renderView();
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument();
  });
});

describe("EvalDashboardView helpers", () => {
  it("pct returns null for no evidence and a whole percent otherwise", () => {
    expect(pct(null)).toBeNull();
    expect(pct(undefined)).toBeNull();
    expect(pct(0)).toBe("0%");
    expect(pct(0.824)).toBe("82%");
  });

  it("recallTrend reverses the newest-first API order so the line reads forwards", () => {
    const newestFirst = [batch({ recall: 0.9 }), batch({ recall: 0.8 }), batch({ recall: 0.7 })];
    expect(recallTrend(newestFirst)).toEqual([0.7, 0.8, 0.9]);
  });

  it("recallTrend drops runs with no recall rather than plotting them as zero", () => {
    expect(recallTrend([batch({ recall: null }), batch({ recall: 0.5 })])).toEqual([0.5]);
  });

  it("runTime formats a run timestamp without seconds", () => {
    expect(runTime("2026-08-30T09:14:33.000Z")).toMatch(/^2026-08-30 \d{2}:\d{2}$/);
  });
});
