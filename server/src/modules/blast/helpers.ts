import type {
  AffectedEndpoint,
  BlastIndexInfo,
  BlastRadius,
  DownstreamImpact,
  PrHistoryItem,
} from '@devdigest/shared';
import type { BlastResult, IndexState } from '../repo-intel/types.js';
import type { PriorPrRow } from './repository.js';
import { MAX_CALLERS_PER_SYMBOL } from './constants.js';

/**
 * Map the repo-intel facade's internal `BlastResult` onto the public
 * `BlastRadius` contract.
 *
 * The interesting part is endpoint/cron attribution, which now has TWO grounded
 * sources and unions them per symbol:
 *
 *   1. CALLER evidence — a caller of the symbol lives in a file whose
 *      `file_facts` declare the endpoint. Strongest link: that file names the
 *      symbol directly.
 *   2. REVERSE-GRAPH evidence — a file declaring the endpoint transitively
 *      imports the file declaring the symbol, within `BFS_DEPTH` hops
 *      (`reachedFiles`). Weaker, but still a claim the index actually made: the
 *      endpoint's module depends on the changed module.
 *
 * Each attributed endpoint carries the HOP DISTANCE of the evidence behind it,
 * and an endpoint reachable both ways keeps the shallower one. Depth matters
 * because a two-hop claim is true but nearly content-free in a repo with a
 * barrel file: every module reaches the app root in two hops, so `app.ts`'s own
 * endpoints would otherwise be attributed to every change in the codebase.
 * Reporting the distance lets the reader rank; discarding the far edges instead
 * would lose real impact in repos that have no barrel.
 *
 * What is NOT done is smearing the flat `impactedEndpoints` union across every
 * symbol when neither kind of evidence exists — that would read as "all 3
 * endpoints hit all 2 symbols", a claim nothing in the index supports. When the
 * graph is absent (a partial index that skipped the T3 block) per-symbol lists
 * stay empty and the flat union is reported at the top level. Under-claiming is
 * the correct failure here: the whole panel exists to tell a reviewer what a
 * change actually reaches, and the `index` field says why the answer is thin.
 */
export function toBlastRadius(result: BlastResult, state?: IndexState): BlastRadius {
  const facts = result.factsByFile;
  const reached = result.reachedFiles;

  // Which changed files does each reached file depend on? Inverted once here
  // rather than re-scanned per symbol.
  const dependentsOf = new Map<string, string[]>();
  if (reached) {
    for (const [path, row] of Object.entries(reached)) {
      const arr = dependentsOf.get(row.fromFile);
      if (arr) arr.push(path);
      else dependentsOf.set(row.fromFile, [path]);
    }
  }

  const downstream: DownstreamImpact[] = result.changedSymbols.map((sym) => {
    const callers = result.callers.filter((c) => c.viaSymbol === sym.name);
    const endpoints = new Map<string, number>();
    const crons = new Map<string, number>();

    if (facts) {
      /** Keep the strongest (shallowest) evidence for each name. */
      const record = (into: Map<string, number>, name: string, depth: number) => {
        const seen = into.get(name);
        if (seen === undefined || depth < seen) into.set(name, depth);
      };
      const fromFile = (file: string, depth: number) => {
        for (const e of facts[file]?.endpoints ?? []) record(endpoints, e, depth);
        for (const cr of facts[file]?.crons ?? []) record(crons, cr, depth);
      };

      // A file that CALLS the symbol is direct evidence, hop 1 by definition.
      for (const c of callers) fromFile(c.file, 1);
      // A file that merely imports the declaring file carries its walk depth.
      for (const file of dependentsOf.get(sym.file) ?? []) {
        fromFile(file, reached?.[file]?.depth ?? 1);
      }
    }

    return {
      symbol: sym.name,
      // Highest-ranked callers first: on a wide fan-out the truncated tail is
      // the part nobody would have read anyway.
      callers: [...callers]
        .sort((a, b) => b.rank - a.rank)
        .slice(0, MAX_CALLERS_PER_SYMBOL)
        .map((c) => ({ name: c.symbol, file: c.file, line: c.line })),
      caller_total: result.callerTotals?.[sym.name] ?? callers.length,
      endpoints_affected: byDepth(endpoints),
      crons_affected: byDepth(crons),
    };
  });

  return {
    index: toIndexInfo(result, state),
    changed_symbols: result.changedSymbols.map((s) => ({
      name: s.name,
      file: s.file,
      kind: s.kind,
    })),
    downstream,
    impacted_endpoints: [...new Set(result.impactedEndpoints)].sort(),
    impacted_crons: facts
      ? [...new Set(Object.values(facts).flatMap((f) => f.crons))].sort()
      : [],
    summary: summarize(result, downstream),
  };
}

/** Nearest impact first, then alphabetical — a stable, readable order. */
function byDepth(found: Map<string, number>): AffectedEndpoint[] {
  return [...found]
    .map(([endpoint, depth]) => ({ endpoint, depth }))
    .sort((a, b) => a.depth - b.depth || a.endpoint.localeCompare(b.endpoint));
}

/**
 * Collapse the facade's index state into the four states the panel renders.
 *
 * `partial` is deliberately NOT folded into `failed`: it is a working index
 * whose results are real but incomplete, so the UI shows the map *and* a
 * caveat. A blast result the facade tagged `degraded` with no state row at all
 * is `missing` — nothing was ever indexed.
 */
function toIndexInfo(result: BlastResult, state?: IndexState): BlastIndexInfo {
  const reason = state?.reason ?? result.reason ?? null;
  const base = {
    reason: reason ?? null,
    files_indexed: state?.filesIndexed ?? 0,
    last_indexed_sha: state?.lastIndexedSha ?? '',
    updated_at: state?.updatedAt ? state.updatedAt.toISOString() : '',
  };

  if (!state || state.status === 'degraded') {
    // A synthesised "no row" state and a real failure both arrive as
    // status='degraded'; `lastIndexedSha` is what separates them.
    return { ...base, status: state?.lastIndexedSha ? 'failed' : 'missing' };
  }
  if (state.status === 'failed') return { ...base, status: 'failed' };
  if (state.status === 'partial') return { ...base, status: 'partial' };
  return { ...base, status: 'full' };
}

/** One deterministic sentence — no model involved. */
function summarize(result: BlastResult, downstream: DownstreamImpact[]): string {
  if (result.changedSymbols.length === 0) return 'No indexed symbols changed in this PR.';
  const callers = downstream.reduce((n, d) => n + d.callers.length, 0);
  const parts = [
    `${result.changedSymbols.length} changed symbol${result.changedSymbols.length === 1 ? '' : 's'}`,
    `${callers} caller${callers === 1 ? '' : 's'}`,
  ];
  if (result.impactedEndpoints.length > 0) {
    parts.push(`${result.impactedEndpoints.length} impacted endpoint${result.impactedEndpoints.length === 1 ? '' : 's'}`);
  }
  const sentence = parts.join(', ');
  return result.degraded ? `${sentence} (partial index — results may be incomplete).` : `${sentence}.`;
}

/**
 * `merged_at` is populated from the PR's `updated_at`: the schema has no
 * merged-at column, and for "which PR last touched this file" the last update is
 * the ordering the reader actually wants. Rows with no timestamp sort last and
 * render as an empty date rather than the epoch.
 */
export function toHistoryItems(rows: PriorPrRow[]): PrHistoryItem[] {
  return rows.map((r) => ({
    pr_number: r.number,
    title: r.title,
    merged_at: r.updatedAt ? r.updatedAt.toISOString() : '',
    author: r.author,
    files_overlap: [...r.overlap].sort(),
    notes: '',
  }));
}
