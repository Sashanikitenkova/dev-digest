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

const DATA: PrBlast = {
  blast: {
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
        endpoints_affected: ["GET /api/public/items"],
        crons_affected: [],
      },
      {
        symbol: "bucketKey",
        callers: [{ name: "reset", file: "src/jobs/reset.ts", line: 12 }],
        endpoints_affected: [],
        crons_affected: ["reset-rate-buckets (hourly)"],
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

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ blast, brief }}>
        <BlastRadiusPanel prId="pr-1" />
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

  it("says nothing is indexed rather than nothing is impacted", async () => {
    // The distinction the panel exists to preserve: an unindexed repo must not
    // read as "this change reaches nothing".
    get.mockResolvedValue({
      blast: {
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
