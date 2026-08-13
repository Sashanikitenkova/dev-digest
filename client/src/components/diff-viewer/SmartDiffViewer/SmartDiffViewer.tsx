/* SmartDiffViewer — the reviewer-ordered diff. Renders the PR's changed files
   grouped core → wiring → boilerplate so business logic is read first and
   generated output stays collapsed.

   Display-only: the grouping is computed server-side (GET /pulls/:id/smart-diff,
   deterministic, no model call) and findings arrive as props. This component
   fetches nothing. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { FindingRecord, SmartDiff, SmartDiffGroup, SmartDiffRole } from "@devdigest/shared";
import type { PrFile } from "@/lib/types";
import { type DiffCommentApi } from "../comments";
import { s, chevronFor } from "../styles";
import { FileCard } from "../FileCard";
import { ROLE_META, ROLE_ORDER } from "./constants";
import { sd } from "./styles";

export interface SmartDiffViewerProps {
  smartDiff: SmartDiff;
  /** The full PrFile list — smart-diff carries stats, the patch text lives here. */
  files: PrFile[];
  /** Findings of the latest review round, bucketed by file path. */
  findingsByPath?: Map<string, FindingRecord[]>;
  commenting?: DiffCommentApi;
  /** Makes the per-line severity tags clickable — the PR page turns this into a
   *  soft navigation to the Findings tab, targeting that finding. */
  onSelectFinding?: (id: string) => void;
}

/** A scroll request: the nonce is what lets the same line be re-targeted. */
interface JumpTarget {
  path: string;
  line: number;
  nonce: number;
}

export function SmartDiffViewer({
  smartDiff,
  files,
  findingsByPath,
  commenting,
  onSelectFinding,
}: SmartDiffViewerProps) {
  const t = useTranslations("prReview");
  const [jump, setJump] = React.useState<JumpTarget | null>(null);

  const patchByPath = React.useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const handleJump = React.useCallback((path: string, line: number) => {
    setJump((prev) => ({ path, line, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Render in a fixed order regardless of how the API happened to order groups,
  // so the layout never depends on server iteration order.
  const groups = React.useMemo(
    () =>
      ROLE_ORDER.map(
        (role) =>
          smartDiff.groups.find((g) => g.role === role) ?? { role, files: [] as SmartDiffGroup["files"] }
      ),
    [smartDiff.groups]
  );

  if (files.length === 0) {
    return <div style={s.empty}>{t("smartDiff.noChangedFiles")}</div>;
  }

  return (
    <div style={sd.wrap}>
      {smartDiff.split_suggestion.too_big && (
        <SplitSuggestion suggestion={smartDiff.split_suggestion} />
      )}
      {groups.map((group) => (
        <RoleGroup
          key={group.role}
          group={group}
          patchByPath={patchByPath}
          findingsByPath={findingsByPath}
          commenting={commenting}
          jump={jump}
          onJump={handleJump}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </div>
  );
}

function RoleGroup({
  group,
  patchByPath,
  findingsByPath,
  commenting,
  jump,
  onJump,
  onSelectFinding,
}: {
  group: SmartDiffGroup;
  patchByPath: Map<string, PrFile>;
  findingsByPath?: Map<string, FindingRecord[]>;
  commenting?: DiffCommentApi;
  jump: JumpTarget | null;
  onJump: (path: string, line: number) => void;
  onSelectFinding?: (id: string) => void;
}) {
  const t = useTranslations("prReview");
  const meta = ROLE_META[group.role as SmartDiffRole];
  const [open, setOpen] = React.useState(!meta.collapsed);

  // A jump into a collapsed group must open the group too, or the FileCard it
  // targets is never mounted and the scroll silently does nothing.
  React.useEffect(() => {
    if (jump && group.files.some((f) => f.path === jump.path)) setOpen(true);
  }, [jump, group.files]);

  return (
    <section style={sd.group}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={sd.groupHeader}
      >
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <span style={sd.swatch(meta.color)} />
        <span style={sd.groupLabel}>{t(meta.labelKey)}</span>
        <span style={sd.groupBlurb}>{t(meta.blurbKey)}</span>
        <span style={sd.groupCount}>{t("smartDiff.filesCount", { count: group.files.length })}</span>
      </button>

      {open && (
        <div style={sd.files}>
          {group.files.length === 0 ? (
            <div style={sd.emptyGroup}>{t("smartDiff.emptyGroup")}</div>
          ) : (
            group.files.map((f) => {
              const findings = findingsByPath?.get(f.path) ?? [];
              const file: PrFile = patchByPath.get(f.path) ?? {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
                patch: null,
              };
              return (
                <FileCard
                  key={f.path}
                  file={file}
                  commenting={commenting}
                  findings={findings}
                  // Boilerplate stays shut — unless a review actually flagged
                  // something in it, in which case hiding it would bury a finding.
                  defaultOpen={group.role !== "boilerplate" || findings.length > 0}
                  scrollTo={jump && jump.path === f.path ? { line: jump.line, nonce: jump.nonce } : null}
                  onJumpToLine={(line) => onJump(f.path, line)}
                  onSelectFinding={onSelectFinding}
                />
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function SplitSuggestion({ suggestion }: { suggestion: SmartDiff["split_suggestion"] }) {
  const t = useTranslations("prReview");
  return (
    <div style={sd.splitBanner}>
      <div style={sd.splitTitle}>
        <Icon.AlertTriangle size={14} />
        {t("smartDiff.largeTitle", { lines: suggestion.total_lines })}
      </div>
      {suggestion.proposed_splits.length > 0 && (
        <>
          <div style={sd.splitBody}>{t("smartDiff.largeBody")}</div>
          <ul style={sd.splitList}>
            {suggestion.proposed_splits.map((split) => (
              <li key={split.name}>
                <span style={{ fontWeight: 600 }}>{split.name}</span>{" "}
                <span className="mono" style={{ color: "var(--text-muted)" }}>
                  ({t("smartDiff.filesCount", { count: split.files.length })})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
