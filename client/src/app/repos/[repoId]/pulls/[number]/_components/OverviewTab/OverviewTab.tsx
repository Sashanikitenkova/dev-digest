"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import type { ReviewRecord, RunSummary } from "@devdigest/shared";
import { BlastRadiusPanel } from "../BlastRadiusPanel";
import { IntentCard } from "../IntentCard";
import { PrBriefHeader } from "../PrBriefHeader";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  repoId: string;
  /** "owner/repo" — lets Blast Radius deep-link a caller's file:line to GitHub. */
  repoFullName: string | null;
  headSha: string | null | undefined;
  prBody: string | null | undefined;
  reviews: ReviewRecord[];
  runs: RunSummary[] | undefined;
}

/**
 * Reading order is the point of this tab: the brief states the verdict, then
 * Intent lets the reader check the system understood the task before they weigh
 * what it said about the code, and only then comes the author's own description.
 */
export function OverviewTab({
  prId,
  repoId,
  repoFullName,
  headSha,
  prBody,
  reviews,
  runs,
}: OverviewTabProps) {
  return (
    <>
      <PrBriefHeader reviews={reviews} runs={runs} />

      <div style={s.grid}>
        <IntentCard prId={prId} headSha={headSha} />
        <BlastRadiusPanel
          prId={prId}
          repoId={repoId}
          repoFullName={repoFullName}
          headSha={headSha}
        />
      </div>

      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
