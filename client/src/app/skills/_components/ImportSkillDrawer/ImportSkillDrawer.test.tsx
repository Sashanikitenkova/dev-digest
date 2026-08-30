import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { SkillImportPreview } from "@devdigest/shared";
import messages from "../../../../../messages/en/skills.json";

const createMutate = vi.fn();
const previewMutate = vi.fn();
const previewState: { data: SkillImportPreview | undefined } = { data: undefined };

vi.mock("../../../../lib/hooks/skills", () => ({
  useImportSkillPreview: () => ({
    mutate: previewMutate,
    reset: vi.fn(),
    data: previewState.data,
    isPending: false,
    isError: false,
  }),
  useCreateSkill: () => ({ mutate: createMutate, isPending: false }),
}));

import { ImportSkillDrawer } from "./ImportSkillDrawer";

const PREVIEW: SkillImportPreview = {
  name: "phantom-api-gate",
  description: "Detects imports of APIs that do not exist",
  type: "security",
  body: "# Phantom API Gate\nFlag imports with no definition.",
  source: "imported_url",
  skipped_files: ["scripts/run.sh", "install.js"],
};

function renderDrawer(onClose = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <ImportSkillDrawer onClose={onClose} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  createMutate.mockReset();
  previewMutate.mockReset();
  previewState.data = undefined;
});
afterEach(cleanup);

describe("ImportSkillDrawer", () => {
  it("shows no preview and cannot import before a file is parsed", () => {
    renderDrawer();
    expect(screen.getByText("No file selected")).toBeInTheDocument();
    expect(screen.queryByText("Preview (nothing saved yet)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import skill" })).toBeDisabled();
  });

  it("renders the server-reported skipped files and the trust notice", () => {
    previewState.data = PREVIEW;
    renderDrawer();
    expect(screen.getByText("Preview (nothing saved yet)")).toBeInTheDocument();
    expect(screen.getByText("phantom-api-gate")).toBeInTheDocument();
    expect(screen.getByText("Skipped, not executed:")).toBeInTheDocument();
    expect(screen.getByText("scripts/run.sh")).toBeInTheDocument();
    expect(screen.getByText("install.js")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Imported skills are stored as untrusted data and arrive disabled until you vet them.",
      ),
    ).toBeInTheDocument();
  });

  it("persists nothing until Import skill is clicked", () => {
    previewState.data = PREVIEW;
    renderDrawer();
    // Preview is on screen, but no create call has been made yet.
    expect(createMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]![0]).toEqual({
      name: PREVIEW.name,
      description: PREVIEW.description,
      type: PREVIEW.type,
      source: PREVIEW.source,
      body: PREVIEW.body,
      // Untrusted bodies arrive disabled until vetted.
      enabled: false,
    });
  });

  it("rejects an unsupported extension without calling the preview endpoint", () => {
    renderDrawer();
    const input = screen.getByLabelText("Choose file…") as HTMLInputElement;
    const file = new File(["#!/bin/sh"], "run.sh", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a .md or .zip file.")).toBeInTheDocument();
  });
});
