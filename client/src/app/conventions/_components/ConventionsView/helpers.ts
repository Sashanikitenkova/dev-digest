import type { ConventionCandidate } from "@devdigest/shared";

/**
 * Split the list for the triage queue.
 *
 * `triageable` keeps pending AND accepted rows on screen — an accepted row has
 * to stay visible because it is what the "Create skill" button consumes, and
 * hiding it the instant it is accepted would make the selection count refer to
 * rows the user can no longer see. Rejected rows drop out of the queue.
 */
export function partitionByStatus(all: ConventionCandidate[]): {
  triageable: ConventionCandidate[];
  accepted: ConventionCandidate[];
} {
  const triageable = all.filter((c) => c.status !== "rejected");
  const accepted = all.filter((c) => c.status === "accepted");
  return { triageable, accepted };
}
