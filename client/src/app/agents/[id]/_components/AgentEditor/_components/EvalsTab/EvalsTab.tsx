/* Evals tab — the agent's regression set and what the last run said about it.

   The metrics here answer one question: did the last edit to this agent's
   definition make it better or worse? They are computed entirely in code from
   accept/dismiss decisions the reviewer already made (SPEC-03), so a number
   moving means the agent changed, not that a judge was in a different mood. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button, Badge, EmptyState, ErrorState, Icon, MetricCard, Skeleton } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import {
  useEvalCases,
  useEvalDashboard,
  useStartEvalRun,
  useDeleteEvalCase,
  useEvalBatch,
} from "../../../../../../../lib/hooks/eval";
import { routes } from "../../../../../../../lib/routes";
import { caseStatus, formatMetric, passSummary, targetLabel } from "./helpers";
import { s } from "./styles";

export function EvalsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("eval");
  const router = useRouter();
  const cases = useEvalCases(agent.id);
  const dashboard = useEvalDashboard(agent.id);
  const startRun = useStartEvalRun();
  const deleteCase = useDeleteEvalCase();

  // The batch started from this tab, polled until it finishes. Held in state
  // rather than derived: the run is fire-and-forget server-side, so the id the
  // POST returned is the only handle on it.
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const batch = useEvalBatch(batchId);
  const running = startRun.isPending || batch.data?.batch.status === "running";

  if (cases.isLoading) {
    return (
      <div style={s.wrap}>
        <Skeleton height={90} />
      </div>
    );
  }
  if (cases.isError || !cases.data) {
    return (
      <div style={s.wrap}>
        <ErrorState body={t("evalsTab.loadError")} onRetry={() => cases.refetch()} />
      </div>
    );
  }

  const { cases: list, latest } = cases.data;
  const summary = passSummary(list, latest);
  const current = dashboard.data?.current;
  const delta = dashboard.data?.delta;

  // `EvalDashboard.current` types its metrics as plain numbers, so an agent
  // that has never run comes back as three zeros rather than nulls. Zero traces
  // is the sentinel for "nothing was measured" — rendering those zeros as 0%
  // would report a total failure for an agent nobody has evaluated yet (AC-35).
  const measured = (current?.traces_total ?? 0) > 0;

  const metric = (value: number | undefined, deltaValue: number | undefined) => {
    const formatted = measured ? formatMetric(value ?? null) : null;
    return {
      value: formatted ?? t("evalsTab.noData"),
      ...(formatted ? { suffix: "%" } : {}),
      ...(deltaValue ? { delta: Math.round(deltaValue * 100) / 100 } : {}),
    };
  };

  return (
    <div style={s.wrap}>
      <div style={s.headRow}>
        <div>
          <h2 style={s.h2}>{t("evalsTab.metricsTitle")}</h2>
          <p style={s.subtitle}>{t("evalsTab.metricsSubtitle")}</p>
        </div>
        <button style={s.link} onClick={() => router.push(routes.agentEvals(agent.id))}>
          {t("evalsTab.viewDashboard")}
        </button>
      </div>

      <div style={s.tiles}>
        <MetricCard label={t("dashboard.metrics.recall")} {...metric(current?.recall, delta?.recall)} />
        <MetricCard
          label={t("dashboard.metrics.precision")}
          {...metric(current?.precision, delta?.precision)}
          color="var(--ok, var(--accent))"
        />
        <MetricCard
          label={t("dashboard.metrics.citationAccuracy")}
          {...metric(current?.citation_accuracy, delta?.citation_accuracy)}
        />
        <MetricCard
          label={t("evalsTab.tracesPassed")}
          value={
            measured ? `${current!.traces_passed}/${current!.traces_total}` : t("evalsTab.noData")
          }
        />
      </div>

      {batch.data?.batch.status === "done" && (
        <div style={s.banner}>
          {t("evalsTab.runFinished", {
            passed: batch.data.batch.traces_passed,
            total: batch.data.batch.traces_total,
          })}
        </div>
      )}

      <div style={s.casesHead}>
        <span style={s.casesTitle}>{t("evalsTab.casesHeading")}</span>
        {summary.ran > 0 && (
          <Badge
            color={summary.passed === summary.ran ? "var(--ok)" : "var(--warn)"}
            bg="var(--bg-hover)"
          >
            {t("evalsTab.passSummary", { passed: summary.passed, total: summary.ran })}
          </Badge>
        )}
        <span style={s.spacer} />
        <Button
          kind="primary"
          size="sm"
          icon="Play"
          // An empty set would start a batch with nothing to measure; the
          // server rejects it, so the control says so first (AC-47).
          disabled={list.length === 0 || running}
          onClick={async () => {
            const started = await startRun.mutateAsync(agent.id);
            setBatchId(started.batch_id);
          }}
        >
          {running ? t("evalsTab.running") : t("evalsTab.runAll", { count: list.length })}
        </Button>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon="FlaskConical"
          title={t("evalsTab.emptyTitle")}
          body={t("evalsTab.emptyCases")}
        />
      ) : (
        list.map((c) => {
          const status = caseStatus(latest[c.id]);
          const target = targetLabel(c);
          const kind = (c.expected_output as { kind?: string } | null)?.kind;
          return (
            <div key={c.id} style={s.caseRow}>
              {status === "passed" && <Icon.CheckCircle size={16} style={{ color: "var(--ok)" }} />}
              {status === "failed" && <Icon.XCircle size={16} style={{ color: "var(--crit)" }} />}
              {status === "never" && <Icon.Dot size={16} style={{ color: "var(--text-muted)" }} />}
              <div style={s.caseMain}>
                <div style={s.caseName}>{c.name}</div>
                <div style={s.caseMeta}>
                  {status === "never" ? t("evalsTab.neverRun") : t(`evalsTab.${status}`)}
                  {target ? ` · ${target}` : ""}
                </div>
              </div>
              {kind && (
                <Badge
                  mono
                  color={kind === "must_find" ? "var(--accent)" : "var(--text-secondary)"}
                >
                  {t(`expectation.${kind}`)}
                </Badge>
              )}
              <Button
                kind="ghost"
                size="sm"
                icon="Trash"
                disabled={deleteCase.isPending}
                onClick={() => deleteCase.mutate(c.id)}
              >
                {t("evalsTab.delete")}
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
}
