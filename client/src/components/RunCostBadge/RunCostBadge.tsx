/**
 * RunCostBadge — shared cost display, used on both the Pull Requests list
 * and the PR Detail Agent Runs timeline (hence living here, not in either
 * page's local `_components/`, alongside app-shell/diff-viewer).
 */
"use client";

import { formatCost } from "@/lib/cost";
import { s } from "./styles";

type RunCostBadgeProps =
  | { variant: "compact"; usd: number | null }
  | {
      variant: "withTokens";
      usd: number | null;
      tokensIn: number | null | undefined;
      tokensOut: number | null | undefined;
    };

export function RunCostBadge(props: RunCostBadgeProps) {
  if (props.variant === "compact") {
    return <span className="mono tnum" style={s.compact}>{formatCost(props.usd)}</span>;
  }

  const tok = (props.tokensIn ?? 0) + (props.tokensOut ?? 0);
  if (tok === 0) return null;
  return (
    <span className="mono tnum" style={s.withTokens}>
      {tok.toLocaleString()} tok · {formatCost(props.usd)}
    </span>
  );
}
