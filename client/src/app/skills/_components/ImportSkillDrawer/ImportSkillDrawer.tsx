/* ImportSkillDrawer — overlay on /skills (deliberately NOT a route).

   Two-step by construction: picking a file only calls
   `POST /skills/import/preview`, which is a pure parse and persists nothing.
   The row is written by a separate `POST /skills` when the user presses
   "Import skill" — so abandoning the drawer can never leave an orphan behind.

   The "skipped, not executed" list is rendered straight from the server
   response. It is never guessed here: the guarantee shown to the user has to
   be the same fact the parser acted on. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Drawer, Icon } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useCreateSkill, useImportSkillPreview } from "../../../../lib/hooks/skills";
import { FILE_ACCEPT, IMPORTED_ENABLED } from "./constants";
import { fileToBase64, isSupportedSkillFile } from "./helpers";
import { s } from "./styles";

export function ImportSkillDrawer({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: (skill: Skill) => void;
}) {
  const t = useTranslations("skills");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [filename, setFilename] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const previewMutation = useImportSkillPreview();
  const create = useCreateSkill();
  const preview = previewMutation.data;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    previewMutation.reset();
    setFilename(file.name);
    if (!isSupportedSkillFile(file.name)) {
      setError(t("import.unsupported"));
      return;
    }
    try {
      const content_base64 = await fileToBase64(file);
      previewMutation.mutate({ filename: file.name, content_base64 });
    } catch {
      setError(t("import.parseError"));
    }
  }

  function onImport() {
    if (!preview) return;
    create.mutate(
      {
        name: preview.name,
        description: preview.description,
        type: preview.type,
        source: preview.source,
        body: preview.body,
        // Imported bodies are untrusted — they arrive disabled until vetted.
        enabled: IMPORTED_ENABLED,
      },
      {
        onSuccess: (skill) => {
          onImported?.(skill);
          onClose();
        },
      },
    );
  }

  return (
    <Drawer
      width={620}
      title={t("import.title")}
      subtitle={t("import.subtitle")}
      onClose={onClose}
      footer={
        <div style={s.footer}>
          <Button
            kind="primary"
            icon="Upload"
            onClick={onImport}
            disabled={!preview || create.isPending}
          >
            {create.isPending ? t("import.importing") : t("import.submit")}
          </Button>
        </div>
      }
    >
      <div style={s.fileRow}>
        <Button kind="secondary" icon="File" onClick={() => inputRef.current?.click()}>
          {t("import.chooseFile")}
        </Button>
        <span style={s.fileName}>{filename ?? t("import.noFile")}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={FILE_ACCEPT}
        aria-label={t("import.chooseFile")}
        onChange={onPick}
        style={s.hiddenInput}
      />

      {previewMutation.isPending && <div style={s.fileName}>{t("import.parsing")}</div>}
      {error && <div style={s.error}>{error}</div>}
      {previewMutation.isError && <div style={s.error}>{t("import.parseError")}</div>}

      {preview && (
        <div style={s.previewWrap}>
          <div style={s.fieldLabel}>{t("import.previewHeading")}</div>

          <div style={s.field}>
            <div style={s.fieldLabel}>{t("import.nameLabel")}</div>
            <div style={s.fieldValue}>{preview.name}</div>
          </div>
          <div style={s.field}>
            <div style={s.fieldLabel}>{t("import.descriptionLabel")}</div>
            <div style={s.fieldValue}>{preview.description}</div>
          </div>
          <div style={s.field}>
            <div style={s.fieldLabel}>{t("import.bodyLabel")}</div>
            <pre className="mono" style={s.body}>
              {preview.body}
            </pre>
          </div>

          {preview.skipped_files.length > 0 && (
            <div style={{ ...s.noticeBase, ...s.skipped }}>
              <Icon.AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>{t("import.skippedHeading")}</strong>
                <ul className="mono" style={s.skippedList}>
                  {preview.skipped_files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div style={s.skippedNote}>{t("import.skippedNote")}</div>
              </div>
            </div>
          )}

          <div style={{ ...s.noticeBase, ...s.trust }}>
            <Icon.Shield size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>{t("import.trustNotice")}</div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
