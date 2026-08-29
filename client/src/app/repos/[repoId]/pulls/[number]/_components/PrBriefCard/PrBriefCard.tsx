/* PrBriefCard — what this pull request is, why it exists, how risky it is, and
   what to read first. One full-width card at the top of the Overview tab.

   Everything on screen is either server-computed provenance or model output the
   server already validated: each risk and each review-focus row survived a
   reference check against the PR's own changed files, symbols and endpoints, so
   a row that points somewhere is pointing somewhere real. Nothing here is
   re-derived client-side — the card renders exactly what it was handed, as TEXT
   (no markdown, no HTML), and the counts it shows are the rows it drew.

   The five non-happy states all matter and all stay honest: no brief yet is an
   empty state with a generate action, a brief for an older head is a notice
   ABOVE the retained content rather than in place of it, a failed generation
   shows the engine's own message and status, zero grounded focus rows say so in
   a sentence instead of a `(0)` badge, and an empty Risks section says WHICH
   empty it is — nothing raised, or everything raised and nothing groundable. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, Icon, MonoLink, SectionLabel } from "@devdigest/ui";
import {
  usePrBrief,
  useGenerateBrief,
  useRegenerateBrief,
} from "../../../../../../../lib/hooks/brief";
import type {
  PrRiskBriefRecord,
  RiskBriefFocusItem,
  RiskBriefRiskItem,
} from "../../../../../../../lib/types";
import {
  briefErrorText,
  describeReference,
  isBriefStale,
  resolveFocusTarget,
  riskLevelColor,
  risksEmptyReason,
  type FocusTarget,
  type ReferenceKind,
} from "./helpers";
import { s } from "./styles";

interface PrBriefCardProps {
  prId: string | null;
  headSha: string | null | undefined;
  /** "owner/repo" — lets an out-of-diff focus row link to github.com. */
  repoFullName: string | null;
  /** Paths of this PR's changed files: what the in-app diff view can show. */
  changedFiles: readonly string[];
  /** Hands the page a target. The page owns the tab and the navigation. */
  onFocusFile: (file: string, line: number | null) => void;
}

/** `symbol createUser` / `POST /v1/pulls` / `src/app.ts:42` — the row's pointer. */
function useReferenceText(): (label: string, kind: ReferenceKind) => string {
  const t = useTranslations("prBrief");
  return (label, kind) => {
    if (kind === "symbol") return `${t("focus.symbolLabel")} ${label}`;
    if (kind === "endpoint") return `${t("focus.endpointLabel")} ${label}`;
    return label;
  };
}

/** Pointer, separator and summary as ONE element's text, so the row's
    accessible name carries the path, the line and the summary together. */
function RowContent({ pointer, summary }: { pointer: string; summary: string }) {
  return (
    <>
      {pointer ? (
        <span className="mono" style={s.rowRef}>
          {pointer}
        </span>
      ) : null}
      {pointer ? " — " : null}
      <span style={s.rowSummary}>{summary}</span>
    </>
  );
}

function FocusRow({
  item,
  target,
  onFocusFile,
}: {
  item: RiskBriefFocusItem;
  target: FocusTarget;
  onFocusFile: (file: string, line: number | null) => void;
}) {
  const referenceText = useReferenceText();

  if (target.kind === "in-diff") {
    const { file, line } = target;
    return (
      <li style={s.focusRow}>
        <button type="button" style={s.rowButton} onClick={() => onFocusFile(file, line)}>
          <RowContent pointer={referenceText(target.label, "file")} summary={item.summary} />
        </button>
      </li>
    );
  }

  if (target.kind === "github") {
    return (
      <li style={s.focusRow}>
        <MonoLink href={target.href}>
          <RowContent pointer={referenceText(target.label, "file")} summary={item.summary} />
        </MonoLink>
      </li>
    );
  }

  // Non-navigating: a plain span, NOT a hrefless MonoLink — that would render a
  // focusable button with no handler, a control that does nothing.
  return (
    <li style={s.focusRow}>
      <span style={s.rowStatic}>
        <RowContent
          pointer={referenceText(target.label, target.labelKind)}
          summary={item.summary}
        />
      </span>
    </li>
  );
}

function RiskRow({ risk }: { risk: RiskBriefRiskItem }) {
  const t = useTranslations("prBrief");
  const referenceText = useReferenceText();
  const described = describeReference(risk.reference);

  return (
    <li style={s.riskRow}>
      <span style={s.severityTag(riskLevelColor(risk.severity))}>
        {t(`risk.${risk.severity}` as never)}
      </span>
      <span style={s.riskSummary}>{risk.summary}</span>
      {described.kind !== "none" && (
        <span className="mono" style={s.riskRef}>
          {referenceText(described.label, described.kind)}
        </span>
      )}
    </li>
  );
}

/** The brief describes an older commit — shown ABOVE the content it qualifies,
    never instead of it: a brief for the previous head is still mostly true. */
function StaleNotice({ brief }: { brief: PrRiskBriefRecord }) {
  const t = useTranslations("prBrief");
  return (
    <div style={s.staleBanner}>
      <Icon.AlertTriangle size={13} />
      <span>{brief.head_sha ? t("stale", { sha: brief.head_sha }) : t("staleUnknownSha")}</span>
    </div>
  );
}

export function PrBriefCard({
  prId,
  headSha,
  repoFullName,
  changedFiles,
  onFocusFile,
}: PrBriefCardProps) {
  const t = useTranslations("prBrief");
  const { data: brief, isLoading } = usePrBrief(prId);
  const generate = useGenerateBrief(prId);
  const regenerate = useRegenerateBrief(prId);

  // One generation at a time: either mutation in flight disables both controls.
  const busy = generate.isPending || regenerate.isPending;
  const failure = generate.error ?? regenerate.error;
  const errorText = failure ? briefErrorText(failure, t("error.fallback")) : null;

  if (isLoading) return null;

  if (!brief) {
    return (
      <section>
        <SectionLabel icon="Gauge">{t("title")}</SectionLabel>
        <EmptyState
          icon="Gauge"
          title={t("empty.title")}
          body={t("empty.body")}
          cta={t("empty.cta")}
          onCta={() => generate.mutate()}
          ctaLoading={busy}
        />
        {errorText && (
          <div style={s.errorBanner} role="alert">
            <Icon.AlertOctagon size={13} />
            <span>{errorText}</span>
          </div>
        )}
      </section>
    );
  }

  const rows = brief.review_focus.map((item) => ({
    item,
    target: resolveFocusTarget(item.reference, { changedFiles, repoFullName, headSha }),
  }));

  return (
    <section>
      <SectionLabel
        icon="Gauge"
        right={
          <div style={s.headRight}>
            <span style={s.pill(riskLevelColor(brief.risk_level))}>
              {t(`risk.${brief.risk_level}` as never)}
            </span>
            <Button
              kind="ghost"
              size="sm"
              icon="RefreshCw"
              loading={busy}
              disabled={busy}
              onClick={() => regenerate.mutate()}
            >
              {t("regenerate")}
            </Button>
          </div>
        }
      >
        {t("title")}
      </SectionLabel>

      <div style={s.card}>
        {isBriefStale(brief, headSha) && <StaleNotice brief={brief} />}

        {errorText && (
          <div style={s.errorBanner} role="alert">
            <Icon.AlertOctagon size={13} />
            <span>{errorText}</span>
          </div>
        )}

        <div style={s.block}>
          <span style={s.blockLabel}>{t("what")}</span>
          <p style={s.prose}>{brief.what}</p>
        </div>

        <div style={s.block}>
          <span style={s.blockLabel}>{t("why")}</span>
          <p style={s.prose}>{brief.why}</p>
        </div>

        <div style={s.section}>
          <div style={s.sectionHead}>{t("risks.title")}</div>
          {brief.risks.length === 0 ? (
            /* Which empty this is, never just "empty": a brief whose every risk
               was dropped for citing somewhere that is not in this PR must not
               claim no risk was raised. */
            risksEmptyReason(brief.counts) === "all-dropped" ? (
              <p style={s.emptyWarn}>
                {t("risks.allDropped", { proposed: brief.counts.risks_proposed })}
              </p>
            ) : (
              <p style={s.empty}>{t("risks.none")}</p>
            )
          ) : (
            <ul style={s.list}>
              {brief.risks.map((risk, i) => (
                <RiskRow key={`${i}-${risk.summary}`} risk={risk} />
              ))}
            </ul>
          )}
        </div>

        <div style={s.section}>
          <div style={s.sectionHead}>
            {t("focus.title")}
            {/* The badge counts the rows actually drawn — never a `(0)`: zero
                grounded rows is a sentence, because "0" and "we could not
                ground anything" are different claims. */}
            {rows.length > 0 && <span style={s.countBadge}>{rows.length}</span>}
          </div>
          {rows.length === 0 ? (
            <p style={s.empty}>{t("focus.none")}</p>
          ) : (
            <ul style={s.list}>
              {rows.map(({ item, target }, i) => (
                <FocusRow
                  key={`${i}-${target.label}`}
                  item={item}
                  target={target}
                  onFocusFile={onFocusFile}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
