import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import blast from "../../../../../../../../messages/en/blast.json";
import brief from "../../../../../../../../messages/en/brief.json";
import type { PrBlast } from "../../../../../../../lib/hooks/blast";
import { BlastRadiusPanel } from "./BlastRadiusPanel";

const get = vi.fn();
vi.mock("../../../../../../../lib/api", () => ({
  api: { get: (...args: unknown[]) => get(...args) },
}));

afterEach(cleanup);
beforeEach(() => get.mockReset());

const FULL_INDEX = {
  status: "full" as const,
  reason: null,
  files_indexed: 120,
  last_indexed_sha: "abc123",
  updated_at: "2026-08-18T09:00:00.000Z",
};

const DATA: PrBlast = {
  blast: {
    index: FULL_INDEX,
    changed_symbols: [
      { name: "rateLimit", file: "src/api/rateLimit.ts", kind: "function" },
      { name: "bucketKey", file: "src/api/rateLimit.ts", kind: "function" },
    ],
    downstream: [
      {
        symbol: "rateLimit",
        callers: [
          { name: "handler", file: "src/api/public/index.ts", line: 23 },
          { name: "boot", file: "src/server.ts", line: 88 },
        ],
        caller_total: 2,
        endpoints_affected: [{ endpoint: "GET /api/public/items", depth: 1 }],
        crons_affected: [],
      },
      {
        symbol: "bucketKey",
        callers: [{ name: "reset", file: "src/jobs/reset.ts", line: 12 }],
        caller_total: 1,
        endpoints_affected: [],
        crons_affected: [{ endpoint: "reset-rate-buckets (hourly)", depth: 1 }],
      },
    ],
    impacted_endpoints: ["GET /api/public/items"],
    impacted_crons: ["reset-rate-buckets (hourly)"],
    summary: "2 changed symbols, 3 callers, 1 impacted endpoint.",
  },
  history: [
    {
      pr_number: 471,
      title: "Add webhook signing",
      merged_at: "2026-08-01T09:00:00.000Z",
      author: "marisa.koch",
      files_overlap: ["src/server.ts"],
      notes: "",
    },
  ],
};

function renderPanel(props: Partial<React.ComponentProps<typeof BlastRadiusPanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ blast, brief }}>
        <BlastRadiusPanel
          prId="pr-1"
          repoId="repo-1"
          repoFullName="acme/payments-api"
          headSha="deadbeef"
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("BlastRadiusPanel", () => {
  it("renders the stat row from the flat unions, not the per-symbol lists", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    expect(await screen.findByText("symbols")).toBeInTheDocument();
    expect(screen.getByText("callers")).toBeInTheDocument();
    // 2 symbols, 3 callers, 1 endpoint, 1 cron.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("lists each changed symbol with its callers as file:line", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    expect(await screen.findByText("rateLimit()")).toBeInTheDocument();
    expect(screen.getByText(/src\/api\/public\/index\.ts:23/)).toBeInTheDocument();
    expect(screen.getByText(/src\/server\.ts:88/)).toBeInTheDocument();
  });

  it("shows endpoint and cron chips on the symbol they were attributed to", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    expect(await screen.findByText("GET /api/public/items")).toBeInTheDocument();
    expect(screen.getByText("reset-rate-buckets (hourly)")).toBeInTheDocument();
  });

  it("collapses a symbol's callers when its row is clicked", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    const row = await screen.findByRole("button", { name: /rateLimit/ });
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/src\/api\/public\/index\.ts:23/)).not.toBeInTheDocument();
  });

  it("reveals prior PRs only once the disclosure is opened", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    expect(await screen.findByText(/Prior PRs touching these files \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Add webhook signing/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Prior PRs/ }));
    expect(screen.getByText(/Add webhook signing/)).toBeInTheDocument();
    expect(screen.getByText(/1 overlap/)).toBeInTheDocument();
  });

  it("links each caller to its line on GitHub at the PR's head sha", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    const link = await screen.findByRole("link", { name: /src\/server\.ts:88/ });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/deadbeef/src/server.ts#L88",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("degrades a caller to plain text when the repo or sha is unknown", async () => {
    get.mockResolvedValue(DATA);
    renderPanel({ repoFullName: null });

    // Still readable, just not navigable — never a dead link.
    expect(await screen.findByText(/src\/server\.ts:88/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /src\/server\.ts:88/ })).not.toBeInTheDocument();
  });

  it("shows how many callers were truncated when the facade found more", async () => {
    get.mockResolvedValue({
      ...DATA,
      blast: {
        ...DATA.blast,
        downstream: [{ ...DATA.blast.downstream[0]!, caller_total: 43 }],
      },
    } satisfies PrBlast);
    renderPanel();

    expect(await screen.findByText("2 of 43 callers")).toBeInTheDocument();
  });

  it("caveats a partial index WITHOUT hiding the results it did produce", async () => {
    get.mockResolvedValue({
      ...DATA,
      blast: {
        ...DATA.blast,
        index: { ...FULL_INDEX, status: "partial", reason: "soft_budget" },
      },
    } satisfies PrBlast);
    renderPanel();

    expect(await screen.findByText(/Partial index/)).toBeInTheDocument();
    // The map is still there — a partial index produced real callers.
    expect(screen.getByText("rateLimit()")).toBeInTheDocument();
    expect(screen.getByText(/src\/server\.ts:88/)).toBeInTheDocument();
  });

  it("distinguishes a failed index from a partial one", async () => {
    get.mockResolvedValue({
      ...DATA,
      blast: { ...DATA.blast, index: { ...FULL_INDEX, status: "failed" } },
    } satisfies PrBlast);
    renderPanel();

    expect(await screen.findByText(/Index failed/)).toBeInTheDocument();
  });

  it("swaps the tree for the graph when the toggle is used", async () => {
    get.mockResolvedValue(DATA);
    renderPanel();

    const graphBtn = await screen.findByRole("button", { name: "Graph" });
    expect(graphBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(graphBtn);

    expect(graphBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: "Blast radius graph" })).toBeInTheDocument();
    // The tree's caller list is gone; the graph renders its own labels.
    expect(screen.queryByText(/src\/server\.ts:88/)).not.toBeInTheDocument();
  });

  it("collapses indirect (2-hop) impact behind a disclosure", async () => {
    get.mockResolvedValue({
      ...DATA,
      blast: {
        ...DATA.blast,
        downstream: [
          {
            ...DATA.blast.downstream[0]!,
            endpoints_affected: [
              { endpoint: "GET /api/public/items", depth: 1 },
              { endpoint: "GET /health", depth: 2 },
            ],
          },
        ],
      },
    } satisfies PrBlast);
    renderPanel();

    // Direct impact reads at full weight; the 2-hop claim is true but reaches
    // through a barrel file, so it must not sit next to it as an equal.
    expect(await screen.findByText("GET /api/public/items")).toBeInTheDocument();
    expect(screen.queryByText("GET /health")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+1 indirect" }));
    expect(screen.getByText("GET /health")).toBeInTheDocument();
  });

  it("renders two same-named symbols without a duplicate React key", async () => {
    // A symbol name is not unique across a repo, and DownstreamImpact carries no
    // file to disambiguate it. Real case: `renderWithIntl` is a local test helper
    // defined in ten files here, so a PR touching them produces ten downstream
    // entries with the same name. Keying on the name alone made React drop nodes.
    const sameName: PrBlast = {
      ...DATA,
      blast: {
        ...DATA.blast!,
        changed_symbols: [
          { name: "renderWithIntl", file: "a/VerdictBanner.test.tsx", kind: "function" },
          { name: "renderWithIntl", file: "b/FindingCard.test.tsx", kind: "function" },
        ],
        downstream: [
          {
            symbol: "renderWithIntl",
            callers: [{ name: "suiteA", file: "a/VerdictBanner.test.tsx", line: 19 }],
            caller_total: 1,
            endpoints_affected: [],
            crons_affected: [],
          },
          {
            symbol: "renderWithIntl",
            callers: [{ name: "suiteB", file: "b/FindingCard.test.tsx", line: 40 }],
            caller_total: 1,
            endpoints_affected: [],
            crons_affected: [],
          },
        ],
        summary: "2 changed symbols, 2 callers.",
      },
    };
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
    get.mockResolvedValue(sameName);
    renderPanel();

    // Both entries survive: they are different symbols that happen to share a name.
    expect(await screen.findAllByText("renderWithIntl()")).toHaveLength(2);
    expect(screen.getByText(/a\/VerdictBanner\.test\.tsx:19/)).toBeInTheDocument();
    expect(screen.getByText(/b\/FindingCard\.test\.tsx:40/)).toBeInTheDocument();

    // The assertion that would have caught this: React reports a duplicate key as
    // a console warning, not a throw, so nothing else in this suite would fail.
    spy.mockRestore();
    const duplicateKey = errors.find((a) =>
      a.some((x) => typeof x === "string" && x.includes("same key")),
    );
    expect(duplicateKey).toBeUndefined();
  });

  it("renders repeated endpoint chips without a duplicate React key", async () => {
    // The same latent bug one level down: one endpoint can be reached by two
    // changed symbols, and direct and indirect chips share a parent.
    const repeatedEndpoint: PrBlast = {
      ...DATA,
      blast: {
        ...DATA.blast!,
        downstream: [
          {
            symbol: "rateLimit",
            callers: [{ name: "handler", file: "src/api/public/index.ts", line: 23 }],
            caller_total: 1,
            endpoints_affected: [
              { endpoint: "GET /api/public/items", depth: 1 },
              { endpoint: "GET /api/public/items", depth: 2 },
            ],
            crons_affected: [{ endpoint: "GET /api/public/items", depth: 1 }],
          },
        ],
        summary: "1 changed symbol.",
      },
    };
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
    get.mockResolvedValue(repeatedEndpoint);
    renderPanel();

    expect(await screen.findAllByText("GET /api/public/items")).not.toHaveLength(0);
    spy.mockRestore();
    expect(
      errors.find((a) => a.some((x) => typeof x === "string" && x.includes("same key"))),
    ).toBeUndefined();
  });

  it("says nothing is indexed rather than nothing is impacted", async () => {
    // The distinction the panel exists to preserve: an unindexed repo must not
    // read as "this change reaches nothing".
    get.mockResolvedValue({
      blast: {
        index: { ...FULL_INDEX, status: "missing", files_indexed: 0, last_indexed_sha: "" },
        changed_symbols: [],
        downstream: [],
        impacted_endpoints: [],
        impacted_crons: [],
        summary: "No indexed symbols changed in this PR.",
      },
      history: [],
    } satisfies PrBlast);
    renderPanel();

    expect(await screen.findByText("Nothing indexed for these files")).toBeInTheDocument();
    expect(screen.queryByText("symbols")).not.toBeInTheDocument();
  });
});
