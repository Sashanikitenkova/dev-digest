/* hooks/smart-diff.ts — the Smart Diff (reviewer-ordered diff) data layer.

   Deterministic and read-only on the server (a path classifier over rows that
   are already imported), so there is no mutation and nothing to invalidate: the
   answer changes only when the PR's files or its latest review change. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SmartDiff } from "@devdigest/shared";

/** GET /pulls/:id/smart-diff → changed files grouped into core/wiring/boilerplate. */
export function usePrSmartDiff(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["pr-smart-diff", prId],
    queryFn: () => api.get<SmartDiff>(`/pulls/${prId}/smart-diff`),
    enabled: !!prId,
  });
}
