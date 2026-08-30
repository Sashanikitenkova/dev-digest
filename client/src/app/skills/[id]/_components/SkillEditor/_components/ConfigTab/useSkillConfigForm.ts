import React from "react";
import type { Skill, SkillType } from "@devdigest/shared";
import { useUpdateSkill } from "../../../../../../../lib/hooks/skills";
import { useToast } from "../../../../../../../lib/toast";

// Loosely typed so this hook isn't coupled to next-intl's generic
// `useTranslations` return type — callers pass their scoped `t` directly.
type Translate = (key: string, vars?: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Owns the Config tab's local form state (reset whenever `skill.id` changes)
 * and the save mutation, keeping ConfigTab down to layout/markup.
 *
 * Only a changed `body` bumps the version server-side — name/description/type/
 * enabled edits update in place. The UI doesn't try to predict which happened;
 * it renders the version the server returns.
 */
export function useSkillConfigForm(skill: Skill, t: Translate) {
  const toast = useToast();
  const update = useUpdateSkill();
  const [name, setName] = React.useState(skill.name);
  const [description, setDescription] = React.useState(skill.description);
  const [type, setType] = React.useState<SkillType>(skill.type);
  const [body, setBody] = React.useState(skill.body);
  const [enabled, setEnabled] = React.useState(skill.enabled);

  // Reset local form when switching skills in the left list.
  React.useEffect(() => {
    setName(skill.name);
    setDescription(skill.description);
    setType(skill.type);
    setBody(skill.body);
    setEnabled(skill.enabled);
  }, [skill.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () =>
    update.mutate(
      { id: skill.id, patch: { name, description, type, body, enabled } },
      { onSuccess: () => toast.success(t("editor.saved")) },
    );

  return {
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
  };
}
