"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { SectionLabel, Button } from "@devdigest/ui";
import {
  DiffViewer,
  SmartDiffViewer,
  OrderToggle,
  findingsByPath,
  type DiffCommentApi,
  type DiffOrder,
} from "@/components/diff-viewer";
import { usePrComments, useCreatePrComment, usePrReviews } from "@/lib/hooks/reviews";
import { usePrSmartDiff } from "@/lib/hooks/smart-diff";
import { notify } from "@/lib/toast";
import type { FindingRecord, PrFile } from "@devdigest/shared";
import { ds } from "./styles";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFile[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  /** Where to scroll on arrival, from `?file=&line=` — a brief review-focus row
   *  deep-linking into the diff. Only the Smart Diff can honour it; the plain
   *  fallback viewer has no jump mechanism and is left untouched. */
  jumpTo?: { file: string; line: number | null } | null;
  /** Clicking a line's severity tag — the page turns this into ?tab=findings&finding=<id>. */
  onSelectFinding?: (id: string) => void;
}

export function DiffTab({
  prId,
  filesCount,
  files,
  canComment,
  jumpTo,
  onSelectFinding,
}: DiffTabProps) {
  const t = useTranslations("prReview");
  const { data: comments } = usePrComments(prId);
  const create = useCreatePrComment(prId);
  // Comments start hidden so the diff is clean by default — toggle to reveal.
  const [showComments, setShowComments] = React.useState(false);
  const [order, setOrder] = React.useState<DiffOrder>("smart");

  const smartDiff = usePrSmartDiff(prId);
  const { data: reviews } = usePrReviews(prId);

  /**
   * Findings behind the badges and line tags.
   *
   * The smart-diff response already carries `finding_lines` per file, but the
   * shared contract has no severity on it — so the colour has to come from the
   * reviews the page already fetches. Rather than re-deriving "latest round"
   * here (the client can't see `ran_at`, and duplicating that rule would let
   * the two sides disagree), we keep exactly the findings the SERVER selected:
   * a finding counts iff its file+line is in that file's `finding_lines`.
   */
  const findings = React.useMemo(() => {
    const sd = smartDiff.data;
    if (!sd || !reviews || reviews.length === 0) return new Map<string, FindingRecord[]>();

    const selected = new Map<string, Set<number>>(
      sd.groups.flatMap((g) => g.files.map((f) => [f.path, new Set(f.finding_lines)]))
    );
    const seen = new Set<string>();
    const kept: FindingRecord[] = [];
    for (const finding of reviews.flatMap((r) => r.findings ?? [])) {
      if (!selected.get(finding.file)?.has(finding.start_line)) continue;
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      kept.push(finding);
    }
    return findingsByPath(kept);
  }, [reviews, smartDiff.data]);

  const commentCount = comments?.length ?? 0;
  const totals = React.useMemo(
    () => ({
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
    }),
    [files]
  );

  const commenting: DiffCommentApi = {
    comments: comments ?? [],
    canComment: !!canComment && !!prId,
    showComments,
    posting: create.isPending,
    onSubmit: async (input) => {
      try {
        const res = await create.mutateAsync(input);
        setShowComments(true); // a just-posted comment shouldn't stay hidden
        return res;
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "Couldn't post the comment to GitHub.");
        throw err;
      }
    },
  };

  // Smart order is the default, but it must never be able to break the tab:
  // while the grouping loads (or if it errors) fall back to the plain diff.
  const smartReady = order === "smart" && !!smartDiff.data && !smartDiff.isError;

  return (
    <section>
      <SectionLabel
        icon="Code"
        right={
          <div style={ds.headerRight}>
            {commentCount > 0 && (
              <Button
                kind="ghost"
                size="sm"
                icon={showComments ? "EyeOff" : "Eye"}
                onClick={() => setShowComments((v) => !v)}
              >
                {showComments ? "Hide comments" : "Show comments"} ({commentCount})
              </Button>
            )}
            <OrderToggle order={order} onChange={setOrder} />
          </div>
        }
      >
        {t("smartDiff.sectionLabel")}
      </SectionLabel>

      <div style={ds.diffStat}>
        {t("smartDiff.filesCount", { count: filesCount })} ·{" "}
        <span style={ds.add}>+{totals.additions}</span>{" "}
        <span style={ds.del}>−{totals.deletions}</span>
      </div>

      {smartReady ? (
        <SmartDiffViewer
          smartDiff={smartDiff.data!}
          files={files}
          findingsByPath={findings}
          commenting={commenting}
          jumpTo={jumpTo}
          onSelectFinding={onSelectFinding}
        />
      ) : (
        <DiffViewer files={files} commenting={commenting} />
      )}
    </section>
  );
}
