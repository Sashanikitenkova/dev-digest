/* Create-skill modal — merges the accepted conventions into one editable skill
   body, then saves it via POST /skills and (optionally) links it to an agent
   through the existing agent-skills mechanism.

   Everything is pre-filled but editable: the extractor's wording is a draft,
   and a skill that goes into every future review prompt deserves a human pass
   before it is saved. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, FormField, Icon, Modal, SelectInput, TextInput, Textarea } from "@devdigest/ui";
import type { ConventionCandidate, SkillType } from "@devdigest/shared";
import { useCreateSkill } from "../../../../lib/hooks/skills";
import { useAgents, useAgentSkills, useSetAgentSkills } from "../../../../lib/hooks/agents";
import { buildSkillBody, skillNameForRepo } from "./helpers";
import { s } from "./styles";

const SKILL_TYPE: SkillType = "convention";
const NO_AGENT = "";

export function CreateSkillModal({
  repoFullName,
  conventions,
  onClose,
  onCreated,
}: {
  repoFullName: string | undefined;
  conventions: ConventionCandidate[];
  onClose: () => void;
  onCreated?: (skillId: string) => void;
}) {
  const t = useTranslations("conventions");
  const create = useCreateSkill();
  const { data: agents } = useAgents();
  const setSkills = useSetAgentSkills();

  const [name, setName] = React.useState(() => skillNameForRepo(repoFullName));
  const [description, setDescription] = React.useState(() =>
    t("modal.defaultDescription", { count: conventions.length, repo: repoFullName ?? "" }),
  );
  const [body, setBody] = React.useState(() => buildSkillBody(repoFullName, conventions));
  const [agentId, setAgentId] = React.useState<string>(NO_AGENT);
  const [error, setError] = React.useState<string | null>(null);

  // Existing links for the chosen agent: the set endpoint replaces the WHOLE
  // ordered link set, so the new skill must be appended to what is already
  // there or linking it would silently unlink everything else.
  const { data: existingLinks } = useAgentSkills(agentId || null);

  const submit = async () => {
    setError(null);
    try {
      const skill = await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        type: SKILL_TYPE,
        // Provenance is real: this body came out of the extractor, not a human.
        // It makes the skill land disabled AND delimiter-wrapped as untrusted
        // at review time. Passing 'manual' would inject LLM-derived text as
        // trusted instructions — do not "fix" it that way.
        source: "extracted",
        body,
      });
      if (agentId) {
        const ids = [...(existingLinks ?? []).map((l) => l.skill_id), skill.id];
        await setSkills.mutateAsync({ agentId, skillIds: ids });
      }
      onCreated?.(skill.id);
      onClose();
    } catch (e) {
      setError((e as Error).message || t("modal.failed"));
    }
  };

  const busy = create.isPending || setSkills.isPending;
  const canSubmit = name.trim().length > 0 && body.trim().length > 0 && !busy;

  return (
    <Modal
      width={860}
      title={t("modal.title")}
      subtitle={name}
      onClose={onClose}
      footer={
        <div style={s.footer}>
          {error && <span style={s.error}>{error}</span>}
          <div style={s.footerActions}>
            <Button kind="secondary" size="sm" onClick={onClose}>
              {t("modal.cancel")}
            </Button>
            <Button kind="primary" size="sm" icon="Sparkles" disabled={!canSubmit} onClick={submit}>
              {busy ? t("modal.saving") : t("modal.submit")}
            </Button>
          </div>
        </div>
      }
    >
      <div style={s.body}>
        <div style={s.banner}>
          {t("modal.mergedFrom", { count: conventions.length, repo: repoFullName ?? "" })}
        </div>

        <FormField label={t("modal.name")} required>
          <TextInput value={name} onChange={setName} mono />
        </FormField>

        <FormField label={t("modal.description")}>
          <TextInput value={description} onChange={setDescription} />
        </FormField>

        <FormField label={t("modal.type")}>
          <SelectInput value={SKILL_TYPE} options={[SKILL_TYPE]} />
        </FormField>

        {/* No "Enabled" toggle here on purpose. `POST /skills` forces any
            non-`manual` source to `enabled: false`, and this body is
            LLM-derived, so it is saved as `extracted` and must be vetted before
            it can reach a prompt. A toggle would have been inert. */}
        <div style={s.vetNotice}>
          <Icon.Shield size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t("modal.vetNotice")}</span>
        </div>

        <FormField label={t("modal.linkAgent")} hint={t("modal.linkAgentHint")}>
          <SelectInput
            value={agentId}
            onChange={setAgentId}
            mono={false}
            options={[
              { value: NO_AGENT, label: t("modal.linkAgentNone") },
              ...(agents ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </FormField>

        <FormField label={t("modal.body")} required>
          <Textarea value={body} onChange={setBody} rows={16} mono />
        </FormField>
      </div>
    </Modal>
  );
}
