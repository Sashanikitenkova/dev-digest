/* FindingCard — ported from findings.jsx (createElement → TSX).
   Severity icon+label, category, file:line, confidence, markdown rationale +
   suggestion, accept/dismiss actions. Accept/dismiss reflect persisted
   timestamps. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Icon,
  SeverityBadge,
  CategoryTag,
  MonoLink,
  ConfidenceNum,
  Button,
  Markdown,
  type Severity,
  type Category,
} from "@devdigest/ui";
import type { FindingRecord, FindingActionKind } from "@devdigest/shared";
import { SEV_COLOR, SEV_COLOR_FALLBACK } from "./constants";
import { lineLabel } from "./helpers";
import { githubBlobUrl } from "../../../../../../../lib/github-urls";
import { s } from "./styles";

export function FindingCard({
  f,
  focused,
  defaultExpanded,
  onAction,
  onCreateEvalCase,
  inEvalSet,
  evalPending,
  pending,
  repoFullName,
  headSha,
  isTarget,
}: {
  f: FindingRecord;
  focused?: boolean;
  defaultExpanded?: boolean;
  /** This is the ?finding= deep-link target: expand and scroll into view. */
  isTarget?: boolean;
  onAction?: (action: FindingActionKind, reply?: string) => void;
  /**
   * Freeze this finding into an eval case (SPEC-03).
   *
   * A separate prop rather than another `FindingActionKind`: that enum is a
   * shared Zod contract whose values map 1:1 onto `POST /findings/:id/<action>`
   * route paths, so widening it to carry a UI-only action would invent an
   * endpoint that does not exist.
   */
  onCreateEvalCase?: () => void;
  /** This finding already has an eval case — the control reads as done, not new. */
  inEvalSet?: boolean;
  evalPending?: boolean;
  pending?: boolean;
  repoFullName?: string | null;
  headSha?: string | null;
}) {
  const t = useTranslations("prReview");
  const [expanded, setExpanded] = React.useState(defaultExpanded ?? false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // `expanded` is uncontrolled, so a parent can't open this card by re-rendering
  // it — the deep link has to push it open from here, on mount or when the URL
  // target changes to this card.
  React.useEffect(() => {
    if (!isTarget) return;
    setExpanded(true);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isTarget]);

  const sevColor = SEV_COLOR[f.severity] ?? SEV_COLOR_FALLBACK;
  const fileHref =
    repoFullName && headSha
      ? githubBlobUrl(repoFullName, headSha, f.file, f.start_line, f.end_line)
      : undefined;
  const accepted = !!f.accepted_at;
  const dismissed = !!f.dismissed_at;
  const muted = accepted || dismissed;

  return (
    <div ref={rootRef} data-finding-id={f.id} style={s.card(!!focused, sevColor, muted)}>
      <div onClick={() => setExpanded((e) => !e)} style={s.header}>
        <div style={s.badgeWrap}>
          <SeverityBadge severity={f.severity as Severity} compact />
        </div>
        <div style={s.headerMain}>
          <div style={s.titleRow}>
            <span style={s.title(muted, dismissed)}>{f.title}</span>
            <CategoryTag category={f.category as Category} />
            {accepted && <span style={s.acceptedTag}>{t("finding.accepted")}</span>}
            {dismissed && <span style={s.dismissedTag}>{t("finding.dismissed")}</span>}
            {f.out_of_scope && (
              <span style={s.outOfScopeTag} title={f.scope_note ?? undefined}>
                {t("finding.outOfScope")}
              </span>
            )}
          </div>
          <div style={s.metaRow}>
            <MonoLink href={fileHref}>
              {f.file}:{lineLabel(f)}
            </MonoLink>
            <ConfidenceNum value={f.confidence} />
          </div>
        </div>
        <Icon.ChevronDown size={16} style={s.chevron(expanded)} />
      </div>

      {expanded && (
        <div style={s.body}>
          <div style={s.prose}>
            <Markdown>{f.rationale}</Markdown>
          </div>
          {f.suggestion && (
            <div style={s.suggestionWrap}>
              <div style={s.suggestionLabel}>{t("finding.suggestedFix")}</div>
              <div style={s.prose}>
                <Markdown>{f.suggestion}</Markdown>
              </div>
            </div>
          )}

          <div style={s.actions}>
            <Button
              kind="secondary"
              size="sm"
              icon="Check"
              disabled={pending}
              active={accepted}
              onClick={() => onAction?.("accept")}
            >
              {t("finding.accept")}
            </Button>
            <Button
              kind="ghost"
              size="sm"
              icon="X"
              disabled={pending}
              active={dismissed}
              onClick={() => onAction?.("dismiss")}
            >
              {t("finding.dismiss")}
            </Button>
            {onCreateEvalCase && (
              <Button
                kind="ghost"
                size="sm"
                icon="FlaskConical"
                // Only a decided finding is a label: an eval case records a
                // judgement the reviewer already made, so the control stays
                // disabled until accept or dismiss has been clicked.
                disabled={evalPending || inEvalSet || !muted}
                active={inEvalSet}
                title={muted ? undefined : t("finding.evalNeedsDecision")}
                onClick={() => onCreateEvalCase()}
              >
                {inEvalSet ? t("finding.inEvalSet") : t("finding.turnIntoEvalCase")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
