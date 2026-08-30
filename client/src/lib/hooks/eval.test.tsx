import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EvalBatchDetail } from "@devdigest/shared";

const get = vi.fn();
vi.mock("../api", () => ({ api: { get: (p: string) => get(p) } }));

import { useEvalBatch } from "./eval";

const detail = (status: "running" | "done" | "failed"): EvalBatchDetail =>
  ({
    batch: {
      id: "b1",
      owner_kind: "agent",
      owner_id: "ag1",
      status,
      started_at: "2026-08-30T10:00:00.000Z",
      finished_at: status === "running" ? null : "2026-08-30T10:04:00.000Z",
      agent_version: 1,
      system_prompt: "p",
      skills_snapshot: [],
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      recall: status === "done" ? 1 : null,
      precision: status === "done" ? 0.5556 : null,
      citation_accuracy: status === "done" ? 1 : null,
      traces_passed: status === "done" ? 6 : 0,
      traces_total: 9,
      duration_ms: 221000,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0.005,
      error: null,
    },
    runs: [],
  }) as EvalBatchDetail;

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("useEvalBatch", () => {
  it("refreshes the metric and case queries once the batch finishes", async () => {
    // The regression this pins: starting a run can only invalidate on the 202,
    // which lands while the batch is still queued. Without a second invalidation
    // on completion the tab renders "Run finished — 6 of 9 passed" above four
    // empty metric tiles and a case list still reading "never run".
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    get.mockResolvedValue(detail("done"));

    const { result } = renderHook(() => useEvalBatch("b1"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.batch.status).toBe("done"));

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["eval", "dashboard"]));
    expect(keys).toContain(JSON.stringify(["eval", "cases"]));
    expect(keys).toContain(JSON.stringify(["eval", "runs"]));
  });

  it("does not refresh anything while the batch is still running", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    get.mockResolvedValue(detail("running"));

    const { result } = renderHook(() => useEvalBatch("b1"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.batch.status).toBe("running"));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates once per batch, not on every poll of a finished one", async () => {
    // The terminal row keeps coming back on every refetch; re-invalidating on
    // each would spin the sibling queries forever.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    get.mockResolvedValue(detail("done"));

    const { result, rerender } = renderHook(() => useEvalBatch("b1"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.batch.status).toBe("done"));

    const invalidate = vi.spyOn(qc, "invalidateQueries");
    rerender();
    rerender();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("makes no request until a batch has actually been started", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useEvalBatch(null), { wrapper: wrapper(qc) });
    expect(get).not.toHaveBeenCalled();
  });
});
