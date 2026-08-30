/* /conventions — extract house-rules from the active repo, triage them, and
   merge the accepted ones into a Skill.

   The extractor's own report (proposed / kept / dropped) is surfaced rather
   than just the surviving rows: candidates whose evidence failed validation
   are discarded server-side, so a scan that keeps nothing is a real signal and
   must not render as an ordinary empty list. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import type { ConventionCandidate } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import { useActiveRepo } from "../../../../lib/repo-context";
import {
  useConventions,
  useExtractConventions,
  useSetConventionStatus,
} from "../../../../lib/hooks/conventions";
import { ConventionCard } from "../ConventionCard";
import { CreateSkillModal } from "../CreateSkillModal";
import { partitionByStatus } from "./helpers";
import { s } from "./styles";

export function ConventionsView() {
  const t = useTranslations("conventions");
  const { repoId, activeRepo } = useActiveRepo();

  const { data, isLoading, isError, refetch } = useConventions(repoId);
  const extract = useExtractConventions(repoId);
  const setStatus = useSetConventionStatus(repoId);
  const [creating, setCreating] = React.useState(false);

  const all: ConventionCandidate[] = data ?? [];
  const { triageable, accepted } = partitionByStatus(all);

  const crumb = [{ label: t("page.crumbLab") }, { label: t("page.crumbConventions") }];
  const repoShort = activeRepo?.full_name?.split("/").pop() ?? t("page.repoFallback");
  const run = () => extract.mutate();

  // The extractor reports what it discarded; keep that visible after the run.
  const report = extract.data;
  const allDropped = !!report && report.proposed > 0 && report.kept === 0;

  return (
    <AppShell crumb={crumb}>
      {creating && (
        <CreateSkillModal
          repoFullName={activeRepo?.full_name}
          conventions={accepted}
          onClose={() => setCreating(false)}
        />
      )}

      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {t("page.headingPrefix")}
              <span style={s.repo}>{repoShort}</span>
            </h1>
            <p style={s.subtitle}>
              {report
                ? t("page.detected", { files: report.sampled_files })
                : t("page.subtitle")}
            </p>
          </div>
          {all.length > 0 && (
            <Button
              kind="secondary"
              size="sm"
              icon="RefreshCw"
              disabled={extract.isPending || !repoId}
              onClick={run}
            >
              {extract.isPending ? t("page.scanning") : t("page.rescan")}
            </Button>
          )}
        </div>

        {extract.isError && (
          <div style={s.errorBar}>
            {(extract.error as Error)?.message || t("page.extractionFailed")}
          </div>
        )}
        {allDropped && (
          <div style={s.warnBar}>{t("page.allDropped", { proposed: report.proposed })}</div>
        )}
        {!allDropped && !!report?.dropped && (
          <div style={s.noticeBar}>{t("page.droppedNotice", { dropped: report.dropped })}</div>
        )}

        {!repoId && <EmptyState icon="ListChecks" title={t("page.noRepo")} />}

        {repoId && isLoading && (
          <div>
            <Skeleton height={150} />
            <div style={{ height: 14 }} />
            <Skeleton height={150} />
          </div>
        )}

        {repoId && isError && <ErrorState body={t("page.loadError")} onRetry={() => refetch()} />}

        {repoId && !isLoading && !isError && all.length === 0 && (
          <EmptyState
            icon="ListChecks"
            title={t("page.empty.title")}
            body={t("page.empty.body")}
            cta={extract.isPending ? t("page.scanning") : t("page.empty.cta")}
            onCta={extract.isPending ? undefined : run}
          />
        )}

        {triageable.length > 0 && (
          <>
            <div style={s.toolbar}>
              <span style={s.count}>
                {t("page.acceptedCount", { selected: accepted.length, total: triageable.length })}
              </span>
              <Button
                kind="primary"
                size="sm"
                icon="Sparkles"
                disabled={accepted.length === 0}
                onClick={() => setCreating(true)}
              >
                {t("page.createSkill")}
              </Button>
            </div>

            {triageable.map((c) => (
              <ConventionCard
                key={c.id}
                convention={c}
                repo={activeRepo ?? null}
                busy={setStatus.isPending}
                onAccept={() =>
                  setStatus.mutate({
                    id: c.id,
                    // Clicking an accepted row again un-accepts it, so triage
                    // is reversible without a separate "undo" affordance.
                    status: c.status === "accepted" ? "pending" : "accepted",
                  })
                }
                onReject={() =>
                  setStatus.mutate({
                    id: c.id,
                    status: c.status === "rejected" ? "pending" : "rejected",
                  })
                }
              />
            ))}
          </>
        )}

        {repoId && all.length > 0 && triageable.length === 0 && (
          <EmptyState
            icon="Check"
            title={t("page.allTriaged.title")}
            body={t("page.allTriaged.body")}
            cta={extract.isPending ? t("page.scanning") : t("page.allTriaged.cta")}
            onCta={extract.isPending ? undefined : run}
          />
        )}
      </div>
    </AppShell>
  );
}
