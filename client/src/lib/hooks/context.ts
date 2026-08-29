/* hooks/context.ts — project-context documents (SPEC-01).

   Discovery is a live walk on the server, so there is no reindex mutation and
   nothing to invalidate on a timer; the listing is refetched like any other
   query.

   The two attachment writes go through ONE shared writer, and it has three
   jobs beyond "send a PUT".

   OPTIMISTIC, not `onSuccess`-`setQueryData`. A PUT here replaces the whole
   ordered set. Writing the SERVER's echo on success made the cache reflect
   whichever response landed last, so a slow first PUT could overwrite a fast
   second one and the checkbox visibly flipped back. Writing the SUBMITTED set
   at click time makes the cache track the user's intent, which is the only
   ordering that is actually correct; the request is then just persistence.

   DEBOUNCED, because one PUT per checkbox is how the editor earned an HTTP 429.
   The API carries a single global per-IP rate limit and the studio is one IP,
   with pollers spending most of the budget before the user clicks anything —
   so a handful of quick ticks was enough to be refused, and a refused write
   rolls back, which looks exactly like a checkbox that will not stay ticked.
   Coalescing a burst into one request is safe precisely BECAUSE the endpoint
   is a whole-set replace: last write wins by construction. The debounce is
   about the network only — the cache is still written on the click itself, so
   the UI never lags the pointer.

   RETRIED on 429/5xx, and RE-READ when a write finally fails. A transient
   rejection must not silently discard the user's change, and a rollback is
   only a GUESS about what the server holds — so the owner's attachment key is
   invalidated on the error path. Note this is the opposite of the success
   path, where invalidating that key is exactly how a stale response used to
   win: there, an optimistic value is the truth we are protecting; here there
   is nothing optimistic left to protect and the alternative is a list that
   lies about what is stored. */
"use client";

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import type {
  ContextListing,
  ContextSerializationPreview,
  SpecFileContent,
} from "@devdigest/shared";

/** `{ paths }` — the shape both attachment endpoints return. */
export interface ContextAttachments {
  paths: string[];
}

export function useContextFiles(repoId: string | null | undefined) {
  return useQuery({
    queryKey: ["context", repoId],
    queryFn: () => api.get<ContextListing>(`/repos/${repoId}/context`),
    enabled: !!repoId,
  });
}

/** One document's body, fetched only when a preview is actually open. */
export function useContextFile(repoId: string | null | undefined, path: string | null) {
  return useQuery({
    queryKey: ["context-file", repoId, path],
    queryFn: () =>
      api.get<SpecFileContent>(
        `/repos/${repoId}/context/file?path=${encodeURIComponent(path ?? "")}`,
      ),
    enabled: !!repoId && !!path,
  });
}

export function useAgentContext(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-context", agentId],
    queryFn: () => api.get<ContextAttachments>(`/agents/${agentId}/context`),
    enabled: !!agentId,
  });
}

export function useSkillContext(skillId: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-context", skillId],
    queryFn: () => api.get<ContextAttachments>(`/skills/${skillId}/context`),
    enabled: !!skillId,
  });
}

type OwnerKind = "agent" | "skill";

/**
 * What an owner's attachments serialize to — the `SERIALIZES AS` panel.
 *
 * SERVER-rendered on purpose. The block's heading and delimiters come from
 * reviewer-core's `formatSpecSection`, which the client cannot import (it is a
 * server-only tsconfig path alias). Rebuilding the format here would put a
 * second spelling of the prompt in the codebase, and this exact panel has
 * already drifted once on paper — SPEC-01's design review caught mockup 4
 * promising `## Project specifications`.
 */
export function useContextPreview(
  kind: OwnerKind,
  ownerId: string | null | undefined,
  repoId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["context-preview", kind, ownerId, repoId],
    queryFn: () =>
      api.get<ContextSerializationPreview>(
        `/${kind}s/${ownerId}/context/preview?repo=${encodeURIComponent(repoId ?? "")}`,
      ),
    enabled: !!ownerId && !!repoId,
  });
}

// ------------------------------------------------------------------ writes

const CACHE_KEY: Record<OwnerKind, string> = {
  agent: "agent-context",
  skill: "skill-context",
};

const ENDPOINT: Record<OwnerKind, (ownerId: string) => string> = {
  agent: (id) => `/agents/${id}/context`,
  skill: (id) => `/skills/${id}/context`,
};

/** How long a burst of clicks keeps coalescing into the same pending write. */
const WRITE_DEBOUNCE_MS = 400;
/** Attempts AFTER the first one, for a transient failure. */
const MAX_RETRIES = 2;
/** A 429 can advertise a long wait; wait, but not unboundedly. */
const MAX_BACKOFF_MS = 20_000;

/**
 * Worth another attempt, or the user's problem to see?
 *
 * Same rule the server's own outbound calls use
 * (`server/src/platform/resilience.ts`) — a rate limit or a 5xx is the
 * infrastructure being busy, while a 404/422 says the request itself is wrong
 * and will be just as wrong next time.
 */
function isTransient(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.status >= 500);
}

/**
 * Prefer the delay the SERVER asked for over a number we invented.
 *
 * The API puts the rate limiter's `retry-after` seconds in `error.details`, so
 * a 429 that says "retry in 15 seconds" is waited out properly instead of
 * being retried twice into the same closed door.
 */
function backoffMs(err: unknown, failureCount: number): number {
  const details =
    err instanceof ApiError ? (err.details as { retryAfter?: unknown } | undefined) : undefined;
  const advertised =
    typeof details?.retryAfter === "number" && details.retryAfter > 0
      ? details.retryAfter * 1000
      : null;
  return Math.min(advertised ?? 1000 * 2 ** (failureCount - 1), MAX_BACKOFF_MS);
}

interface WriteVars {
  ownerId: string;
  paths: string[];
  /** The stored set from BEFORE this burst — what a failed write rolls back to. */
  baseline: ContextAttachments | undefined;
}

/** What both `useSetAgentContext` and `useSetSkillContext` expose. */
interface ContextWriter {
  set: (ownerId: string, paths: string[]) => void;
  isError: boolean;
  error: unknown;
  isPending: boolean;
}

function useContextWriter(kind: OwnerKind): ContextWriter {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ ownerId, paths }: WriteVars) =>
      api.put<ContextAttachments>(ENDPOINT[kind](ownerId), { paths }),
    // Scoped per owner kind so React Query runs these SERIALLY, in call order.
    // Unscoped, overlapping PUTs raced each other, and `replace` is a
    // delete-then-insert: two interleaving used to collide on the (owner, path)
    // primary key and 500. The server now locks the owner row, which is the
    // real fix; queueing here means the last write is deterministically the one
    // that lands.
    scope: { id: CACHE_KEY[kind] },
    retry: (failureCount, error) => failureCount <= MAX_RETRIES && isTransient(error),
    retryDelay: (failureCount, error) => backoffMs(error, failureCount),
    onError: (_err, { ownerId, baseline }) => {
      const key = [CACHE_KEY[kind], ownerId];
      if (baseline) qc.setQueryData<ContextAttachments>(key, baseline);
      // Only reached once the retries are spent, so `isError` — and the red
      // line in the editor — never flashes for a 429 that healed itself.
      void qc.invalidateQueries({ queryKey: key });
    },
    onSettled: (_data, _err, { ownerId }) => {
      // The listing carries a per-document "used by N agents" count that an
      // AGENT write changes. A skill's set cannot move it — that count is
      // direct agent attachments only
      // (server/src/modules/context/repository.ts:countAgentAttachmentsByPath).
      if (kind === "agent") void qc.invalidateQueries({ queryKey: ["context"] });
      // The serialization panel is derived from what the SERVER stores, so it
      // refreshes once a write lands rather than tracking the optimistic set.
      // Invalidating THIS key is safe in a way invalidating the attachment key
      // is not — nothing optimistic is riding on it (see the header note).
      void qc.invalidateQueries({ queryKey: ["context-preview", kind, ownerId] });
    },
  });

  const { mutate } = mutation;
  const pending = React.useRef<WriteVars | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = React.useRef(0);

  const flush = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (next) mutate(next);
  }, [mutate]);

  // Leaving the tab must not drop a change that so far exists only in the
  // cache — an author who ticks a box and immediately navigates away has still
  // made the change.
  const flushRef = React.useRef(flush);
  flushRef.current = flush;
  React.useEffect(() => () => flushRef.current(), []);

  const set = React.useCallback(
    (ownerId: string, paths: string[]) => {
      // A different owner mid-burst: send what we have rather than retarget it.
      if (pending.current && pending.current.ownerId !== ownerId) flush();

      const key = [CACHE_KEY[kind], ownerId];
      // The baseline is the set from before the BURST, not before this click —
      // rolling a failed burst back to its own optimistic value would restore
      // exactly the state that was never saved.
      const baseline = pending.current?.baseline ?? qc.getQueryData<ContextAttachments>(key);

      const mine = ++seq.current;
      qc.setQueryData<ContextAttachments>(key, { paths });
      // A read already on the wire would otherwise land after this write and
      // silently undo it. `cancelQueries` can itself revert the query, so
      // re-assert once it settles — unless a newer click has since won.
      void qc.cancelQueries({ queryKey: key }).then(() => {
        if (seq.current === mine) qc.setQueryData<ContextAttachments>(key, { paths });
      });

      pending.current = { ownerId, paths, baseline };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, WRITE_DEBOUNCE_MS);
    },
    [flush, kind, qc],
  );

  return { set, isError: mutation.isError, error: mutation.error, isPending: mutation.isPending };
}

export function useSetAgentContext() {
  const writer = useContextWriter("agent");
  return {
    mutate: ({ agentId, paths }: { agentId: string; paths: string[] }) =>
      writer.set(agentId, paths),
    isError: writer.isError,
    error: writer.error,
    isPending: writer.isPending,
  };
}

export function useSetSkillContext() {
  const writer = useContextWriter("skill");
  return {
    mutate: ({ skillId, paths }: { skillId: string; paths: string[] }) =>
      writer.set(skillId, paths),
    isError: writer.isError,
    error: writer.error,
    isPending: writer.isPending,
  };
}
