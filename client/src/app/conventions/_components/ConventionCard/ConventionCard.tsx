/* One extracted convention: the rule, its grounded evidence (file:line + the
   real snippet), a confidence bar, and Accept/Reject.

   The evidence block is the point of the card. Every row on screen cited a line
   that was verified against the clone at extraction time, so the `file:line`
   link is safe to hand to GitHub — it is not a model guess. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, ProgressBar } from "@devdigest/ui";
import type { ConventionCandidate } from "@devdigest/shared";
import { githubBlobUrl } from "../../../../lib/routes";
import { confidenceColor, evidenceLabel } from "./helpers";
import { s } from "./styles";

export function ConventionCard({
  convention,
  repo,
  onAccept,
  onReject,
  busy,
}: {
  convention: ConventionCandidate;
  repo: { owner: string; name: string; default_branch: string } | null;
  onAccept: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const t = useTranslations("conventions");
  const [copied, setCopied] = React.useState(false);

  const accepted = convention.status === "accepted";
  const rejected = convention.status === "rejected";
  const pct = Math.round((convention.confidence ?? 0) * 100);
  const label = evidenceLabel(convention);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(convention.evidence_snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (non-secure context) — silent, non-critical */
    }
  };

  return (
    <div style={{ ...s.card, ...(accepted ? s.cardAccepted : null), ...(rejected ? s.cardRejected : null) }}>
      <div style={s.main}>
        <div style={s.ruleRow}>
          {convention.category && <span style={s.category}>{convention.category}</span>}
          <h3 style={s.rule}>{convention.rule}</h3>
        </div>

        <div style={s.evidence}>
          <div style={s.evidenceHead}>
            {repo && convention.evidence_path ? (
              <a
                href={githubBlobUrl(repo, convention.evidence_path, convention.evidence_line)}
                target="_blank"
                rel="noreferrer"
                style={s.evidenceLink}
                title={t("card.viewOnGitHub", { path: convention.evidence_path })}
              >
                {label}
                <Icon.ExternalLink size={11} style={{ marginLeft: 5, opacity: 0.7 }} />
              </a>
            ) : (
              <span style={s.evidencePath}>{label}</span>
            )}
            <button
              onClick={copy}
              style={s.copyBtn}
              aria-label={t("card.copy")}
              title={copied ? t("card.copied") : t("card.copy")}
            >
              <Icon.Copy size={12} />
            </button>
          </div>
          <pre style={s.snippet}>{convention.evidence_snippet}</pre>
        </div>

        <div style={s.confidenceRow}>
          <span style={s.confidenceLabel}>{t("card.confidence")}</span>
          <div style={s.confidenceBar}>
            <ProgressBar value={pct} color={confidenceColor(convention.confidence ?? 0)} height={5} />
          </div>
          <span style={s.confidencePct}>{pct}%</span>
        </div>
      </div>

      <div style={s.actions}>
        <Button
          kind={accepted ? "primary" : "secondary"}
          size="sm"
          icon="Check"
          disabled={busy}
          onClick={onAccept}
        >
          {accepted ? t("card.accepted") : t("card.accept")}
        </Button>
        <Button kind="ghost" size="sm" icon="X" disabled={busy} onClick={onReject}>
          {rejected ? t("card.rejected") : t("card.reject")}
        </Button>
      </div>
    </div>
  );
}
