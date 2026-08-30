/* hooks/risks.ts — the Intent card's RISK AREAS row.

   Deterministic server-side scan of the PR's changed files, so there is no
   detect step and nothing to invalidate: the result changes only when the PR's
   files do. Kept as its own query rather than folded into `usePrIntent` so a
   PR with no detected intent still has its risks available. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Risks } from "@devdigest/shared";

/** GET /pulls/:id/risks → risk areas derived from the diff. */
export function usePrRisks(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-risks", prId],
    queryFn: () => api.get<Risks>(`/pulls/${prId}/risks`),
    enabled: !!prId,
  });
}
