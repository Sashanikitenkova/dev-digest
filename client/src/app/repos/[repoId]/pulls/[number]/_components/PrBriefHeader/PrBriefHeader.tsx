/* PR BRIEF — the review outcome, restated at the top of the Overview tab.

   This is deliberately the SAME VerdictBanner the Findings tab renders, not a
   second presentation of the same numbers: two components drifting apart on
   "how many blockers does this PR have" is exactly the bug worth designing out.
   The only thing Overview adds is the cost footnote, which lives on the run row
   rather than the review (see helpers.runForReview). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, Icon, SectionLabel } from "@devdigest/ui";
import type { ReviewRecord, RunSummary } from "@devdigest/shared";
import { formatCost } from "@/lib/cost";
import { VerdictBanner } from "../VerdictBanner";
import { countBlockers, formatTokens, latestVerdictReview, runForReview } from "./helpers";
import { s } from "./styles";

export function PrBriefHeader({
  reviews,
  runs,
}: {
  reviews: ReviewRecord[];
  runs: RunSummary[] | undefined;
}) {
  const t = useTranslations("brief");
  const review = latestVerdictReview(reviews);

  if (!review || !review.verdict) {
    return (
      <section>
        <SectionLabel icon="FileText">{t("title")}</SectionLabel>
        <EmptyState icon="FileText" title={t("unavailable")} body={t("unavailableHint")} />
      </section>
    );
  }

  const run = runForReview(review, runs);
  // `formatCost` renders null as "–"; the footnote omits the cost entirely
  // instead, so an unpriced run shows no claim rather than a dash.
  const cost = run?.cost_usd != null ? formatCost(run.cost_usd) : null;
  const tokensIn = formatTokens(run?.tokens_in);
  const tokensOut = formatTokens(run?.tokens_out);

  return (
    <section>
      <SectionLabel icon="FileText">{t("title")}</SectionLabel>
      <div style={s.wrap}>
        <VerdictBanner
          verdict={review.verdict}
          summary={review.summary}
          score={review.score}
          findingsCount={review.findings.length}
          blockers={countBlockers(review)}
          agentName={review.agent_name}
        />
        {(cost || (tokensIn && tokensOut)) && (
          <div style={s.footnote}>
            {cost && (
              <span style={s.cost}>
                <Icon.DollarSign size={12} />
                {cost}
              </span>
            )}
            {tokensIn && tokensOut && (
              <span style={s.tokens} className="tnum">
                {tokensIn}&rarr;{tokensOut}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
