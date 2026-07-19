/* tokens.ts — rough token accounting for UI badges only.

   Deliberately a chars/4 heuristic rather than a real tokenizer: the server
   already reports exact usage on a completed run, and this is only used to
   give an author a sense of how much prompt budget a block costs while they
   type. Never use it for billing, truncation, or budget enforcement. */

/** Approximate token count for `text` (~4 chars per token). */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Render an estimate as the `~N tokens` badge label used across the studio. */
export function formatTokenEstimate(text: string | null | undefined): string {
  const n = estimateTokens(text);
  return `~${n.toLocaleString()} tokens`;
}
