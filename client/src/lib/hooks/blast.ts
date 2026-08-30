/* hooks/blast.ts — the Blast Radius panel's data layer.

   Deterministic and read-only on the server (index lookups plus one SQL join),
   so unlike intent there is no detect mutation and nothing to invalidate: the
   answer changes only when the PR's files or the repo index change. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { BlastRadius, PrHistoryItem } from "@devdigest/shared";

export interface PrBlast {
  blast: BlastRadius;
  history: PrHistoryItem[];
}

/** GET /pulls/:id/blast → what the PR's changed symbols reach. */
export function usePrBlast(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-blast", prId],
    queryFn: () => api.get<PrBlast>(`/pulls/${prId}/blast`),
    enabled: !!prId,
  });
}
