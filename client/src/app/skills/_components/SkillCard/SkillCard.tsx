/* SkillCard — name, type badge, description, source badge, enabled toggle,
   and an optional usage footer.
   Shared by the /skills grid and the left switcher list on /skills/:id
   (mirrors how AgentCard serves both /agents surfaces). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge, Toggle } from "@devdigest/ui";
import type { Skill, SkillStatsSummary } from "@devdigest/shared";
import { isUntrusted, formatCardRate, typeColor } from "./helpers";
import { s } from "./styles";

export function SkillCard({
  skill,
  active,
  stats,
  onClick,
  onToggle,
}: {
  skill: Skill;
  active?: boolean;
  /**
   * Usage footer. Optional on purpose: the card renders before the batch stats
   * request resolves, and on surfaces that never fetch them — an absent footer
   * is correct there, whereas zeroes would be a claim about the skill.
   */
  stats?: SkillStatsSummary;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  const untrusted = isUntrusted(skill.source);
  const pull = stats ? formatCardRate(stats.pull_frequency) : null;
  const accept = stats ? formatCardRate(stats.accept_rate) : null;
  return (
    <div onClick={onClick} style={s.card(!!active, skill.enabled)}>
      <div style={s.headerRow}>
        <div style={s.iconBox}>
          <Icon.Sparkles size={15} />
        </div>
        <span style={s.name}>{skill.name}</span>
        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle on={skill.enabled} onChange={onToggle} size={14} />
          </div>
        )}
      </div>
      <div style={s.description}>{skill.description}</div>
      <div style={s.metaRow}>
        <Badge color={typeColor(skill.type)}>{t(`listItem.type.${skill.type}`)}</Badge>
        <Badge color="var(--text-muted)">{t(`listItem.source.${skill.source}`)}</Badge>
        {untrusted && (
          <Badge color="var(--warn, var(--crit))" icon="AlertTriangle" style={{ cursor: "help" }}>
            {t("listItem.needsVetting")}
          </Badge>
        )}
      </div>
      {stats && (
        <div style={s.statsRow}>
          <span>{t("card.agents", { count: stats.used_by_agents })}</span>
          {/* Separate no-data strings, not a "—" substituted into "{percent}%
              pull": that would render "—% pull", which reads as a real rate. */}
          <span>
            {pull === null ? t("card.pullNone") : t("card.pull", { percent: pull })}
          </span>
          <span style={s.statAccept}>
            {accept === null ? t("card.acceptNone") : t("card.accept", { percent: accept })}
          </span>
        </div>
      )}
    </div>
  );
}
