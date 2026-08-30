"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { routes } from "@/lib/routes";
import { type PrMeta } from "./constants";

const DEFAULT_STATUS = "needs_review";
const DEFAULT_SORT = "newest";

/**
 * URL-backed status/search/sort state for the PR list (?status, ?q, ?sort),
 * plus the filtered+sorted result. Keeping all three in the URL — not just
 * status — means a search or sort choice survives a refresh and is
 * shareable via link, matching how ?tab/?trace already work on the PR
 * detail page.
 */
export function usePrListFilters(repoId: string, pulls: PrMeta[] | undefined) {
  const search = useSearchParams();
  const router = useRouter();

  const status = search.get("status") ?? DEFAULT_STATUS;
  const query = search.get("q") ?? "";
  const sort = search.get("sort") ?? DEFAULT_SORT;

  const setSearchParam = (key: string, val: string | null) => {
    const sp = new URLSearchParams(search.toString());
    if (val == null || val === "") sp.delete(key);
    else sp.set(key, val);
    router.replace(`${routes.pulls(repoId)}?${sp.toString()}`);
  };

  const setStatus = (k: string) => {
    const sp = new URLSearchParams(search.toString());
    sp.set("status", k); // always explicit so "all" sticks over the needs_review default
    router.replace(`${routes.pulls(repoId)}?${sp.toString()}`);
  };
  const setQuery = (v: string) => setSearchParam("q", v || null);
  const setSort = (v: string) => setSearchParam("sort", v === DEFAULT_SORT ? null : v);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      (pulls ?? [])
        .filter((p) => status === "all" || p.status === status)
        .filter((p) => !q || p.title.toLowerCase().includes(q) || String(p.number).includes(q))
        .slice()
        .sort((a, b) => {
          const ta = Date.parse(a.updated_at ?? "") || 0;
          const tb = Date.parse(b.updated_at ?? "") || 0;
          return sort === "oldest" ? ta - tb : tb - ta;
        }),
    [pulls, status, q, sort],
  );

  return { status, setStatus, query, setQuery, sort, setSort, filtered };
}
