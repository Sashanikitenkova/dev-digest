import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrIntentRecord } from "../../../../../../../lib/types";
import messages from "../../../../../../../../messages/en/intent.json";
import { IntentCard } from "./IntentCard";

/**
 * Mocked at the network boundary (`lib/api`), not at the hook — the hook's
 * cache-writing behaviour is part of what these tests exercise.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock("../../../../../../../lib/api", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

afterEach(cleanup);
beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

const INTENT: PrIntentRecord = {
  pr_id: "pr-1",
  intent: "Add rate limiting to public API endpoints to prevent abuse.",
  in_scope: ["Add middleware for rate limiting", "Return 429 with Retry-After"],
  out_of_scope: ["Authentication changes"],
  confidence: 0.9,
  confidence_level: "high",
  sources: [
    { kind: "title", ref: null, status: "used", reason: null },
    { kind: "body", ref: null, status: "used", reason: null },
    { kind: "linked_issue", ref: "#471", status: "used", reason: null },
  ],
  head_sha: "a1b2c3d4",
  generated_at: "2026-08-10T10:00:00.000Z",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  cost_usd: 0.0001,
};

function renderCard(headSha: string | null = "a1b2c3d4") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ intent: messages }}>
        <IntentCard prId="pr-1" headSha={headSha} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("IntentCard", () => {
  it("offers a Detect action when the PR has no intent yet", async () => {
    get.mockResolvedValue(null);
    renderCard();
    expect(await screen.findByText("Intent not detected yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /detect intent/i })).toBeInTheDocument();
  });

  it("renders the intent, its scope lists and its confidence", async () => {
    get.mockResolvedValue(INTENT);
    renderCard();

    expect(await screen.findByText(`“${INTENT.intent}”`)).toBeInTheDocument();
    expect(screen.getByText("· Add middleware for rate limiting")).toBeInTheDocument();
    expect(screen.getByText("· Authentication changes")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByText(/deepseek\/deepseek-v4-flash/)).toBeInTheDocument();
  });

  it("shows a source that could NOT be retrieved, with its reason", async () => {
    // The honesty guarantee: an unfetched link is visible, not omitted.
    get.mockResolvedValue({
      ...INTENT,
      confidence: 0.4,
      confidence_level: "low",
      sources: [
        { kind: "title", ref: null, status: "used", reason: null },
        { kind: "body", ref: null, status: "missing", reason: "empty_body" },
        {
          kind: "url",
          ref: "https://notion.so/spec",
          status: "missing",
          reason: "external_fetch_disabled",
        },
      ],
    });
    renderCard();

    expect(await screen.findByText(/no PR description/)).toBeInTheDocument();
    expect(screen.getByText(/external links are not fetched/)).toBeInTheDocument();
    expect(screen.getByText("Low confidence")).toBeInTheDocument();
  });

  it("warns when the intent was detected against an earlier commit", async () => {
    get.mockResolvedValue(INTENT);
    renderCard("deadbeef");
    expect(await screen.findByText(/detected against an earlier commit/i)).toBeInTheDocument();
  });

  it("does not warn when the intent matches the current head", async () => {
    get.mockResolvedValue(INTENT);
    renderCard("a1b2c3d4");
    await screen.findByText(`“${INTENT.intent}”`);
    expect(screen.queryByText(/detected against an earlier commit/i)).not.toBeInTheDocument();
  });

  it("renders risk-area chips derived from the diff", async () => {
    // Two independent queries share the api mock — route by URL.
    get.mockImplementation((url: string) =>
      url.endsWith("/risks")
        ? Promise.resolve({
            risks: [
              {
                kind: "auth_surface",
                title: "Auth surface touched",
                explanation: "Changes files on the authorization path.",
                severity: "high",
                file_refs: ["src/auth/session.ts"],
              },
              {
                kind: "new_dependency",
                title: "New dependency: ioredis",
                explanation: "Adds ioredis to a package manifest.",
                severity: "medium",
                file_refs: ["package.json"],
              },
            ],
          })
        : Promise.resolve(INTENT),
    );
    renderCard();

    expect(await screen.findByText("Risk areas")).toBeInTheDocument();
    expect(screen.getByText("Auth surface touched")).toBeInTheDocument();
    expect(screen.getByText("New dependency: ioredis")).toBeInTheDocument();
    // The files behind the claim travel with the chip, not just the label.
    expect(screen.getByText("Auth surface touched")).toHaveAttribute(
      "title",
      expect.stringContaining("src/auth/session.ts"),
    );
  });

  it("omits the risk row entirely when the scan found nothing", async () => {
    get.mockImplementation((url: string) =>
      url.endsWith("/risks") ? Promise.resolve({ risks: [] }) : Promise.resolve(INTENT),
    );
    renderCard();

    await screen.findByText(`“${INTENT.intent}”`);
    expect(screen.queryByText("Risk areas")).not.toBeInTheDocument();
  });

  it("re-detects and renders the returned record", async () => {
    get.mockResolvedValue(INTENT);
    post.mockResolvedValue({ ...INTENT, intent: "A freshly derived intent." });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /re-detect/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/pulls/pr-1/intent/detect"));
    expect(await screen.findByText("“A freshly derived intent.”")).toBeInTheDocument();
  });
});
