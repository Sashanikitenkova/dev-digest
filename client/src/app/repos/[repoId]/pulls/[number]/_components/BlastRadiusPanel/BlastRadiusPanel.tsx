/* BLAST RADIUS — what the PR's changed symbols actually reach.

   Every row here comes from the repo index, never from a model. That is why the
   empty state matters as much as the populated one: an unindexed repo must read
   as "nothing known", not as "nothing impacted". The two are very different
   claims to put in front of someone deciding whether a change is safe.

   The same reasoning gives a PARTIAL index its own state. A partial index has
   produced real results, so hiding them behind a caveat would be its own wrong
   answer — the banner goes above the map, never in place of it. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { EmptyState, Icon, MonoLink, SectionLabel } from "@devdigest/ui";
import type {
  AffectedEndpoint,
  BlastIndexInfo,
  DownstreamImpact,
  PrHistoryItem,
} from "@devdigest/shared";
import { usePrBlast } from "../../../../../../../lib/hooks/blast";
import { useResyncRepoIntel } from "../../../../../../../lib/hooks/repo-intel";
import { githubBlobUrl } from "../../../../../../../lib/github-urls";
import { BlastGraph } from "./BlastGraph";
import { s } from "./styles";

/** Where a caller's `file:line` points. Undefined when no real link is possible. */
type LinkFor = (file: string, line: number) => string | undefined;

/**
 * Endpoint and cron chips, split by how far the evidence reached.
 *
 * Depth 1 (a caller, or a file that imports the changed file directly) shows
 * inline. Depth 2 is true but weak — through a barrel file every module reaches
 * the app root in two hops — so it collapses behind a disclosure instead of
 * diluting the direct hits it sits next to.
 */
function ImpactChips({
  endpoints,
  crons,
}: {
  endpoints: AffectedEndpoint[];
  crons: AffectedEndpoint[];
}) {
  const t = useTranslations("blast");
  const [showIndirect, setShowIndirect] = React.useState(false);

  const direct = [
    ...endpoints.filter((e) => e.depth <= 1).map((e) => ({ ...e, cron: false })),
    ...crons.filter((c) => c.depth <= 1).map((c) => ({ ...c, cron: true })),
  ];
  const indirect = [
    ...endpoints.filter((e) => e.depth > 1).map((e) => ({ ...e, cron: false })),
    ...crons.filter((c) => c.depth > 1).map((c) => ({ ...c, cron: true })),
  ];

  if (direct.length === 0 && indirect.length === 0) return null;

  const chip = (e: { endpoint: string; cron: boolean }, dim: boolean) => (
    <span
      key={e.endpoint}
      style={{
        ...s.chip(e.cron ? "var(--warn)" : "var(--accent-text, #6ea8fe)"),
        ...(dim ? s.chipDim : null),
      }}
    >
      {e.cron ? <Icon.Clock size={11} /> : <Icon.Globe size={11} />}
      {e.endpoint}
    </span>
  );

  return (
    <div style={s.chipRow}>
      {direct.map((e) => chip(e, false))}
      {indirect.length > 0 &&
        (showIndirect ? (
          indirect.map((e) => chip(e, true))
        ) : (
          <button
            type="button"
            style={s.chipMore}
            title={t("chip.indirectHint")}
            onClick={() => setShowIndirect(true)}
          >
            {t("chip.indirect", { count: indirect.length })}
          </button>
        ))}
    </div>
  );
}

function SymbolNode({ impact, linkFor }: { impact: DownstreamImpact; linkFor: LinkFor }) {
  const t = useTranslations("blast");
  const [open, setOpen] = React.useState(true);
  const Chevron = open ? Icon.ChevronDown : Icon.ChevronRight;
  const truncated = impact.caller_total > impact.callers.length;

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
        <span style={s.callerCount}>
          {truncated
            ? t("callerCountOf", { shown: impact.callers.length, total: impact.caller_total })
            : t("callerCount", { count: impact.callers.length })}
        </span>
      </button>

      {open && (
        <>
          {impact.callers.length > 0 && (
            <ul style={s.callerList}>
              {impact.callers.map((c) => (
                <li key={`${c.file}:${c.line}`} style={s.caller} title={`${c.file}:${c.line}`}>
                  ↳{" "}
                  <MonoLink href={linkFor(c.file, c.line)}>
                    {c.file}:{c.line}
                  </MonoLink>
                </li>
              ))}
            </ul>
          )}
          <ImpactChips
            endpoints={impact.endpoints_affected}
            crons={impact.crons_affected}
          />
        </>
      )}
    </div>
  );
}

/** Partial / failed index caveat. Rendered ABOVE the map it qualifies. */
function IndexBanner({ index, onReindex }: { index: BlastIndexInfo; onReindex?: () => void }) {
  const t = useTranslations("blast");
  const failed = index.status === "failed";

  return (
    <div style={s.banner(failed ? "var(--danger, #f87171)" : "var(--warn)")}>
      <span style={s.bannerHead}>
        <Icon.AlertTriangle size={13} />
        {t(failed ? "partial.failedTitle" : "partial.title")}
      </span>
      <span style={s.bannerBody}>{t(failed ? "partial.failedBody" : "partial.body")}</span>
      <span style={s.bannerMeta}>
        {t("partial.files", { count: index.files_indexed })}
        {index.reason ? ` · ${t("partial.reason", { reason: index.reason })}` : ""}
      </span>
      {onReindex && (
        <button type="button" style={s.bannerCta} onClick={onReindex}>
          {t("partial.cta")}
        </button>
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

export function BlastRadiusPanel({
  prId,
  repoId,
  repoFullName,
  headSha,
}: {
  prId: string | null;
  repoId?: string | null;
  /** "owner/repo" — null until the repo loads; without it a caller can't link. */
  repoFullName?: string | null;
  headSha?: string | null;
}) {
  const t = useTranslations("blast");
  const { data, isLoading } = usePrBlast(prId);
  const [view, setView] = React.useState<"tree" | "graph">("tree");
  const resync = useResyncRepoIntel(repoId);

  /* Callers are ordinary repo files, usually NOT part of this PR's diff, so the
     Files-changed tab cannot show them. GitHub's blob view pinned to the PR's
     head sha is the only target that works for every caller. A missing repo or
     sha degrades to plain text rather than a dead link — same as FindingCard. */
  const linkFor = React.useCallback<LinkFor>(
    (file, line) =>
      repoFullName && headSha ? githubBlobUrl(repoFullName, headSha, file, line) : undefined,
    [repoFullName, headSha],
  );

  if (isLoading || !data) return null;

  const { blast, history } = data;
  const callerCount = blast.downstream.reduce((n, d) => n + d.callers.length, 0);
  const indexed = blast.index.status !== "missing";
  const reindex = repoId ? () => resync.mutate() : undefined;

  return (
    <section>
      <SectionLabel icon="Workflow">{t("title")}</SectionLabel>

      <div style={s.card}>
        {!indexed || blast.changed_symbols.length === 0 ? (
          <EmptyState
            icon="Workflow"
            title={t("empty.title")}
            body={t("empty.body")}
            cta={!indexed && reindex ? t("empty.cta") : undefined}
            onCta={!indexed ? reindex : undefined}
            ctaLoading={resync.isPending}
          />
        ) : (
          <>
            {(blast.index.status === "partial" || blast.index.status === "failed") && (
              <IndexBanner index={blast.index} onReindex={reindex} />
            )}

            <div style={s.headRow}>
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

              <div style={s.toggle} role="group" aria-label={t("view.label")}>
                {(["tree", "graph"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    style={s.toggleBtn(view === v)}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    {t(`view.${v}`)}
                  </button>
                ))}
              </div>
            </div>

            {view === "tree" ? (
              <div style={s.tree}>
                {blast.downstream.map((d) => (
                  <SymbolNode key={d.symbol} impact={d} linkFor={linkFor} />
                ))}
              </div>
            ) : (
              <BlastGraph downstream={blast.downstream} />
            )}

            {callerCount === 0 && (
              <p style={s.empty}>{t("noDownstream", { count: blast.changed_symbols.length })}</p>
            )}
          </>
        )}

        <PriorPrs history={history} />
      </div>
    </section>
  );
}
