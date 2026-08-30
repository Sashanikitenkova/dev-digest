/* /eval — every reviewer agent's eval health in one place.

   The cards deliberately show "no evidence" rather than 0% for an agent that
   has never run: an unmeasured agent and a failing one are different states,
   and collapsing them is how a regression dashboard starts lying. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState, Icon, Skeleton, Sparkline, Badge } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { PageContainer } from "../../../../components/page-shell";
import { useEvalOverview } from "../../../../lib/hooks/eval";
import { routes } from "../../../../lib/routes";
import { pct, runTime } from "./helpers";
import { s } from "./styles";

export function EvalDashboardView() {
  const t = useTranslations("eval");
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useEvalOverview();

  const crumb = [{ label: t("page.crumbSkillsLab") }, { label: t("page.crumbEvalDashboard") }];

  if (isLoading) {
    return (
      <AppShell crumb={crumb}>
        <PageContainer title={t("dashboard.defaultTitle")}>
          <Skeleton height={90} />
        </PageContainer>
      </AppShell>
    );
  }
  if (isError || !data) {
    return (
      <AppShell crumb={crumb}>
        <PageContainer title={t("dashboard.defaultTitle")}>
          <ErrorState body={t("dashboard.loadError")} onRetry={() => refetch()} />
        </PageContainer>
      </AppShell>
    );
  }

  const agentName = (id: string) =>
    data.agents.find((a) => a.agent_id === id)?.agent_name ?? id.slice(0, 8);

  const metric = (value: number | null | undefined) => pct(value) ?? t("dashboard.noEvidence");

  return (
    <AppShell crumb={crumb}>
      <PageContainer title={t("dashboard.defaultTitle")} subtitle={t("dashboard.subtitle")}>
        <div style={s.sectionLabel}>
          <Icon.Cpu size={13} />
          {t("dashboard.agentsHeading")}
        </div>

        {data.agents.length === 0 ? (
          <EmptyState icon="Cpu" title={t("dashboard.noAgents")} />
        ) : (
          data.agents.map((a) => (
            <button
              key={a.agent_id}
              style={s.card}
              onClick={() => router.push(routes.agentEvals(a.agent_id))}
            >
              <Icon.Cpu size={18} style={{ color: "var(--accent)" }} />
              <div style={s.cardMain}>
                <div style={s.cardTitleRow}>
                  <span style={s.cardName}>{a.agent_name}</span>
                  {a.model && (
                    <Badge mono color="var(--text-secondary)">
                      {a.model}
                    </Badge>
                  )}
                </div>
                <div style={s.cardMeta}>
                  {a.cases_total === 0
                    ? t("dashboard.noCases")
                    : a.latest
                      ? t("dashboard.lastRun", {
                          version: a.latest.agent_version ?? 1,
                          when: runTime(a.latest.started_at),
                          passed: a.latest.traces_passed,
                          total: a.latest.traces_total,
                        })
                      : `${t("dashboard.neverRun")} · ${t("dashboard.casesCount", { count: a.cases_total })}`}
                </div>
              </div>
              <div style={s.metrics}>
                <div style={s.metric}>
                  <div style={s.metricLabel}>{t("dashboard.metrics.recall")}</div>
                  <div style={{ ...s.metricValue, color: "var(--accent)" }}>
                    {metric(a.latest?.recall)}
                  </div>
                </div>
                <div style={s.metric}>
                  <div style={s.metricLabel}>{t("dashboard.metrics.precision")}</div>
                  <div style={{ ...s.metricValue, color: "var(--ok)" }}>
                    {metric(a.latest?.precision)}
                  </div>
                </div>
                <div style={s.metric}>
                  <div style={s.metricLabel}>{t("dashboard.metrics.citationAccuracy")}</div>
                  <div style={{ ...s.metricValue, color: "var(--warn)" }}>
                    {metric(a.latest?.citation_accuracy)}
                  </div>
                </div>
                <Icon.ChevronRight size={16} style={{ color: "var(--text-muted)" }} />
              </div>
            </button>
          ))
        )}

        <div style={s.sectionLabel}>
          <Icon.History size={13} />
          {t("dashboard.recentAll")}
        </div>

        {data.recent_runs.length === 0 ? (
          <EmptyState icon="FlaskConical" title={t("dashboard.noRuns")} />
        ) : (
          <div style={s.scroll}>
            <div style={s.table}>
              <div style={s.headRow}>
                <span>{t("dashboard.table.ranAt")}</span>
                <span />
                <span />
                <span>{t("dashboard.table.recall")}</span>
                <span>{t("dashboard.table.precision")}</span>
                <span>{t("dashboard.table.citation")}</span>
                <span>{t("dashboard.table.pass")}</span>
              </div>
              {data.recent_runs.map((r) => (
                <div key={r.id} style={s.row}>
                  <span style={s.agentCell}>{agentName(r.owner_id)}</span>
                  <span style={{ ...s.mono, ...s.muted }}>{runTime(r.started_at)}</span>
                  <span style={{ ...s.mono, color: "var(--accent)" }}>
                    v{r.agent_version ?? 1}
                  </span>
                  <span>{metric(r.recall)}</span>
                  <span>{metric(r.precision)}</span>
                  <span>{metric(r.citation_accuracy)}</span>
                  <span style={{ fontWeight: 600 }}>
                    {r.traces_passed}/{r.traces_total}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </PageContainer>
    </AppShell>
  );
}
