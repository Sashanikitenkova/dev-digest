"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import type { ReviewRecord, RunSummary } from "@devdigest/shared";
import { BlastRadiusPanel } from "../BlastRadiusPanel";
import { IntentCard } from "../IntentCard";
import { PrBriefCard } from "../PrBriefCard";
import { PrBriefHeader } from "../PrBriefHeader";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  repoId: string;
  /** "owner/repo" — lets Blast Radius deep-link a caller's file:line to GitHub. */
  repoFullName: string | null;
  headSha: string | null | undefined;
  prBody: string | null | undefined;
  /** Paths of the PR's changed files — which brief references the diff can show. */
  changedFiles: readonly string[];
  /** A brief focus row asking for a file (and line) to be opened in the diff. */
  onFocusFile: (file: string, line: number | null) => void;
  reviews: ReviewRecord[];
  runs: RunSummary[] | undefined;
}

/**
 * Reading order is the point of this tab: the verdict banner states where the
 * review landed, the brief then says what the PR is, why it exists and what to
 * read first, Intent lets the reader check the system understood the task
 * before they weigh what it said about the code, and only then comes the
 * author's own description.
 *
 * The brief is a single FULL-WIDTH section deliberately outside `s.grid` — put
 * inside it, it would become a grid cell and sit in one 420px column.
 */
export function OverviewTab({
  prId,
  repoId,
  repoFullName,
  headSha,
  prBody,
  changedFiles,
  onFocusFile,
  reviews,
  runs,
}: OverviewTabProps) {
  return (
    <>
      <PrBriefHeader reviews={reviews} runs={runs} />

      <PrBriefCard
        prId={prId}
        headSha={headSha}
        repoFullName={repoFullName}
        changedFiles={changedFiles}
        onFocusFile={onFocusFile}
      />

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
