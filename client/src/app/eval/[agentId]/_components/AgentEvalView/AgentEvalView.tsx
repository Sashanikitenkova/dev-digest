/* /eval/:agentId — one agent's regression history.

   The run table is the point of the page: two runs, ticked, compared. Everything
   above it is context for choosing which two. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  LineChart,
  MetricCard,
  Skeleton,
  Badge,
} from "@devdigest/ui";
import { AppShell } from "../../../../../components/app-shell";
import { PageContainer } from "../../../../../components/page-shell";
import { useAgent } from "../../../../../lib/hooks/agents";
import {
  useEvalBatch,
  useEvalDashboard,
  useEvalRuns,
  useStartEvalRun,
} from "../../../../../lib/hooks/eval";
import { routes } from "../../../../../lib/routes";
import { CompareRunsModal } from "./_components/CompareRunsModal";
import { orderPair, pct, runTime, trendSeries } from "./helpers";
import { s } from "./styles";

export function AgentEvalView({ agentId }: { agentId: string }) {
  const t = useTranslations("eval");
  const router = useRouter();
  const agent = useAgent(agentId);
  const dashboard = useEvalDashboard(agentId);
  const runs = useEvalRuns(agentId);
  const startRun = useStartEvalRun();

  const [selected, setSelected] = React.useState<string[]>([]);
  const [comparing, setComparing] = React.useState(false);

  // Hold the started batch id and poll it. Without this the page would start a
  // run and then never learn it finished: the POST resolves with 202 while the
  // batch is still queued, so the trend and the run table would stay on the
  // previous numbers until a manual reload. `useEvalBatch` refreshes both when
  // the batch reaches a terminal status.
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const batch = useEvalBatch(batchId);
  const running = startRun.isPending || batch.data?.batch.status === "running";

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard"), href: routes.evalDashboard() },
    { label: agent.data?.name ?? "…" },
  ];

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : // Cap at two: a comparison is a pair, and silently dropping the
          // oldest tick reads better than refusing the click.
          [...prev.slice(-1), id],
    );

  if (runs.isLoading || dashboard.isLoading) {
    return (
      <AppShell crumb={crumb}>
        <PageContainer title={agent.data?.name}>
          <Skeleton height={120} />
        </PageContainer>
      </AppShell>
    );
  }
  if (runs.isError || !runs.data) {
    return (
      <AppShell crumb={crumb}>
        <PageContainer title={agent.data?.name}>
          <ErrorState body={t("agentPage.loadError")} onRetry={() => runs.refetch()} />
        </PageContainer>
      </AppShell>
    );
  }

  const list = runs.data;
  const current = dashboard.data?.current;
  const delta = dashboard.data?.delta;
  const series = trendSeries(list);
  const pair = selected
    .map((id) => list.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => !!r);
  const ordered = pair.length === 2 ? orderPair(pair[0]!, pair[1]!) : null;

  // Zero traces means nothing was measured, not that everything scored zero:
  // `EvalDashboard.current` cannot express null, so this is the sentinel (AC-35).
  const measured = (current?.traces_total ?? 0) > 0;

  const tile = (label: string, value: number | undefined, d: number | undefined, color?: string) => {
    const formatted = measured ? pct(value ?? null) : null;
    return (
      <MetricCard
        label={label}
        value={formatted ?? t("dashboard.noEvidence")}
        {...(d ? { delta: Math.round(d * 100) / 100 } : {})}
        {...(color ? { color } : {})}
      />
    );
  };

  return (
    <AppShell crumb={crumb}>
      <PageContainer
        title={agent.data?.name}
        subtitle={t("agentPage.subtitle", {
          runs: list.length,
          cases: dashboard.data?.cases_total ?? 0,
        })}
        actions={
          <Button
            kind="primary"
            icon="Play"
            disabled={running || (dashboard.data?.cases_total ?? 0) === 0}
            onClick={async () => {
              const started = await startRun.mutateAsync(agentId);
              setBatchId(started.batch_id);
            }}
          >
            {running ? t("agentPage.running") : t("agentPage.runEval")}
          </Button>
        }
      >
        <button style={s.back} onClick={() => router.push(routes.evalDashboard())}>
          <Icon.ChevronLeft size={14} />
          {t("agentPage.back")}
        </button>

        {dashboard.data?.alert && (
          <div style={s.alert}>
            <Icon.AlertTriangle size={16} />
            <span>{dashboard.data.alert}</span>
          </div>
        )}

        <div style={s.tiles}>
          {tile(t("dashboard.metrics.recall"), current?.recall, delta?.recall)}
          {tile(t("dashboard.metrics.precision"), current?.precision, delta?.precision, "var(--ok)")}
          {tile(
            t("dashboard.metrics.citationAccuracy"),
            current?.citation_accuracy,
            delta?.citation_accuracy,
            "var(--warn)",
          )}
        </div>

        {series.recall.length > 1 && (
          <div style={s.panel}>
            <div style={s.panelHead}>
              <Icon.TrendingUp size={13} />
              {t("dashboard.metricTrend")}
              <span style={s.spacer} />
              <span style={s.legend}>
                <span style={s.legendItem}>
                  <span style={s.swatch("var(--accent)")} />
                  {t("dashboard.legend.recall")}
                </span>
                <span style={s.legendItem}>
                  <span style={s.swatch("var(--ok)")} />
                  {t("dashboard.legend.precision")}
                </span>
                <span style={s.legendItem}>
                  <span style={s.swatch("var(--warn)")} />
                  {t("dashboard.legend.citation")}
                </span>
              </span>
            </div>
            <div style={s.scroll}>
              <LineChart
                series={[
                  { name: t("dashboard.legend.recall"), color: "var(--accent)", data: series.recall },
                  { name: t("dashboard.legend.precision"), color: "var(--ok)", data: series.precision },
                  { name: t("dashboard.legend.citation"), color: "var(--warn)", data: series.citation },
                ]}
              />
            </div>
          </div>
        )}

        <div style={s.panel}>
          <div style={s.panelHead}>
            <Icon.History size={13} />
            {t("agentPage.recentRuns")}
            {selected.length > 0 && (
              <Badge color="var(--text-secondary)">
                {t("agentPage.selected", { count: selected.length })}
              </Badge>
            )}
            <span style={s.spacer} />
            <Button
              kind="secondary"
              size="sm"
              icon="Copy"
              disabled={selected.length !== 2}
              title={selected.length !== 2 ? t("agentPage.compareHint") : undefined}
              onClick={() => setComparing(true)}
            >
              {t("agentPage.compare")}
            </Button>
          </div>

          {list.length === 0 ? (
            <EmptyState icon="FlaskConical" title={t("agentPage.noRuns")} />
          ) : (
            <div style={s.scroll}>
              <div style={s.headRow}>
                <span />
                <span>{t("dashboard.table.ranAt")}</span>
                <span>{t("agentPage.version", { version: "" })}</span>
                <span>{t("dashboard.table.recall")}</span>
                <span>{t("dashboard.table.precision")}</span>
                <span>{t("dashboard.table.citation")}</span>
                <span>{t("dashboard.table.pass")}</span>
                <span>{t("dashboard.table.cost")}</span>
              </div>
              {list.map((r) => (
                <div key={r.id} style={s.row}>
                  {/* A running batch has no numbers yet, so comparing it would
                      read every metric as a drop to zero — it gets no checkbox. */}
                  {r.status === "running" ? (
                    <Icon.RefreshCw size={13} style={{ color: "var(--text-muted)" }} />
                  ) : (
                    <Checkbox checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                  )}
                  <span style={{ ...s.mono, ...s.muted }}>{runTime(r.started_at)}</span>
                  <span style={{ ...s.mono, color: "var(--accent)" }}>v{r.agent_version ?? 1}</span>
                  <span>{pct(r.recall) ?? "—"}</span>
                  <span>{pct(r.precision) ?? "—"}</span>
                  <span>{pct(r.citation_accuracy) ?? "—"}</span>
                  <span style={{ fontWeight: 600 }}>
                    {r.traces_passed}/{r.traces_total}
                  </span>
                  <span style={s.muted}>
                    {r.cost_usd === null ? "—" : `$${r.cost_usd.toFixed(3)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {comparing && ordered && (
          <CompareRunsModal
            aId={ordered[0].id}
            bId={ordered[1].id}
            onClose={() => setComparing(false)}
          />
        )}
      </PageContainer>
    </AppShell>
  );
}
