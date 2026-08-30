/* Stats tab — how much work this skill is actually doing.

   The subtitle carries a caveat that is NOT decoration: no column records
   which skill produced a finding, so "accept rate" and "findings" are measured
   over reviews by agents that link this skill. Stating that is the difference
   between a useful proxy and a number that quietly claims causation. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button, Donut, ErrorState, Icon, MetricCard, Skeleton } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useSkillStats } from "../../../../../../../lib/hooks/skills";
import { routes } from "../../../../../../../lib/routes";
import { DONUT_SIZE } from "./constants";
import { formatRate, toSegments } from "./helpers";
import { s } from "./styles";

export function StatsTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useSkillStats(skill.id);

  if (isLoading) {
    return (
      <div style={s.wrap}>
        <Skeleton height={90} />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div style={s.wrap}>
        <ErrorState body={t("stats.loadError")} onRetry={() => refetch()} />
      </div>
    );
  }

  const pull = formatRate(data.pull_frequency);
  const accept = formatRate(data.accept_rate);
  const segments = toSegments(data.findings_by_category);

  return (
    <div style={s.wrap}>
      <h2 style={s.h2}>{t("stats.heading")}</h2>
      <p style={s.subtitle}>{t("stats.subtitle")}</p>

      <div style={s.tiles}>
        <MetricCard
          label={t("stats.usedBy")}
          value={data.used_by_agents}
          suffix={t("stats.usedByUnit", { count: data.used_by_agents })}
        />
        <MetricCard
          label={t("stats.pullFrequency")}
          value={pull ?? t("stats.noData")}
          {...(pull ? { suffix: "%" } : {})}
        />
        <MetricCard
          label={t("stats.acceptRate")}
          value={accept ?? t("stats.noData")}
          {...(accept ? { suffix: "%" } : {})}
          color="var(--ok, var(--accent))"
        />
        <MetricCard label={t("stats.findings")} value={data.findings_30d} />
      </div>

      <div style={s.panels}>
        <div style={s.panel}>
          <div style={s.panelHeading}>
            <Icon.Cpu size={13} />
            {t("stats.agentsHeading")}
          </div>
          {data.agents.length === 0 && <div style={s.note}>{t("stats.agentsEmpty")}</div>}
          {data.agents.map((a) => (
            <div key={a.id} style={s.agentRow}>
              <Icon.Cpu size={14} style={{ color: "var(--accent)" }} />
              <span style={s.agentName}>{a.name}</span>
              <Button
                kind="tertiary"
                size="sm"
                onClick={() => router.push(`${routes.agent(a.id)}?tab=skills`)}
              >
                {t("stats.open")}
              </Button>
            </div>
          ))}
        </div>

        <div style={s.panel}>
          <div style={s.panelHeading}>
            <Icon.Tag size={13} />
            {t("stats.categoryHeading")}
          </div>
          {segments.length === 0 ? (
            <div style={s.note}>{t("stats.categoryEmpty")}</div>
          ) : (
            // decimals={0}: these are counts, not the currency the Donut
            // defaults to — "52.00 security findings" would read as money.
            <Donut segments={segments} size={DONUT_SIZE} valuePrefix="" decimals={0} />
          )}
        </div>
      </div>
    </div>
  );
}
