/* hooks/eval.ts — React Query hooks over the SPEC-03 eval pipeline API. */
"use client";

import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  EvalBatchDetail,
  EvalBatchRecord,
  EvalBatchStart,
  EvalCase,
  EvalCompare,
  EvalDashboard,
  EvalExpectation,
  EvalRunRecord,
} from "@devdigest/shared";

/** How often a running batch is re-read. Terminal batches stop polling. */
export const EVAL_POLL_MS = 2000;

export interface EvalCasesResponse {
  cases: EvalCase[];
  /** Newest result per case id — the "last result" column. */
  latest: Record<string, EvalRunRecord>;
}

export interface EvalOverview {
  agents: {
    agent_id: string;
    agent_name: string;
    model: string | null;
    cases_total: number;
    latest: EvalBatchRecord | null;
  }[];
  recent_runs: EvalBatchRecord[];
}

export function useEvalCases(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval", "cases", agentId],
    queryFn: () => api.get<EvalCasesResponse>(`/eval/cases?owner_id=${agentId}`),
    enabled: !!agentId,
  });
}

export function useEvalDashboard(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["eval", "dashboard", agentId],
    queryFn: () => api.get<EvalDashboard>(`/eval/dashboard?owner_id=${agentId}`),
    enabled: !!agentId,
  });
}

export function useEvalOverview() {
  return useQuery({
    queryKey: ["eval", "overview"],
    queryFn: () => api.get<EvalOverview>("/eval/overview"),
  });
}

export function useEvalRuns(agentId: string | null | undefined, limit = 20) {
  return useQuery({
    queryKey: ["eval", "runs", agentId, limit],
    queryFn: () => api.get<EvalBatchRecord[]>(`/eval/runs?owner_id=${agentId}&limit=${limit}`),
    enabled: !!agentId,
  });
}

/**
 * One batch, polled while it runs.
 *
 * The run is fire-and-forget on the server, so the only way to learn it finished
 * is to ask. `refetchInterval` returns false once the batch reaches a terminal
 * status, which stops the poll without needing a separate effect.
 *
 * Reaching a terminal status ALSO invalidates the sibling eval queries. Starting
 * a run cannot do that on its own: the POST resolves with 202 while the batch is
 * still queued, so an invalidation there refetches metrics that do not exist yet
 * and nothing refetches them once they do. Without this the tab shows a
 * "run finished" banner above four empty metric tiles and a case list still
 * reading "never run" — every number correct on the server and stale on screen.
 */
export function useEvalBatch(batchId: string | null | undefined) {
  const qc = useQueryClient();
  const settled = React.useRef<string | null>(null);

  const query = useQuery({
    queryKey: ["eval", "batch", batchId],
    queryFn: () => api.get<EvalBatchDetail>(`/eval/runs/${batchId}`),
    enabled: !!batchId,
    refetchInterval: (q) => (q.state.data?.batch.status === "running" ? EVAL_POLL_MS : false),
  });

  const status = query.data?.batch.status;
  React.useEffect(() => {
    if (!batchId || !status || status === "running") return;
    // Once per batch: the query keeps returning the terminal row on every
    // remount, and re-invalidating on each would loop.
    if (settled.current === batchId) return;
    settled.current = batchId;
    for (const key of ["cases", "dashboard", "runs", "overview"]) {
      qc.invalidateQueries({ queryKey: ["eval", key] });
    }
  }, [batchId, status, qc]);

  return query;
}

export function useEvalCompare(a: string | null, b: string | null) {
  return useQuery({
    queryKey: ["eval", "compare", a, b],
    queryFn: () => api.get<EvalCompare>(`/eval/compare?a=${a}&b=${b}`),
    enabled: !!a && !!b,
  });
}

/** Which of these findings already have an eval case — one call for a review. */
export function useFindingsWithCases(findingIds: string[]) {
  const key = [...findingIds].sort().join(",");
  return useQuery({
    queryKey: ["eval", "case-findings", key],
    queryFn: () =>
      api.get<{ finding_ids: string[] }>(`/eval/case-findings?ids=${encodeURIComponent(key)}`),
    enabled: findingIds.length > 0,
  });
}

/**
 * Freeze a reviewed finding into an eval case.
 *
 * Invalidates the case-findings probe as well as the case list so the finding's
 * button flips to its already-in-set state without a reload.
 */
export function useCreateEvalCaseFromFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) => api.post<EvalCase>(`/findings/${findingId}/eval-case`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["eval"] });
    },
  });
}

export interface CreateEvalCaseInput {
  owner_id: string;
  name: string;
  input_diff: string;
  expected_output: EvalExpectation;
  notes?: string | null;
}

export function useCreateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEvalCaseInput) => api.post<EvalCase>("/eval/cases", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }),
  });
}

export function useUpdateEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<CreateEvalCaseInput>) =>
      api.put<EvalCase>(`/eval/cases/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }),
  });
}

export function useDeleteEvalCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/eval/cases/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }),
  });
}

/** Start a batch. Resolves with the batch id as soon as it is queued (202). */
export function useStartEvalRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.post<EvalBatchStart>(`/agents/${agentId}/eval-runs`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval"] }),
  });
}
