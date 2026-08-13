/* CodeLine — one rendered diff line: gutter number, +/- sign, text, plus the
   hover "+" affordance, any anchored comment threads, and an inline composer.
   In Smart Diff a line can also carry review findings, which tint its rail and
   add a severity tag at the right edge. */
"use client";

import React from "react";
import type { FindingRecord } from "@devdigest/shared";
import { Icon, SEV, type Severity } from "@devdigest/ui";
import { commentTargetFor, type CommentThread, type DiffCommentApi, cs } from "../comments";
import { fs, SEVERITY_LABEL, SEVERITY_RANK, worstSeverity } from "../findings";
import { type Line } from "../helpers";
import { s, lineRowFor, lineSignFor } from "../styles";
import { CommentThreadView } from "../CommentThreadView";
import { InlineComposer } from "../InlineComposer";

export const CodeLine = React.forwardRef<
  HTMLDivElement,
  {
    ln: Line;
    path: string;
    threads: CommentThread[];
    commenting?: DiffCommentApi;
    /** Review findings citing this line (Smart Diff only). */
    findings?: FindingRecord[];
  }
>(function CodeLine({ ln, path, threads, commenting, findings }, ref) {
  const [hover, setHover] = React.useState(false);
  const [composing, setComposing] = React.useState(false);

  if (ln.kind === "hunk") {
    return (
      <div className="mono" style={s.hunk}>
        {ln.text}
      </div>
    );
  }

  const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : "";
  const target = commenting?.canComment ? commentTargetFor(ln) : null;
  const showAdd = hover && !!target && !composing;
  const flagged = findings && findings.length > 0 ? worstSeverity(findings) : null;

  return (
    <div
      ref={ref}
      // Scrolled-to lines must clear the sticky PR header, not hide under it.
      style={{ ...cs.rowWrap, scrollMarginTop: 96 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ ...lineRowFor(ln.kind), ...(flagged ? fs.flaggedRow(flagged) : null) }}>
        <span className="mono tnum" style={{ ...s.lineNo, position: "relative" }}>
          {showAdd && target && (
            <button
              type="button"
              title="Add a comment on this line"
              aria-label="Add a comment on this line"
              onClick={() => setComposing(true)}
              style={cs.addBtn}
            >
              +
            </button>
          )}
          {ln.newNo ?? ln.oldNo ?? ""}
        </span>
        <span className="mono" style={lineSignFor(ln.kind)}>
          {sign}
        </span>
        <span className="mono" style={s.lineText}>
          {ln.text || " "}
        </span>
        {flagged && <SeverityTag findings={findings!} />}
      </div>

      {commenting &&
        commenting.showComments &&
        threads.map((th) => (
          <CommentThreadView key={th.rootId} thread={th} commenting={commenting} path={path} />
        ))}

      {commenting && composing && target && (
        <InlineComposer
          commenting={commenting}
          path={path}
          line={target.line}
          side={target.side}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
});

/** One tag per severity present on the line, worst first. */
function SeverityTag({ findings }: { findings: FindingRecord[] }) {
  const seen = new Set<Severity>();
  for (const f of findings) seen.add(f.severity as Severity);
  const ordered = [...seen].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]);
  return (
    <>
      {ordered.map((sev) => {
        const I = Icon[SEV[sev].icon];
        return (
          <span key={sev} style={fs.lineTag(sev)} title={SEV[sev].label}>
            <I size={11.5} />
            {SEVERITY_LABEL[sev]}
          </span>
        );
      })}
    </>
  );
}
