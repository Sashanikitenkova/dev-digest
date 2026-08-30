/* hooks/brief.ts — the Why + Risk brief card's data layer.

   GET returns `null` (not a 404) for a pull request that has never had a brief
   generated, so the card can render an empty state instead of an error — the
   same shape `hooks/intent.ts` uses.

   Both mutations return the CANONICAL stored record, so they write straight
   into the cache with `setQueryData` rather than invalidating: there is nothing
   left to re-fetch. Deliberately NO optimistic write — an optimistic brief
   would have to invent `counts`, `inputs` and provenance it cannot know, and it
   turns a latent server-side race into a reproducible one. The server coalesces
   concurrent generations for the same PR + head sha, so a double click is
   already harmless without help from here. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { PrRiskBriefRecord } from "../types";

/** Cache key for one PR's stored brief — shared by the query and both mutations. */
const briefKey = (prId: string | null | undefined) => ["pr-brief", prId];

export function usePrBrief(prId: string | null | undefined) {
  return useQuery({
    queryKey: briefKey(prId),
    queryFn: () => api.get<PrRiskBriefRecord | null>(`/pulls/${prId}/brief`),
    enabled: !!prId,
  });
}

/** Generate a brief for the PR's current head, reusing the stored one if fresh. */
export function useGenerateBrief(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrRiskBriefRecord>(`/pulls/${prId}/brief`),
    onSuccess: (data) => qc.setQueryData(briefKey(prId), data),
  });
}

/** Re-run the generation irrespective of the stored brief's head sha. */
export function useRegenerateBrief(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrRiskBriefRecord>(`/pulls/${prId}/brief/regenerate`),
    onSuccess: (data) => qc.setQueryData(briefKey(prId), data),
  });
}
