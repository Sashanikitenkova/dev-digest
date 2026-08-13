/* /skills/:id — Skill editor. Left skill list for fast switching (mirrors
   /agents/:id) + the Config/Preview/Versions editor. Tab state lives in ?tab=. */
"use client";

import React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../components/app-shell";
import { SkillCard } from "../_components/SkillCard";
import { typeColor } from "../_components/SkillCard/helpers";
import { SkillEditor, VALID_TABS } from "./_components/SkillEditor";
import {
  useDeleteSkill,
  useSkill,
  useSkills,
  useSkillsStats,
  useUpdateSkill,
} from "../../../lib/hooks/skills";
import { ApiError } from "../../../lib/api";
import { routes } from "../../../lib/routes";
import { s } from "./styles";

export default function SkillEditorPage() {
  const t = useTranslations("skills");
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { id } = params;

  const { data: skills } = useSkills();
  const { data: skillStats } = useSkillsStats();
  const { data: skill, isLoading, isError, error, refetch } = useSkill(id);
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const statsById = React.useMemo(
    () => new Map((skillStats ?? []).map((row) => [row.skill_id, row])),
    [skillStats],
  );

  const tab = VALID_TABS.includes(search.get("tab") ?? "") ? search.get("tab")! : "config";
  const setTab = (next: string) => {
    const sp = new URLSearchParams(search.toString());
    sp.set("tab", next);
    router.replace(`${routes.skill(id)}?${sp.toString()}`);
  };

  const crumb = [
    { label: t("page.crumbLab") },
    { label: t("page.crumbSkills"), href: routes.skills() },
    { label: skill?.name ?? t("detail.crumbSkill") },
  ];

  if (isError || (!isLoading && !skill)) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("detail.notFound.title")}
          body={error instanceof ApiError ? error.message : t("detail.loadError")}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  const onDelete = () => {
    if (!skill) return;
    if (!window.confirm(t("editor.deleteConfirm"))) return;
    del.mutate(skill.id, { onSuccess: () => router.push(routes.skills()) });
  };

  return (
    <AppShell crumb={crumb}>
      <div style={s.layout}>
        <div style={s.leftPane}>
          <div style={s.leftHeader}>
            <h1 style={s.leftTitle}>{t("page.crumbSkills")}</h1>
            <Button kind="primary" size="sm" icon="Plus" onClick={() => router.push(routes.skills())}>
              {t("page.addSkill")}
            </Button>
          </div>
          <div style={s.leftList}>
            {(skills ?? []).map((sk) => (
              <SkillCard
                key={sk.id}
                skill={sk}
                active={sk.id === id}
                {...(statsById.get(sk.id) ? { stats: statsById.get(sk.id)! } : {})}
                onClick={() => router.push(`${routes.skill(sk.id)}?tab=${tab}`)}
                onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
              />
            ))}
          </div>
        </div>

        {isLoading || !skill ? (
          <div style={s.loading}>
            <Skeleton height={24} width={240} />
            <Skeleton height={220} />
          </div>
        ) : (
          <div style={s.editorPane}>
            <div style={s.editorHeader}>
              <Icon.Sparkles size={18} style={{ color: "var(--accent)" }} />
              <h1 style={s.editorTitle}>{skill.name}</h1>
              <Badge color={typeColor(skill.type)}>{t(`listItem.type.${skill.type}`)}</Badge>
              <Badge color="var(--text-secondary)" mono>
                {t("preview.version", { version: skill.version })}
              </Badge>
              {!skill.enabled && <Badge color="var(--text-muted)">{t("preview.disabled")}</Badge>}
              <div style={s.headerActions}>
                <Button kind="danger" size="sm" icon="Trash" onClick={onDelete} disabled={del.isPending}>
                  {t("editor.deleteSkill")}
                </Button>
              </div>
            </div>
            <div style={s.editorScroll}>
              <SkillEditor skill={skill} tab={tab} onTab={setTab} />
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
