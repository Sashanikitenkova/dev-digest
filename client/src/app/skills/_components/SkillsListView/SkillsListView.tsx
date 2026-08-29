/* /skills — Skills list. Card grid + side preview pane. "Add Skill ▾" offers
   *Create from scratch* (writes a blank skill and opens the editor) or
   *Import from file* (opens the ImportSkillDrawer overlay — not a route). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Dropdown,
  EmptyState,
  ErrorState,
  Icon,
  Markdown,
  Skeleton,
} from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import {
  useCreateSkill,
  useSkills,
  useSkillsStats,
  useUpdateSkill,
} from "../../../../lib/hooks/skills";
import { routes } from "../../../../lib/routes";
import { SkillCard } from "../SkillCard";
import { filterSkills, isUntrusted, typeColor } from "../SkillCard/helpers";
import { ImportSkillDrawer } from "../ImportSkillDrawer";
import { NEW_SKILL_TYPE } from "./constants";
import { selectedSkill } from "./helpers";
import { s } from "./styles";

export function SkillsListView() {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data: skills, isLoading, isError, refetch } = useSkills();
  // Separate query on purpose: stats are slower to compute than the list, and
  // the cards must render immediately rather than block on the footer numbers.
  const { data: stats } = useSkillsStats();
  const update = useUpdateSkill();
  const create = useCreateSkill();
  const [search, setSearch] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const all = skills ?? [];
  const list = filterSkills(all, search);
  const selected = selectedSkill(all, selectedId);
  const statsById = React.useMemo(
    () => new Map((stats ?? []).map((row) => [row.skill_id, row])),
    [stats],
  );

  const createFromScratch = () =>
    create.mutate(
      {
        name: t("editor.newSkill"),
        description: "",
        type: NEW_SKILL_TYPE,
        // A starter scaffold, not "" — POST /skills enforces a non-empty body
        // (`body: z.string().min(1)`), so a blank create would 400.
        body: t("editor.newSkillBody"),
        enabled: true,
      },
      { onSuccess: (skill) => router.push(routes.skill(skill.id)) },
    );

  return (
    <AppShell crumb={[{ label: t("page.crumbLab") }, { label: t("page.crumbSkills") }]}>
      {importing && (
        <ImportSkillDrawer
          onClose={() => setImporting(false)}
          onImported={(skill) => setSelectedId(skill.id)}
        />
      )}
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>{t("page.heading")}</h1>
          </div>
          <div style={s.search}>
            <Icon.Search size={13} style={s.searchIcon} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("page.searchPlaceholder")}
              aria-label={t("page.searchPlaceholder")}
              style={s.searchInput}
            />
          </div>
          <Dropdown
            width={220}
            align="right"
            trigger={
              <Button kind="primary" size="sm" icon="Plus" iconRight="ChevronDown">
                {t("page.addSkill")}
              </Button>
            }
            items={[
              { label: t("editor.createFromScratch"), icon: "Edit", onClick: createFromScratch },
              { divider: true },
              { label: t("page.menu.fromFile"), icon: "Upload", onClick: () => setImporting(true) },
            ]}
          />
        </div>

        {isLoading && (
          <div style={s.grid}>
            <Skeleton height={120} />
            <Skeleton height={120} />
            <Skeleton height={120} />
          </div>
        )}
        {isError && <ErrorState body={t("page.loadError")} onRetry={() => refetch()} />}
        {!isLoading && !isError && list.length === 0 && (
          <EmptyState
            icon="Sparkles"
            title={t("page.empty.title")}
            body={t("page.empty.body")}
            cta={t("page.empty.cta")}
            onCta={() => setImporting(true)}
          />
        )}

        {list.length > 0 && (
          <div style={s.columns}>
            <div style={s.gridCol}>
              <div style={s.grid}>
                {list.map((sk) => (
                  <SkillCard
                    key={sk.id}
                    skill={sk}
                    active={sk.id === selectedId}
                    {...(statsById.get(sk.id) ? { stats: statsById.get(sk.id)! } : {})}
                    onClick={() => setSelectedId(sk.id)}
                    onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
                  />
                ))}
              </div>
            </div>
            <aside style={s.preview}>
              {!selected ? (
                <EmptyState
                  icon="Eye"
                  title={t("page.selectPrompt.title")}
                  body={t("page.selectPrompt.body")}
                />
              ) : (
                <>
                  <div style={s.previewHeader}>
                    <Icon.Sparkles size={15} style={{ color: "var(--accent)" }} />
                    <span style={s.previewName}>{selected.name}</span>
                  </div>
                  <div style={s.previewBadges}>
                    <Badge color={typeColor(selected.type)}>{t(`listItem.type.${selected.type}`)}</Badge>
                    <Badge color="var(--text-muted)">{t(`listItem.source.${selected.source}`)}</Badge>
                    <Badge color="var(--text-secondary)" mono>
                      {t("preview.version", { version: selected.version })}
                    </Badge>
                    <Badge color={selected.enabled ? "var(--accent)" : "var(--text-muted)"}>
                      {selected.enabled ? t("preview.enabled") : t("preview.disabled")}
                    </Badge>
                  </div>
                  {isUntrusted(selected.source) && (
                    <div style={s.untrusted}>
                      <Icon.Shield size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{t("preview.untrustedNotice")}</span>
                    </div>
                  )}
                  <div style={s.previewBody}>
                    <Markdown>{selected.body}</Markdown>
                  </div>
                  <div style={s.previewActions}>
                    <Button
                      kind="secondary"
                      size="sm"
                      icon="Edit"
                      onClick={() => router.push(routes.skill(selected.id))}
                    >
                      {t("preview.edit")}
                    </Button>
                  </div>
                </>
              )}
            </aside>
          </div>
        )}
      </div>
    </AppShell>
  );
}
