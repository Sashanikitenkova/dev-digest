/* ContextTab — the skill editor's Project context tab (SPEC-01).

   Same shared picker as the agent editor, different ownership: documents
   attached HERE travel with the skill, so every agent linking it inherits them.
   The caption says so, because that inheritance is the whole reason to attach a
   document to a skill rather than to one agent. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Skill } from "@devdigest/shared";
import { ContextFilesPicker } from "../../../../../../../components/ContextFilesPicker";
import { ApiError } from "../../../../../../../lib/api";
import { useActiveRepo } from "../../../../../../../lib/repo-context";
import {
  useContextFiles,
  useSetSkillContext,
  useSkillContext,
} from "../../../../../../../lib/hooks/context";

/**
 * Stable empty array for the not-yet-loaded case.
 *
 * `attached?.paths ?? []` looks harmless and is not: while the query is
 * pending it hands the picker a BRAND NEW array on every render, which used to
 * make the picker's render-phase sync fire forever and the whole tab render
 * nothing. The picker no longer depends on prop identity, but a per-render
 * literal is still pointless churn through its memos.
 */
/**
 * The real reason a save failed, not a euphemism for one.
 *
 * `ApiError` already carries the status and the server's own message — including
 * "Cannot reach the DevDigest engine…" for a dead API. Collapsing all of that
 * into one fixed sentence meant a 404, a 422 and an unreachable server were
 * indistinguishable on screen, which is exactly the situation where a user
 * needs to know which one it is. The generic string stays as the fallback for a
 * throw that is not an ApiError.
 */
function saveErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.status > 0 ? `${fallback}: ${err.message} (HTTP ${err.status})` : err.message;
  }
  return fallback;
}

const EMPTY: string[] = [];

export function ContextTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const { repoId } = useActiveRepo();
  const {
    data: listing,
    isLoading: listingLoading,
    isError: listingFailed,
    refetch: refetchListing,
  } = useContextFiles(repoId);
  const { data: attached, isError } = useSkillContext(skill.id);
  const setContext = useSetSkillContext();

  return (
    <ContextFilesPicker
      repoId={repoId}
      attached={attached?.paths ?? EMPTY}
      documents={listing}
      isLoading={listingLoading}
      listingError={listingFailed}
      onRetry={() => void refetchListing()}
      onChange={(paths) => setContext.mutate({ skillId: skill.id, paths })}
      owner={{ kind: "skill", id: skill.id }}
      title={t("contextTab.heading")}
      note={t("contextTab.caption")}
      errorText={
        isError
          ? t("contextTab.loadError")
          : setContext.isError
            ? saveErrorText(setContext.error, t("contextTab.saveError"))
            : null
      }
    />
  );
}
