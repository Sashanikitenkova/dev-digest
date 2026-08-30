/* ContextTab — the agent editor's Project context tab (SPEC-01).

   Thin wrapper over the shared ContextFilesPicker: it owns the two data hooks
   and the repo the documents are discovered from, and nothing else. The picker
   itself is shared with the skill editor, so any interaction change lands in
   both places at once. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Agent } from "@devdigest/shared";
import { ContextFilesPicker } from "../../../../../../../components/ContextFilesPicker";
import { ApiError } from "../../../../../../../lib/api";
import { useActiveRepo } from "../../../../../../../lib/repo-context";
import {
  useAgentContext,
  useContextFiles,
  useSetAgentContext,
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

export function ContextTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  // Documents are discovered from the ACTIVE repo, the same way the global
  // Conventions page picks one — an attachment is stored by path and is not
  // scoped to a repo, so the repo here only decides what the picker can offer.
  const { repoId } = useActiveRepo();
  const {
    data: listing,
    isLoading: listingLoading,
    isError: listingFailed,
    refetch: refetchListing,
  } = useContextFiles(repoId);
  const { data: attached, isError } = useAgentContext(agent.id);
  const setContext = useSetAgentContext();

  return (
    <ContextFilesPicker
      repoId={repoId}
      attached={attached?.paths ?? EMPTY}
      documents={listing}
      isLoading={listingLoading}
      listingError={listingFailed}
      onRetry={() => void refetchListing()}
      onChange={(paths) => setContext.mutate({ agentId: agent.id, paths })}
      owner={{ kind: "agent", id: agent.id }}
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
