/* hooks/intent.ts — the PR Intent card's data layer.

   GET returns `null` (not a 404) for a PR that has never been classified, so
   the card can render an empty state instead of an error. The detect mutation
   returns the canonical record, so it writes straight into the cache rather
   than invalidating — there is nothing left to re-fetch. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { PrIntentRecord } from "../types";

export function usePrIntent(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-intent", prId],
    queryFn: () => api.get<PrIntentRecord | null>(`/pulls/${prId}/intent`),
    enabled: !!prId,
  });
}

/** Re-run the classifier against the PR's current head. */
export function useDetectIntent(prId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PrIntentRecord>(`/pulls/${prId}/intent/detect`),
    onSuccess: (data) => qc.setQueryData(["pr-intent", prId], data),
  });
}
