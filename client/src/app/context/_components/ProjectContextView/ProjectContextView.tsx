/* /context — the Project Context page (SPEC-01).

   READ-ONLY BY DESIGN. There is no create, edit, upload, delete or refresh
   control anywhere on this page, and adding one would be a change of contract,
   not a feature: these documents are the repository's own files, and the only
   way to change them is to change them in the repository. The server exposes no
   write path either — `GitClient` has no write method, and `sync()` would
   `reset --hard` any local edit away on the next resync.

   Discovery is a live walk on every load, so a document committed a minute ago
   appears without anyone pressing anything — which is also why there is no
   "Re-index" button to press. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, EmptyState, ErrorState, Markdown, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useActiveRepo } from "../../../../lib/repo-context";
import { useContextFile, useContextFiles } from "../../../../lib/hooks/context";
import { s } from "./styles";

export function ProjectContextView() {
  const t = useTranslations("context");
  const { repoId, activeRepo } = useActiveRepo();

  const { data: listing, isLoading, isError, refetch } = useContextFiles(repoId);
  const [selected, setSelected] = React.useState<string | null>(null);

  const files = listing?.files ?? [];
  const roots = listing?.roots ?? [];

  // Keep the selection valid across a refetch that dropped the chosen file.
  const activePath = selected && files.some((f) => f.path === selected) ? selected : null;
  const { data: doc, isLoading: docLoading, isError: docError } = useContextFile(repoId, activePath);

  const crumb = [{ label: t("page.crumbWorkspace") }, { label: t("title") }];
  const repoShort = activeRepo?.full_name?.split("/").pop() ?? t("page.repoFallback");

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {t("page.headingPrefix")}
              <span style={s.repo}>{repoShort}</span>
            </h1>
            <p style={s.subtitle}>{t("page.subtitle", { roots: roots.join(", ") })}</p>
          </div>
        </div>

        {!repoId && <EmptyState icon="FileText" title={t("page.noRepo")} />}

        {repoId && isLoading && (
          <div>
            <Skeleton height={120} />
            <div style={{ height: 14 }} />
            <Skeleton height={120} />
          </div>
        )}

        {repoId && isError && <ErrorState body={t("loadError")} onRetry={() => refetch()} />}

        {repoId && !isLoading && !isError && listing?.cloned === false && (
          <EmptyState icon="GitBranch" title={t("notCloned.title")} body={t("notCloned.body")} />
        )}

        {repoId && !isLoading && !isError && listing?.cloned && files.length === 0 && (
          <EmptyState
            icon="FileText"
            title={t("empty.title")}
            body={t("empty.body", { roots: roots.join(", ") })}
          />
        )}

        {files.length > 0 && (
          <>
            <div style={s.split}>
              <div style={s.list}>
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    style={s.row(activePath === f.path)}
                    onClick={() => setSelected(f.path)}
                  >
                    <div style={s.rowMain}>
                      <span className="mono" style={s.path}>
                        {f.path}
                      </span>
                      {/* Rendered as 0, never hidden: "no agent uses this
                          document" is the fact the page exists to show. */}
                      <span style={s.meta}>
                        {t("page.usedBy", { count: f.used_by_agents })} ·{" "}
                        {t("picker.tokens", { count: f.tokens })}
                      </span>
                    </div>
                    <Badge color="var(--text-muted)">{f.type}</Badge>
                  </button>
                ))}
              </div>

              <div style={s.pane}>
                {!activePath && <span style={s.paneHint}>{t("page.selectHint")}</span>}
                {activePath && (
                  <>
                    <h2 className="mono" style={s.paneTitle}>
                      {activePath}
                    </h2>
                    {docLoading && <span style={s.paneHint}>{t("preview.loading")}</span>}
                    {docError && <div style={s.errorBar}>{t("preview.loadError")}</div>}
                    {doc && <Markdown>{doc.content}</Markdown>}
                  </>
                )}
              </div>
            </div>

            <div style={s.footer}>
              {t("page.footer", { files: files.length, tokens: listing?.total_tokens ?? 0 })}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
