import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";
import { ToastProvider } from "../../../../../../../lib/toast";
import { diffLines } from "./helpers";

const restoreMutate = vi.fn();

vi.mock("../../../../../../../lib/hooks/skills", () => ({
  useRestoreSkillVersion: () => ({ mutate: restoreMutate, isPending: false }),
  useSkillVersions: () => ({
    data: [
      { skill_id: "sk1", version: 2, body: "current body", created_at: "2026-07-18T10:00:00.000Z" },
      { skill_id: "sk1", version: 1, body: "old body", created_at: "2026-07-17T10:00:00.000Z" },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { VersionsTab } from "./VersionsTab";

const SKILL: Skill = {
  id: "sk1",
  name: "pr-quality-rubric",
  description: "Rubric",
  type: "rubric",
  source: "manual",
  body: "current body",
  enabled: true,
  version: 2,
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <ToastProvider>
        <VersionsTab skill={SKILL} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => restoreMutate.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VersionsTab", () => {
  it("marks the newest snapshot as current and offers Restore only on older ones", () => {
    renderTab();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
  });

  it("restores by version through the restore endpoint, not by resending a body", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreMutate).toHaveBeenCalledTimes(1);
    // The version identifies the snapshot; the server reads the body itself,
    // so a stale copy in the client can never be written back as "restored".
    expect(restoreMutate.mock.calls[0]![0]).toEqual({ id: "sk1", version: 1 });
  });

  it("does nothing when the restore confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreMutate).not.toHaveBeenCalled();
  });

  it("shows a line diff of the snapshot against the current body", () => {
    renderTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Diff" })[1]!);
    expect(screen.getByText("- old body")).toBeInTheDocument();
    expect(screen.getByText("+ current body")).toBeInTheDocument();
  });
});

describe("diffLines", () => {
  it("keeps shared lines and marks only the changed ones", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  it("reports an unchanged body as all-same", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.kind === "same")).toBe(true);
  });
});
