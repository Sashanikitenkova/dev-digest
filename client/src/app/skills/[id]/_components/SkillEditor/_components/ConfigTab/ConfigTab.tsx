/* Config tab — name / description / type / body / enabled + Save.

   The description field carries an explicit hint because it is the skill's
   *interface*: it's what an agent author reads when deciding whether to link
   this skill, so it has to be written directively rather than as prose. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, FormField, Icon, SelectInput, Textarea, TextInput, Toggle } from "@devdigest/ui";
import type { Skill, SkillType } from "@devdigest/shared";
import { formatTokenEstimate } from "../../../../../../../lib/tokens";
import { isUntrusted } from "../../../../../_components/SkillCard/helpers";
import { BODY_ROWS, SKILL_TYPE_VALUES } from "./constants";
import { useSkillConfigForm } from "./useSkillConfigForm";
import { s } from "./styles";

export function ConfigTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const {
    name,
    setName,
    description,
    setDescription,
    type,
    setType,
    body,
    setBody,
    enabled,
    setEnabled,
    update,
    save,
  } = useSkillConfigForm(skill, t);

  const typeOptions = SKILL_TYPE_VALUES.map((v) => ({ value: v, label: t(`listItem.type.${v}`) }));

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("editor.configHeading")}</h2>
        <label style={s.enabledLabel}>
          {t("editor.enabled")}
          <Toggle on={enabled} onChange={setEnabled} size={16} />
        </label>
      </div>

      {isUntrusted(skill.source) && (
        <div style={s.untrusted}>
          <Icon.Shield size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t("editor.untrustedNotice")}</span>
        </div>
      )}

      <FormField label={t("editor.nameLabel")} required>
        <TextInput value={name} onChange={setName} placeholder={t("editor.namePlaceholder")} />
      </FormField>

      <FormField label={t("editor.descriptionLabel")} hint={t("editor.descriptionHint")}>
        <TextInput
          value={description}
          onChange={setDescription}
          placeholder={t("editor.descriptionPlaceholder")}
        />
      </FormField>

      <FormField label={t("editor.typeLabel")}>
        <SelectInput value={type} onChange={(v) => setType(v as SkillType)} options={typeOptions} />
      </FormField>

      <FormField
        label={t("editor.bodyLabel")}
        required
        // Rough chars/4 estimate — enough to feel the prompt-budget cost while
        // typing; the run trace reports the real usage afterwards.
        right={<Badge color="var(--text-muted)" mono>{formatTokenEstimate(body)}</Badge>}
      >
        <Textarea
          value={body}
          onChange={setBody}
          rows={BODY_ROWS}
          mono
          placeholder={t("editor.bodyPlaceholder")}
        />
      </FormField>

      <div style={s.actions}>
        <Button kind="primary" icon="Check" onClick={save} disabled={update.isPending}>
          {update.isPending ? t("editor.saving") : t("editor.save")}
        </Button>
        {update.isSuccess && (
          <span style={s.savedNote}>{t("preview.version", { version: update.data?.version })}</span>
        )}
        {update.isError && <span style={s.errorNote}>{t("editor.saveError")}</span>}
      </div>
    </div>
  );
}
