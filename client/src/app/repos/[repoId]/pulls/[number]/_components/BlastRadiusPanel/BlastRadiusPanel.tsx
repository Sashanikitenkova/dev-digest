/* BLAST RADIUS — what the PR's changed symbols actually reach.

   Every row here comes from the repo index, never from a model. That is why the
   empty state matters as much as the populated one: an unindexed repo must read
   as "nothing known", not as "nothing impacted". The two are very different
   claims to put in front of someone deciding whether a change is safe. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, Icon, SectionLabel } from "@devdigest/ui";
import type { DownstreamImpact, PrHistoryItem } from "@devdigest/shared";
import { usePrBlast } from "../../../../../../../lib/hooks/blast";
import { s } from "./styles";

function SymbolNode({ impact }: { impact: DownstreamImpact }) {
  const t = useTranslations("blast");
  const [open, setOpen] = React.useState(true);
  const Chevron = open ? Icon.ChevronDown : Icon.ChevronRight;

  return (
    <div>
      <button
        type="button"
        style={s.symbolRow}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Chevron size={13} />
        <Icon.Code size={13} />
        <span style={s.symbolName}>{impact.symbol}()</span>
        <span style={s.callerCount}>{t("callerCount", { count: impact.callers.length })}</span>
      </button>

      {open && (
        <>
          {impact.callers.length > 0 && (
            <ul style={s.callerList}>
              {impact.callers.map((c) => (
                <li key={`${c.file}:${c.line}`} style={s.caller} title={`${c.file}:${c.line}`}>
                  ↳ {c.file}:{c.line}
                </li>
              ))}
            </ul>
          )}
          {(impact.endpoints_affected.length > 0 || impact.crons_affected.length > 0) && (
            <div style={s.chipRow}>
              {impact.endpoints_affected.map((e) => (
                <span key={e} style={s.chip("var(--accent-text, #6ea8fe)")}>
                  <Icon.Globe size={11} />
                  {e}
                </span>
              ))}
              {impact.crons_affected.map((c) => (
                <span key={c} style={s.chip("var(--warn)")}>
                  <Icon.Clock size={11} />
                  {c}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PriorPrs({ history }: { history: PrHistoryItem[] }) {
  const t = useTranslations("brief");
  const [open, setOpen] = React.useState(false);
  const Chevron = open ? Icon.ChevronDown : Icon.ChevronRight;

  return (
    <div style={s.history}>
      <button
        type="button"
        style={s.historyToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon.History size={13} />
        {t("priorPrs", { count: history.length })}
        <span style={{ marginLeft: "auto" }}>
          <Chevron size={14} />
        </span>
      </button>

      {open &&
        (history.length === 0 ? (
          <p style={{ ...s.empty, marginTop: 10 }}>{t("noHistory")}</p>
        ) : (
          <ul style={s.historyList}>
            {history.map((h) => (
              <li key={h.pr_number} style={s.historyItem}>
                <div>
                  #{h.pr_number} {h.title}
                </div>
                <div style={s.historyMeta}>
                  {h.author} · {t("overlap", { count: h.files_overlap.length })}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function BlastRadiusPanel({ prId }: { prId: string | null }) {
  const t = useTranslations("blast");
  const { data, isLoading } = usePrBlast(prId);

  if (isLoading || !data) return null;

  const { blast, history } = data;
  const callerCount = blast.downstream.reduce((n, d) => n + d.callers.length, 0);

  return (
    <section>
      <SectionLabel icon="Workflow">{t("title")}</SectionLabel>

      <div style={s.card}>
        {blast.changed_symbols.length === 0 ? (
          <EmptyState icon="Workflow" title={t("empty.title")} body={t("empty.body")} />
        ) : (
          <>
            <div style={s.statRow}>
              <span style={s.stat}>
                <Icon.Code size={12} />
                <span style={s.statNum}>{blast.changed_symbols.length}</span>
                {t("stat.symbols")}
              </span>
              <span style={s.stat}>
                <Icon.CornerDownRight size={12} />
                <span style={s.statNum}>{callerCount}</span>
                {t("stat.callers")}
              </span>
              <span style={s.stat}>
                <Icon.Globe size={12} />
                <span style={s.statNum}>{blast.impacted_endpoints.length}</span>
                {t("stat.endpoints")}
              </span>
              <span style={s.stat}>
                <Icon.Clock size={12} />
                <span style={s.statNum}>{blast.impacted_crons.length}</span>
                {t("stat.crons")}
              </span>
            </div>

            <div style={s.tree}>
              {blast.downstream.map((d) => (
                <SymbolNode key={d.symbol} impact={d} />
              ))}
            </div>

            {callerCount === 0 && (
              <p style={s.empty}>
                {t("noDownstream", { count: blast.changed_symbols.length })}
              </p>
            )}
          </>
        )}

        <PriorPrs history={history} />
      </div>
    </section>
  );
}
