/* Compare two eval runs — the screen that answers "did that prompt edit help?".

   Two guards sit above the numbers on purpose. If the runs executed different
   case sets, or if a linked skill changed underneath them, the deltas are not
   attributable to the prompt — and a comparison that looks conclusive but is
   not is worse than no comparison at all (SPEC-03 AC-42, AC-43). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Modal, Icon, Skeleton, ErrorState } from "@devdigest/ui";
import { useEvalCompare } from "../../../../../../../lib/hooks/eval";
import { deltaColor, deltaPts, pct, skillsLabel } from "../../helpers";
import { diffPromptLines } from "./helpers";
import { s } from "./styles";

export function CompareRunsModal({
  aId,
  bId,
  onClose,
}: {
  aId: string;
  bId: string;
  onClose: () => void;
}) {
  const t = useTranslations("eval");
  const { data, isLoading, isError, refetch } = useEvalCompare(aId, bId);

  const body = () => {
    if (isLoading) return <Skeleton height={120} />;
    if (isError || !data) return <ErrorState body={t("agentPage.loadError")} onRetry={() => refetch()} />;

    const { a, b, delta } = data;
    const tile = (
      label: string,
      before: number | null,
      after: number | null,
      deltaValue: number | null,
      suffix = "",
    ) => (
      <div style={s.tile}>
        <div style={s.tileLabel}>{label}</div>
        <div style={s.tileRow}>
          <span style={s.before}>{pct(before) ?? "—"}</span>
          <span style={s.arrow}>→</span>
          <span style={s.after}>{pct(after) ?? "—"}</span>
          <span style={s.delta(deltaColor(deltaValue))}>{deltaPts(deltaValue) ?? ""}</span>
        </div>
        {suffix}
      </div>
    );

    const aSkills = skillsLabel(a.skills_snapshot);
    const bSkills = skillsLabel(b.skills_snapshot);

    return (
      <>
        {data.case_set_mismatch && (
          <div style={s.warn}>
            <Icon.AlertOctagon size={16} />
            <span>{t("compare.mismatchWarning")}</span>
          </div>
        )}
        {data.skills_changed && (
          <div style={s.note}>
            <Icon.AlertTriangle size={16} />
            <span>{t("compare.skillsChanged")}</span>
          </div>
        )}

        <div style={s.tiles}>
          {tile(t("compare.recall"), a.recall, b.recall, delta.recall)}
          {tile(t("compare.precision"), a.precision, b.precision, delta.precision)}
          {tile(t("compare.citation"), a.citation_accuracy, b.citation_accuracy, delta.citation_accuracy)}
          <div style={s.tile}>
            <div style={s.tileLabel}>{t("compare.cost")}</div>
            <div style={s.tileRow}>
              <span style={s.before}>{a.cost_usd === null ? "—" : `$${a.cost_usd.toFixed(3)}`}</span>
              <span style={s.arrow}>→</span>
              <span style={s.after}>
                {b.cost_usd === null ? "—" : `$${b.cost_usd.toFixed(3)}`}
              </span>
            </div>
          </div>
        </div>

        <div style={s.sectionLabel}>
          <Icon.FileText size={13} />
          {t("compare.promptDiff")}
        </div>
        <div style={s.legend}>
          <span style={s.legendItem}>
            <span style={s.chip("color-mix(in srgb, var(--crit) 40%, transparent)")} />
            {t("compare.oldLabel", { version: a.agent_version ?? 1 })}
          </span>
          <span style={s.legendItem}>
            <span style={s.chip("color-mix(in srgb, var(--ok) 40%, transparent)")} />
            {t("compare.newLabel", { version: b.agent_version ?? 1 })}
          </span>
        </div>
        <div style={s.diff}>
          {diffPromptLines(a.system_prompt, b.system_prompt).map((line, i) => (
            <span
              key={i}
              style={line.kind === "added" ? s.added : line.kind === "removed" ? s.removed : s.same}
            >
              {line.text || " "}
            </span>
          ))}
        </div>

        <div style={s.sectionLabel}>
          <Icon.Sparkles size={13} />
          {t("compare.skillsHeading")}
        </div>
        <div style={s.skills}>
          <div>
            {t("compare.oldLabel", { version: a.agent_version ?? 1 })}:{" "}
            {aSkills ?? t("compare.noSkills")}
          </div>
          <div>
            {t("compare.newLabel", { version: b.agent_version ?? 1 })}:{" "}
            {bSkills ?? t("compare.noSkills")}
          </div>
        </div>
      </>
    );
  };

  return (
    <Modal
      onClose={onClose}
      title={t("compare.title", {
        a: data?.a.agent_version ?? 1,
        b: data?.b.agent_version ?? 1,
      })}
      subtitle={t("compare.subtitle")}
      width={760}
    >
      {body()}
    </Modal>
  );
}
