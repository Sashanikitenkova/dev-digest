/* Preview tab — the saved body rendered as markdown, i.e. as the reviewing
   agent receives it. Renders the persisted `skill.body`, not the Config tab's
   unsaved draft, so what you see is what a run would actually inject. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, Markdown } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { formatTokenEstimate } from "../../../../../../../lib/tokens";
import { isUntrusted } from "../../../../../_components/SkillCard/helpers";
import { s } from "./styles";

export function PreviewTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("editor.tabs.preview")}</h2>
        <Badge color="var(--text-muted)" mono>
          {formatTokenEstimate(skill.body)}
        </Badge>
      </div>
      <p style={s.subtitle}>{t("editor.previewSubtitle")}</p>

      {isUntrusted(skill.source) && (
        <div style={s.untrusted}>
          <Icon.Shield size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t("editor.untrustedNotice")}</span>
        </div>
      )}

      <div style={s.rendered}>
        <Markdown>{skill.body}</Markdown>
      </div>
    </div>
  );
}
