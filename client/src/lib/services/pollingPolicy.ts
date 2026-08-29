/* pollingPolicy.ts — pure "should we still be polling?" predicates for
   TanStack Query's `refetchInterval`, pulled out of hooks/reviews.ts so
   they're unit-testable without constructing a Query object. */

/** Poll every 4s while at least one active run exists, otherwise stop. */
export function activeRunsPollInterval(activeRuns: { run_id: string }[] | undefined): number | false {
  return (activeRuns?.length ?? 0) > 0 ? 4000 : false;
}

/** Poll every 4s while any run in the list is still "running", otherwise stop. */
export function runsPollInterval(runs: { status: string | null }[] | undefined): number | false {
  return (runs ?? []).some((r) => r.status === "running") ? 4000 : false;
}
