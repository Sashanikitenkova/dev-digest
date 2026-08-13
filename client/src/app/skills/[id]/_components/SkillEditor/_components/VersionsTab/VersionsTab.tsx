/* Versions tab — immutable body snapshots, newest first, with Diff + Restore.

   Restore is deliberately NOT a rollback: the server re-applies the old body
   through the normal update path, so it lands as a *new* version. History is
   append-only and never rewritten — the confirm copy says so. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, ErrorState, Skeleton } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useRestoreSkillVersion, useSkillVersions } from "../../../../../../../lib/hooks/skills";
import { useToast } from "../../../../../../../lib/toast";
import { diffLines, formatVersionDate } from "./helpers";
import { s } from "./styles";

export function VersionsTab({ skill }: { skill: Skill }) {
  const t = useTranslations("skills");
  const toast = useToast();
  const { data: versions, isLoading, isError, refetch } = useSkillVersions(skill.id);
  const restoreVersion = useRestoreSkillVersion();
  const [openDiff, setOpenDiff] = React.useState<number | null>(null);

  const restore = (version: number) => {
    if (!window.confirm(t("versions.restoreConfirm"))) return;
    restoreVersion.mutate(
      { id: skill.id, version },
      { onSuccess: (data) => toast.success(t("versions.restored", { version: data.version })) },
    );
  };

  return (
    <div style={s.wrap}>
      <h2 style={s.h2}>{t("versions.heading")}</h2>
      <p style={s.subtitle}>{t("versions.subtitle")}</p>

      {isLoading && <Skeleton height={90} />}
      {isError && <ErrorState body={t("versions.loadError")} onRetry={() => refetch()} />}
      {!isLoading && !isError && (versions ?? []).length === 0 && <div style={s.note}>{t("versions.empty")}</div>}

      {(versions ?? []).map((v) => {
        const isCurrent = v.version === skill.version;
        const showing = openDiff === v.version;
        return (
          <div key={v.version} style={s.row}>
            <div style={s.rowHeader}>
              <Badge color="var(--text-secondary)" mono>
                {t("versions.version", { version: v.version })}
              </Badge>
              {isCurrent && <Badge color="var(--accent)">{t("versions.current")}</Badge>}
              <span style={s.when}>{t("versions.createdAt", { date: formatVersionDate(v.created_at) })}</span>
              <div style={s.actions}>
                <Button
                  kind="tertiary"
                  size="sm"
                  icon="Eye"
                  onClick={() => setOpenDiff(showing ? null : v.version)}
                >
                  {showing ? t("versions.hideDiff") : t("versions.diff")}
                </Button>
                {!isCurrent && (
                  <Button
                    kind="secondary"
                    size="sm"
                    icon="History"
                    disabled={restoreVersion.isPending}
                    onClick={() => restore(v.version)}
                  >
                    {t("versions.restore")}
                  </Button>
                )}
              </div>
            </div>
            {showing && (
              <div className="mono" style={s.diff}>
                {diffLines(v.body, skill.body).map((line, i) => (
                  <div key={i} style={s.diffLine(line.kind)}>
                    {(line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ") + line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
