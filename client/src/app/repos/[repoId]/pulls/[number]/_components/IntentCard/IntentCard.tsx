/* The PR's derived intent, shown ABOVE the review results so the reader can
   check what the system thought the PR was for before trusting what it says
   about the code.

   The source ledger is the honest part of this card. Every input the classifier
   could have used is listed — including the ones it could NOT get, with the
   reason. An external link is never opened, a plan that is not in the clone is
   never guessed at, and both show up as dashed "missing" chips rather than
   quietly vanishing. Confidence is computed server-side from exactly that
   ledger, so a thin card and a low bar always agree. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, EmptyState, Icon, ProgressBar, SectionLabel } from "@devdigest/ui";
import type { Risk } from "@devdigest/shared";
import { usePrIntent, useDetectIntent } from "../../../../../../../lib/hooks/intent";
import { usePrRisks } from "../../../../../../../lib/hooks/risks";
import type { IntentSource } from "../../../../../../../lib/types";
import {
  confidenceColor,
  isStale,
  riskColor,
  riskIcon,
  sourceLabel,
  splitSources,
} from "./helpers";
import { s } from "./styles";

function SourceChip({ source, missing }: { source: IntentSource; missing?: boolean }) {
  const t = useTranslations("intent");
  // The reason is the whole point of a missing chip — show it inline, not just
  // on hover, so it survives a screenshot and a keyboard-only reader.
  const reason = source.reason ? t(`reason.${source.reason}` as never) : null;
  return (
    <span
      style={{ ...s.chip, ...(missing ? s.chipMissing : null) }}
      title={source.ref ?? undefined}
    >
      {sourceLabel(source)}
      {missing && reason ? ` — ${reason}` : null}
    </span>
  );
}

function ScopeColumn({
  icon,
  title,
  entries,
  empty,
}: {
  icon: "Check" | "X";
  title: string;
  entries: string[];
  empty: string;
}) {
  const I = Icon[icon];
  return (
    <div style={s.scopeCol}>
      <div style={s.scopeHead}>
        <I size={12} />
        {title}
      </div>
      {entries.length === 0 ? (
        <span style={s.scopeEmpty}>{empty}</span>
      ) : (
        <ul style={s.scopeList}>
          {entries.map((e) => (
            <li key={e} style={s.scopeItem}>
              · {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* RISK AREAS — deterministic, derived from the diff rather than from a model.
   Each chip carries the files that produced it in its tooltip, so a reader can
   check the claim instead of trusting it. */
function RiskAreas({ risks }: { risks: Risk[] }) {
  const t = useTranslations("intent");
  if (risks.length === 0) return null;
  return (
    <div style={s.risks}>
      <span style={s.sourcesLabel}>{t("riskAreas")}</span>
      <div style={s.riskChips}>
        {risks.map((r) => {
          const color = riskColor(r.severity);
          const I = Icon[riskIcon(r)];
          return (
            <span
              key={`${r.kind}-${r.title}`}
              style={s.riskChip(color)}
              title={`${r.explanation}\n\n${r.file_refs.join("\n")}`}
            >
              <span style={s.riskIcon(color)}>
                <I size={12} />
              </span>
              {r.title}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function IntentCard({
  prId,
  headSha,
}: {
  prId: string | null;
  headSha: string | null | undefined;
}) {
  const t = useTranslations("intent");
  const { data: intent, isLoading } = usePrIntent(prId);
  const { data: risks } = usePrRisks(prId);
  const detect = useDetectIntent(prId);

  if (isLoading) return null;

  if (!intent) {
    return (
      <section>
        <SectionLabel icon="Target">{t("title")}</SectionLabel>
        <EmptyState
          icon="Target"
          title={t("empty.title")}
          body={t("empty.body")}
          cta={t("detect")}
          onCta={() => detect.mutate()}
          ctaLoading={detect.isPending}
        />
      </section>
    );
  }

  const pct = Math.round((intent.confidence ?? 0) * 100);
  const level = intent.confidence_level ?? "low";
  const { used, missing } = splitSources(intent.sources ?? []);
  const stale = isStale(intent, headSha);

  return (
    <section>
      <SectionLabel
        icon="Target"
        right={
          <Button
            kind="ghost"
            size="sm"
            icon="RefreshCw"
            loading={detect.isPending}
            disabled={detect.isPending}
            onClick={() => detect.mutate()}
          >
            {t("redetect")}
          </Button>
        }
      >
        {t("title")}
      </SectionLabel>

      <div style={s.card}>
        {stale && (
          <div style={s.staleBanner}>
            <Icon.AlertTriangle size={13} />
            {t("stale")}
          </div>
        )}

        <p style={s.intent}>&ldquo;{intent.intent}&rdquo;</p>

        <div style={s.confidenceRow}>
          <span>{t(`confidence.${level}` as never)}</span>
          <div style={s.bar}>
            <ProgressBar value={pct} color={confidenceColor(level)} height={5} />
          </div>
          <span>{pct}%</span>
        </div>

        <div style={s.scopeGrid}>
          <ScopeColumn
            icon="Check"
            title={t("inScope")}
            entries={intent.in_scope}
            empty={t("noneListed")}
          />
          <ScopeColumn
            icon="X"
            title={t("outOfScope")}
            entries={intent.out_of_scope}
            empty={t("noneListed")}
          />
        </div>

        <RiskAreas risks={risks?.risks ?? []} />

        <div style={s.sources}>
          <span style={s.sourcesLabel}>{t("sources")}</span>
          {used.map((src) => (
            <SourceChip key={`${src.kind}-${src.ref ?? ""}`} source={src} />
          ))}
          {missing.map((src) => (
            <SourceChip key={`m-${src.kind}-${src.ref ?? ""}`} source={src} missing />
          ))}
        </div>

        {intent.model && (
          <div style={s.footnote}>
            <span>{t("classifiedBy", { model: intent.model })}</span>
          </div>
        )}
      </div>
    </section>
  );
}
