/* FileCard — one collapsible file in the diff: header (path, +/- stat, comment
   count, findings badge) and, when open, its parsed lines plus any outdated
   comments. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, SEV } from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import type { PrFile } from "@/lib/types";
import { AUTO_EXPAND_MAX_LINES } from "../constants";
import { parsePatch, type Line } from "../helpers";
import {
  buildThreads,
  keysForLine,
  partitionThreads,
  type CommentThread,
  type DiffCommentApi,
} from "../comments";
import { anchorFindings, firstFindingLine, fs, worstSeverity } from "../findings";
import { s, chevronFor } from "../styles";
import { CodeLine } from "../CodeLine";
import { OutdatedComments } from "../OutdatedComments";

/** Threads anchored to a given parsed line (RIGHT=new, LEFT=old). */
function threadsForLine(ln: Line, matched: Map<string, CommentThread[]>): CommentThread[] {
  if (matched.size === 0) return [];
  const out: CommentThread[] = [];
  for (const key of keysForLine(ln)) {
    const list = matched.get(key);
    if (list) out.push(...list);
  }
  return out;
}

export interface FileCardProps {
  file: PrFile;
  commenting?: DiffCommentApi;
  /** Review findings citing this file (Smart Diff only). */
  findings?: FindingRecord[];
  /** Overrides the size-based auto-expand — Smart Diff decides per role. */
  defaultOpen?: boolean;
  /**
   * Scroll request from a findings badge. `nonce` is what makes re-clicking the
   * same line fire again; without it React sees identical props and does nothing.
   */
  scrollTo?: { line: number; nonce: number } | null;
  /** Asks the owner to scroll this file to `line` (badge click). */
  onJumpToLine?: (line: number) => void;
  /** Makes the per-line severity tags clickable — opens that finding elsewhere. */
  onSelectFinding?: (id: string) => void;
}

export function FileCard({
  file,
  commenting,
  findings,
  defaultOpen,
  scrollTo,
  onJumpToLine,
  onSelectFinding,
}: FileCardProps) {
  const t = useTranslations("shell");
  const [open, setOpen] = React.useState(
    defaultOpen ?? (file.additions ?? 0) + (file.deletions ?? 0) <= AUTO_EXPAND_MAX_LINES
  );
  const lines = React.useMemo(() => parsePatch(file.patch), [file.patch]);
  const lineRefs = React.useRef(new Map<number, HTMLDivElement>());

  // Group this file's comments into threads, then split into ones we can anchor
  // to a rendered line vs. "outdated" (GitHub dropped the line / it's not here).
  const comments = commenting?.comments;
  const { matched, outdated } = React.useMemo(() => {
    if (!comments) return { matched: new Map<string, CommentThread[]>(), outdated: [] };
    const fileThreads = buildThreads(comments.filter((c) => c.path === file.path));
    const renderedKeys = new Set<string>();
    for (const ln of lines) for (const k of keysForLine(ln)) renderedKeys.add(k);
    return partitionThreads(fileThreads, renderedKeys);
  }, [comments, file.path, lines]);

  const fileFindings = React.useMemo(() => findings ?? [], [findings]);
  const { byLine } = React.useMemo(
    () => anchorFindings(fileFindings, lines),
    [fileFindings, lines]
  );

  // Open first, THEN scroll: a collapsed card has no lines mounted, so scrolling
  // before the open commits would find no ref to scroll to.
  React.useEffect(() => {
    if (!scrollTo) return;
    setOpen(true);
  }, [scrollTo]);

  React.useEffect(() => {
    if (!scrollTo || !open) return;
    lineRefs.current.get(scrollTo.line)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollTo, open]);

  const commentCount = commenting
    ? commenting.comments.filter((c) => c.path === file.path).length
    : 0;
  const worst = worstSeverity(fileFindings);

  return (
    <div style={s.fileCard}>
      <div onClick={() => setOpen((o) => !o)} style={s.fileHeader}>
        <Icon.ChevronRight size={13} style={chevronFor(open)} />
        <Icon.FileText size={14} style={s.fileIcon} />
        <span className="mono" style={s.filePath}>
          {file.path}
        </span>
        {worst && (
          <span
            aria-hidden
            style={{ width: 6, height: 6, borderRadius: 99, background: SEV[worst].c, flexShrink: 0 }}
          />
        )}
        {worst && (
          <button
            type="button"
            style={fs.badge(worst)}
            title={t("diffViewer.jumpToFinding")}
            onClick={(e) => {
              // The header toggles on click — a badge press must jump, not collapse.
              e.stopPropagation();
              const line = firstFindingLine(fileFindings);
              if (line != null) onJumpToLine?.(line);
            }}
          >
            {t("diffViewer.findingsCount", { count: fileFindings.length })}
          </button>
        )}
        <span className="mono tnum" style={s.fileStat}>
          <span style={s.addText}>+{file.additions}</span>{" "}
          <span style={s.delText}>−{file.deletions}</span>
        </span>
        {commentCount > 0 && (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}
          >
            <Icon.MessageSquare size={12} />
            {commentCount}
          </span>
        )}
      </div>
      {open && (
        <div style={s.fileBody}>
          {lines.length === 0 ? (
            <div style={s.noDiff}>{t("diffViewer.noDiffText")}</div>
          ) : (
            lines.map((ln, i) => (
              <CodeLine
                key={i}
                ref={
                  ln.newNo != null
                    ? (el) => {
                        if (el) lineRefs.current.set(ln.newNo!, el);
                        else lineRefs.current.delete(ln.newNo!);
                      }
                    : undefined
                }
                ln={ln}
                path={file.path}
                threads={threadsForLine(ln, matched)}
                commenting={commenting}
                findings={ln.newNo != null ? byLine.get(ln.newNo) : undefined}
                onSelectFinding={onSelectFinding}
              />
            ))
          )}
          {commenting && commenting.showComments && <OutdatedComments threads={outdated} />}
        </div>
      )}
    </div>
  );
}
