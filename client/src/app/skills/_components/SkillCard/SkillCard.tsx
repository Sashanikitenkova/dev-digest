/* SkillCard — name, type badge, description, source badge, enabled toggle.
   Shared by the /skills grid and the left switcher list on /skills/:id
   (mirrors how AgentCard serves both /agents surfaces). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge, Toggle } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { isUntrusted, typeColor } from "./helpers";
import { s } from "./styles";

export function SkillCard({
  skill,
  active,
  onClick,
  onToggle,
}: {
  skill: Skill;
  active?: boolean;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  const untrusted = isUntrusted(skill.source);
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
    </div>
  );
}
