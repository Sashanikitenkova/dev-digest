/* hooks/skills.ts — React Query hooks for the Skills list, Skill editor and
   the import drawer. Modelled on hooks/agents.ts: one hook per API operation,
   all on top of lib/api.ts.

   Note on import: `POST /skills/import/preview` is a PURE parse — it persists
   nothing. Saving is a separate `useCreateSkill()` call the drawer only makes
   once the user confirms. That split is what makes "nothing is stored until
   you press Import" true by construction rather than by discipline. */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Skill, SkillImportPreview, SkillSource, SkillType } from "@devdigest/shared";

/** One immutable body snapshot from `GET /skills/:id/versions` (newest first). */
export interface SkillVersionRecord {
  skill_id: string;
  version: number;
  body: string;
  created_at: string;
}

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => api.get<Skill[]>("/skills"),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: ["skill", id],
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    enabled: !!id,
  });
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  type?: SkillType;
  source?: SkillSource;
  body: string;
  enabled?: boolean;
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.setQueryData(["skill", data.id], data);
    },
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: Partial<Pick<Skill, "name" | "description" | "type" | "body" | "enabled">>;
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSkillInput) => api.put<Skill>(`/skills/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.setQueryData(["skill", data.id], data);
      // A changed body writes a new immutable snapshot server-side.
      qc.invalidateQueries({ queryKey: ["skill-versions", data.id] });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    // DELETE /skills/:id answers 204 — apiFetch resolves undefined.
    mutationFn: (id: string) => api.del<void>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.removeQueries({ queryKey: ["skill", id] });
      qc.removeQueries({ queryKey: ["skill-versions", id] });
    },
  });
}

/** Body snapshots for the Versions tab — server returns newest first. */
export function useSkillVersions(id: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-versions", id],
    queryFn: () => api.get<SkillVersionRecord[]>(`/skills/${id}/versions`),
    enabled: !!id,
  });
}

export interface ImportSkillPreviewInput {
  filename: string;
  /** Base64 of the raw file bytes — JSON body, deliberately not multipart. */
  content_base64: string;
}

/**
 * Parse-only import preview. Persists NOTHING: the response is rendered in the
 * drawer (including the server-generated `skipped_files` list) and only a
 * subsequent `useCreateSkill()` call writes a row.
 */
export function useImportSkillPreview() {
  return useMutation({
    mutationFn: (input: ImportSkillPreviewInput) =>
      api.post<SkillImportPreview>("/skills/import/preview", input),
  });
}
