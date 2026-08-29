/* hooks/reviews.ts — React Query + SSE hooks for the A2 reviewer.
   Run a review, stream RunEvents live, act on findings. */
"use client";

import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { createRunEventsSource } from "../services/runEventsSource";
import { activeRunsPollInterval, runsPollInterval } from "../services/pollingPolicy";
import type {
  FindingActionKind,
  PrReviewComment,
  ReviewRecord,
  ReviewRunResponse,
  RunEvent,
  RunSummary,
} from "@devdigest/shared";

// ---- Active (in-flight) runs — server-side source of truth ----
export interface ActiveRun {
  run_id: string;
  agent_id: string | null;
  agent_name: string | null;
  ran_at: string | null;
}

/** In-flight runs for a PR, from the server (agent_runs where status='running').
   Survives reloads/devices; polls while anything is running so it self-clears. */
export function usePrActiveRuns(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-active-runs", prId],
    queryFn: () => api.get<ActiveRun[]>(`/pulls/${prId}/runs/active`),
    enabled: !!prId,
    refetchInterval: (query) => activeRunsPollInterval(query.state.data),
  });
}

// ---- Full run history for a PR (every agent_runs row, any status) ----
/** All runs for a PR — done, failed (with error), cancelled, running. Survives
   reload (DB-backed). Polls while anything is running so it self-updates. */
export function usePrRuns(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-runs", prId],
    queryFn: () => api.get<RunSummary[]>(`/pulls/${prId}/runs`),
    enabled: !!prId,
    refetchInterval: (query) => runsPollInterval(query.state.data),
  });
}

// ---- Persisted reviews + findings for a PR ----
export function usePrReviews(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["reviews", prId],
    queryFn: () => api.get<ReviewRecord[]>(`/pulls/${prId}/reviews`),
    enabled: !!prId,
  });
}

/** Delete one run from the PR's run history (+ its trace). */
export function useDeleteRun(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.del<{ ok: boolean }>(`/runs/${runId}`),
    // Deleting a run also deletes the review it produced (server-side), so drop
    // both the timeline and the Review Runs list from cache.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pr-runs", prId] });
      qc.invalidateQueries({ queryKey: ["reviews", prId] });
    },
  });
}

/** Request cancellation of an in-flight run (takes effect at the next step). */
export function useCancelRun() {
  return useMutation({
    mutationFn: (runId: string) => api.post<{ ok: boolean }>(`/runs/${runId}/cancel`),
  });
}

/** Delete a whole review run (one agent's pass) + its findings. */
export function useDeleteReview(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) => api.del<{ ok: boolean }>(`/reviews/${reviewId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reviews", prId] }),
  });
}

// ---- Inline review comments on the "Files changed" tab (proxied to GitHub) --
/** Existing GitHub PR review comments, fetched live. */
export function usePrComments(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-comments", prId],
    queryFn: () => api.get<PrReviewComment[]>(`/pulls/${prId}/comments`),
    enabled: !!prId,
  });
}

export interface CreateCommentInput {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  in_reply_to?: number;
}

/** Post one inline comment (or reply) to GitHub; refreshes the thread list. */
export function useCreatePrComment(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCommentInput) =>
      api.post<PrReviewComment>(`/pulls/${prId}/comments`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-comments", prId] }),
  });
}

// ---- Run a review (all enabled agents or a specific agent) ----
export interface RunReviewInput {
  prId: string;
  agentId?: string;
  all?: boolean;
}

export function useRunReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, agentId, all }: RunReviewInput) =>
      api.post<ReviewRunResponse>(`/pulls/${prId}/review`, {
        ...(agentId ? { agentId } : {}),
        ...(all ? { all } : {}),
      }),
    onSuccess: (_d, { prId }) => {
      qc.invalidateQueries({ queryKey: ["reviews", prId] });
    },
  });
}

// ---- Finding actions (accept/dismiss) ----
export function useFindingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      findingId,
      action,
      reply,
      prId: _prId,
    }: {
      findingId: string;
      action: FindingActionKind;
      reply?: string;
      prId?: string;
    }) =>
      api.post<{ finding: ReviewRecord["findings"][number]; memoryId?: string }>(
        `/findings/${findingId}/${action}`,
        reply ? { reply } : undefined,
      ),
    onSuccess: (_d, { prId }) => {
      if (prId) qc.invalidateQueries({ queryKey: ["reviews", prId] });
    },
  });
}

/**
 * Subscribe to a run's SSE event stream. Returns the accumulated RunEvents and a
 * `running` flag (true until the stream closes). Live status for the
 * RunReviewDropdown / Live Log. Multiple runIds are subscribed in parallel.
 */
export function useRunEvents(runIds: string[]) {
  const [events, setEvents] = React.useState<RunEvent[]>([]);
  const [running, setRunning] = React.useState(false);
  const key = runIds.join(",");

  React.useEffect(() => {
    if (runIds.length === 0) return;
    setEvents([]);
    setRunning(true);

    const unsubscribe = createRunEventsSource(runIds, {
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onAllClosed: () => setRunning(false),
    });

    return () => {
      unsubscribe();
      setRunning(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { events, running };
}
