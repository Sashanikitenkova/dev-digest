import type { BlastRadius, DownstreamImpact, PrHistoryItem } from '@devdigest/shared';
import type { BlastResult } from '../repo-intel/types.js';
import type { PriorPrRow } from './repository.js';
import { MAX_CALLERS_PER_SYMBOL } from './constants.js';

/**
 * Map the repo-intel facade's internal `BlastResult` onto the public
 * `BlastRadius` contract.
 *
 * The interesting part is endpoint/cron attribution. `factsByFile` is a
 * per-CALLER-FILE map, so an endpoint is attributed to a changed symbol only
 * when a caller of that symbol lives in the file declaring the endpoint. On the
 * degraded (ripgrep) path `factsByFile` is absent entirely and no attribution is
 * possible — rather than smear the flat `impactedEndpoints` list across every
 * symbol (which reads as "all 3 endpoints hit all 2 symbols", a claim the index
 * never made), per-symbol lists stay empty and the flat union is reported at the
 * top level. Under-claiming is the correct failure here: the whole panel exists
 * to tell a reviewer what a change actually reaches.
 */
export function toBlastRadius(result: BlastResult): BlastRadius {
  const facts = result.factsByFile;

  const downstream: DownstreamImpact[] = result.changedSymbols.map((sym) => {
    const callers = result.callers.filter((c) => c.viaSymbol === sym.name);
    const endpoints = new Set<string>();
    const crons = new Set<string>();
    if (facts) {
      for (const c of callers) {
        for (const e of facts[c.file]?.endpoints ?? []) endpoints.add(e);
        for (const cr of facts[c.file]?.crons ?? []) crons.add(cr);
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
      endpoints_affected: [...endpoints].sort(),
      crons_affected: [...crons].sort(),
    };
  });

  return {
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
