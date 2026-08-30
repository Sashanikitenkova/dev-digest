import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunTrace } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/runs.json"; // apps/web/messages/en/runs.json

// Mock the trace hooks so the drawer renders without a query client / SSE.
const TRACE: RunTrace = {
  config: { agent: "Security", version: "1", provider: "openai", model: "gpt-4.1", pr: 482, source: "local" },
  stats: { duration_ms: 8200, tokens_in: 12000, tokens_out: 1500, cost_usd: 0.06, findings: 2, grounding: "2/2 passed" },
  prompt_assembly: { system: "You are a reviewer.", skills: "### skill", memory: null, specs: null, user: "Review PR #482" },
  tool_calls: [{ tool: "review_file", args: "src/config.ts", meta: "single-pass", ms: 1200 }],
  raw_output: '{"verdict":"request_changes"}',
  memory_pulled: [{ pr: 471, text: "rate-limit public endpoints" }],
  specs_read: [],
  log: [
    { t: "00.10", kind: "info", msg: "Starting review with agent Security" },
    { t: "00.90", kind: "result", msg: "Citation grounding: 2/2 passed" },
  ],
};

// `useRunTrace` is a vi.fn() (default returns TRACE) so later describe blocks
// can swap in a different fixture — the ORIGINAL smoke tests below still get
// the same TRACE they always did.
const useRunTrace = vi.fn();
vi.mock("../../../../../../../lib/hooks/trace", () => ({
  useRunTrace: (...args: unknown[]) => useRunTrace(...args),
}));
vi.mock("../../../../../../../lib/hooks/reviews", () => ({
  useRunEvents: () => ({ events: [], running: false }),
}));

import RunTraceDrawer from "./RunTraceDrawer";

beforeEach(() => {
  useRunTrace.mockReturnValue({ data: TRACE, isLoading: false });
});
afterEach(() => {
  cleanup();
  useRunTrace.mockReset();
});

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ runs: messages }}>
      <div data-theme="dark">{ui}</div>
    </NextIntlClientProvider>,
  );
}

describe("A5 Run Trace drawer (smoke)", () => {
  it("renders the trace tabs and stats", () => {
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Stats")).toBeInTheDocument();
    expect(screen.getByText("2/2 passed")).toBeInTheDocument();
    expect(screen.getByText("$0.060")).toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
  });

  it("switches to the live log tab", () => {
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    fireEvent.click(screen.getByText("log"));
    // LiveLogStream renders its filter input
    expect(screen.getByPlaceholderText("Filter log…")).toBeInTheDocument();
  });
});

describe("A5 Run Trace drawer — Specs read (SPEC-01, AC-23/AC-25)", () => {
  const TRACE_WITH_SPECS: RunTrace = {
    ...TRACE,
    specs_read: ["docs/architecture.md"],
    specs_detail: [
      { path: "docs/architecture.md", status: "used", reason: null, tokens: 42 },
      { path: "docs/vanished.md", status: "missing", reason: "not_in_clone", tokens: 0 },
    ],
    specs_tokens: 42,
  };

  it("renders the used documents' paths, derived from the ledger", () => {
    useRunTrace.mockReturnValue({ data: TRACE_WITH_SPECS, isLoading: false });
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();
  });

  it("renders a missing document WITH its reason inline, never hidden", () => {
    useRunTrace.mockReturnValue({ data: TRACE_WITH_SPECS, isLoading: false });
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("docs/vanished.md")).toBeInTheDocument();
    expect(screen.getByText(/not_in_clone/)).toBeInTheDocument();
  });

  it("renders 'none' when there is no used document and no missing one", () => {
    useRunTrace.mockReturnValue({
      data: { ...TRACE, specs_read: [], specs_detail: [], specs_tokens: 0 },
      isLoading: false,
    });
    renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />);
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("still renders without throwing when specs_detail is absent (a trace persisted before SPEC-01)", () => {
    // TRACE itself has no specs_detail/specs_tokens key at all — the drawer's
    // default fixture — so this pins that a historical trace document (frozen
    // jsonb, never re-derived) does not crash the drawer.
    useRunTrace.mockReturnValue({ data: TRACE, isLoading: false });
    expect(() =>
      renderWithIntl(<RunTraceDrawer runId="r1" agentName="Security" prNumber={482} onClose={() => {}} />),
    ).not.toThrow();
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});
