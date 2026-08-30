/* hooks/conventions.ts — React Query hooks for the Conventions triage page.
   Modelled on hooks/skills.ts: one hook per API operation, all on lib/api.ts.

   Extraction is a POST that returns the full run summary (proposed/kept/
   dropped) rather than just the surviving rows. The drop count is deliberately
   surfaced: a run where the model proposed eight rules and every one failed
   evidence validation must not render as an empty-but-successful scan. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ConventionCandidate,
  ConventionExtractResult,
  ConventionStatus,
} from "@devdigest/shared";

export function useConventions(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["conventions", repoId],
    queryFn: () => api.get<ConventionCandidate[]>(`/repos/${repoId}/conventions`),
    enabled: !!repoId,
  });
}

/** Run the extractor. Writes the returned candidates straight into the cache. */
export function useExtractConventions(repoId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<ConventionExtractResult>(`/repos/${repoId}/conventions/extract`),
    onSuccess: (data) => {
      qc.setQueryData(["conventions", repoId], data.candidates);
    },
  });
}

/** Accept / reject one candidate. */
export function useSetConventionStatus(repoId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ConventionStatus }) =>
      api.patch<ConventionCandidate>(`/conventions/${id}`, { status }),
    onSuccess: (updated) => {
      // Patch the row in place: re-fetching would reorder nothing but still
      // flash the list while the user is mid-triage.
      qc.setQueryData<ConventionCandidate[]>(["conventions", repoId], (prev) =>
        prev?.map((c) => (c.id === updated.id ? updated : c)),
      );
    },
  });
}
