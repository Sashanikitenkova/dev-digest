import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, SmartDiff } from "@devdigest/shared";
import type { PrFile } from "@/lib/types";
import prReview from "../../../../messages/en/prReview.json";
import shell from "../../../../messages/en/shell.json";
import { findingsByPath } from "../findings";
import { SmartDiffViewer } from "./SmartDiffViewer";

afterEach(cleanup);

// jsdom implements neither of these; the scroll behaviour is what we assert on.
const scrollIntoView = vi.fn();
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => scrollIntoView.mockClear());

const PATCH = [
  "@@ -24,4 +24,8 @@",
  " export async function rateLimit(req, res, next) {",
  "+  const key = bucketKey(req);",
  "+  const count = await redis.incr(key);",
  "+  if (count === 1) await redis.expire(key, 3600);",
  "+  return next();",
].join("\n");

const FILES: PrFile[] = [
  { path: "src/middleware/ratelimit.ts", additions: 84, deletions: 0, patch: PATCH },
  { path: "src/api/public/index.ts", additions: 12, deletions: 2, patch: PATCH },
  { path: "package-lock.json", additions: 92, deletions: 24, patch: PATCH },
];

const sdFile = (path: string, additions: number, deletions: number, lines: number[] = []) => ({
  path,
  pseudocode_summary: null,
  additions,
  deletions,
  finding_lines: lines,
});

const SMART_DIFF: SmartDiff = {
  groups: [
    { role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0)] },
    { role: "wiring", files: [sdFile("src/api/public/index.ts", 12, 2)] },
    { role: "boilerplate", files: [sdFile("package-lock.json", 92, 24)] },
  ],
  split_suggestion: { too_big: false, total_lines: 214, proposed_splits: [] },
};

const finding = (over: Partial<FindingRecord> = {}): FindingRecord => ({
  id: "f1",
  severity: "CRITICAL",
  category: "security",
  title: "Unvalidated callback URL",
  file: "src/middleware/ratelimit.ts",
  start_line: 26,
  end_line: 26,
  rationale: "SSRF risk.",
  suggestion: null,
  confidence: 0.9,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
  ...over,
});

function renderViewer(props: Partial<React.ComponentProps<typeof SmartDiffViewer>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview, shell }}>
      <SmartDiffViewer smartDiff={SMART_DIFF} files={FILES} {...props} />
    </NextIntlClientProvider>,
  );
}

describe("SmartDiffViewer — grouping", () => {
  it("renders the groups in core → wiring → boilerplate order", () => {
    renderViewer();
    const headings = screen.getAllByRole("button", { expanded: true }).concat(
      screen.getAllByRole("button", { expanded: false }),
    );
    const labels = ["Core logic", "Wiring", "Boilerplate"];
    const order = labels.map((l) => screen.getByText(l));
    expect(order).toHaveLength(3);
    // Document order must match reading order.
    expect(order[0]!.compareDocumentPosition(order[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order[1]!.compareDocumentPosition(order[2]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });

  it("shows each group's file count and blurb", () => {
    renderViewer();
    expect(screen.getByText("The substance of the change — review closely")).toBeInTheDocument();
    expect(screen.getByText("Generated / mechanical — skim")).toBeInTheDocument();
    expect(screen.getAllByText("1 files")).toHaveLength(3);
  });

  it("starts core and wiring expanded but boilerplate collapsed", () => {
    renderViewer();
    const group = (label: string) => screen.getByText(label).closest("button")!;
    expect(group("Core logic")).toHaveAttribute("aria-expanded", "true");
    expect(group("Wiring")).toHaveAttribute("aria-expanded", "true");
    expect(group("Boilerplate")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the lockfile out of the document until its group is opened", () => {
    renderViewer();
    expect(screen.queryByText("package-lock.json")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Boilerplate").closest("button")!);
    expect(screen.getByText("package-lock.json")).toBeInTheDocument();
  });

  it("renders an empty group without dropping it from the layout", () => {
    renderViewer({
      smartDiff: { ...SMART_DIFF, groups: [{ role: "core", files: [] }] },
      files: FILES,
    });
    expect(screen.getByText("Core logic")).toBeInTheDocument();
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    expect(screen.getAllByText("No files in this group.").length).toBeGreaterThan(0);
  });
});

describe("SmartDiffViewer — findings badges", () => {
  const withFinding = () =>
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [
          { role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26])] },
          { role: "wiring", files: [sdFile("src/api/public/index.ts", 12, 2)] },
          { role: "boilerplate", files: [sdFile("package-lock.json", 92, 24)] },
        ],
      },
      findingsByPath: findingsByPath([finding()]),
    });

  it("shows no badge when a file has no findings", () => {
    renderViewer();
    expect(screen.queryByText(/findings$/)).not.toBeInTheDocument();
  });

  it("shows an N findings badge on a flagged file", () => {
    withFinding();
    expect(screen.getByRole("button", { name: "1 findings" })).toBeInTheDocument();
  });

  it("counts every finding on the file", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [{ role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26, 27])] }],
      },
      findingsByPath: findingsByPath([
        finding(),
        finding({ id: "f2", start_line: 27, severity: "WARNING" }),
      ]),
    });
    expect(screen.getByRole("button", { name: "2 findings" })).toBeInTheDocument();
  });

  it("tags the flagged code line with the mockup's severity wording", () => {
    withFinding();
    expect(screen.getByText("blocker")).toBeInTheDocument();
  });

  it("expands a boilerplate file that has findings, rather than burying them", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [
          { role: "core", files: [] },
          { role: "wiring", files: [] },
          { role: "boilerplate", files: [sdFile("package-lock.json", 92, 24, [26])] },
        ],
      },
      findingsByPath: findingsByPath([finding({ file: "package-lock.json" })]),
    });
    fireEvent.click(screen.getByText("Boilerplate").closest("button")!);
    // Its lines are mounted, not just its header.
    expect(screen.getByText("blocker")).toBeInTheDocument();
  });
});

describe("SmartDiffViewer — jump to line", () => {
  it("scrolls to the finding's line when the badge is clicked", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [{ role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26])] }],
      },
      findingsByPath: findingsByPath([finding()]),
    });

    fireEvent.click(screen.getByRole("button", { name: "1 findings" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("scrolls again when the same badge is clicked twice (nonce)", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [{ role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26])] }],
      },
      findingsByPath: findingsByPath([finding()]),
    });

    const badge = screen.getByRole("button", { name: "1 findings" });
    fireEvent.click(badge);
    fireEvent.click(badge);

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("does not collapse the file card when the badge is pressed", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [{ role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26])] }],
      },
      findingsByPath: findingsByPath([finding()]),
    });

    fireEvent.click(screen.getByRole("button", { name: "1 findings" }));

    expect(screen.getByText("blocker")).toBeInTheDocument();
  });

  it("opens a collapsed boilerplate group when a jump targets a file inside it", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        groups: [
          { role: "core", files: [sdFile("src/middleware/ratelimit.ts", 84, 0, [26])] },
          { role: "boilerplate", files: [sdFile("package-lock.json", 92, 24)] },
        ],
      },
      findingsByPath: findingsByPath([finding()]),
    });
    const boilerplate = screen.getByText("Boilerplate").closest("button")!;
    expect(boilerplate).toHaveAttribute("aria-expanded", "false");
  });
});

describe("SmartDiffViewer — split suggestion", () => {
  it("stays quiet for a normal-sized PR", () => {
    renderViewer();
    expect(screen.queryByText(/This PR is large/)).not.toBeInTheDocument();
  });

  it("warns and lists proposed splits for an oversized PR", () => {
    renderViewer({
      smartDiff: {
        ...SMART_DIFF,
        split_suggestion: {
          too_big: true,
          total_lines: 1320,
          proposed_splits: [{ name: "billing", files: ["billing/charge.ts", "billing/refund.ts"] }],
        },
      },
    });
    expect(screen.getByText("This PR is large (1320 changed lines)")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
  });
});

describe("SmartDiffViewer — empty state", () => {
  it("renders the empty message when the PR has no files", () => {
    renderViewer({ files: [] });
    expect(screen.getByText("No changed files.")).toBeInTheDocument();
  });
});
