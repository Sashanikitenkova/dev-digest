/* PrBriefCard — the Why + Risk brief on the PR Overview tab.

   Mocked at `lib/api`, not at the hook: the hooks' cache-writing behaviour (a
   mutation writing the canonical record with setQueryData) is part of what is
   under test. `@testing-library/user-event` is not installed here — fireEvent. */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../../../../../messages/en/prBrief.json";
import { ApiError } from "../../../../../../../lib/api";
import { PrBriefCard } from "./PrBriefCard";

const get = vi.fn();
const post = vi.fn();
vi.mock("../../../../../../../lib/api", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
  // Mirrors the real signature exactly — (message, status, code) — so the
  // mock cannot drift from what the card actually branches on.
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
}));

const CHANGED = ["src/config.ts", "src/middleware/ratelimit.ts"];

const brief = (over: Record<string, unknown> = {}) => ({
  pr_id: "pr-1",
  what: "Adds a token-bucket rate limiter to the public API routes.",
  why: "Unauthenticated clients were able to abuse the public endpoints.",
  risk_level: "high",
  risks: [
    {
      severity: "high",
      summary: "A live Stripe key is committed in plaintext.",
      reference: { file: "src/config.ts", line: 12 },
    },
  ],
  review_focus: [
    {
      summary: "live Stripe key committed in plaintext",
      reference: { file: "src/config.ts", line: 12 },
    },
    {
      summary: "caller that is not part of this diff",
      reference: { file: "src/server.ts", line: 88 },
    },
    {
      summary: "endpoint with no file to open",
      reference: { endpoint: "GET /api/public/items" },
    },
  ],
  inputs: [],
  counts: { risks_proposed: 1, risks_kept: 1, focus_proposed: 3, focus_kept: 3 },
  head_sha: "head-one",
  generated_at: "2026-08-29T07:00:00.000Z",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-pro",
  tokens_in: 3200,
  tokens_out: 400,
  cost_usd: 0.0077,
  ...over,
});

function renderCard(props: Partial<React.ComponentProps<typeof PrBriefCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onFocusFile = props.onFocusFile ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ prBrief: messages }}>
        <PrBriefCard
          prId="pr-1"
          headSha="head-one"
          repoFullName="acme/payments-api"
          changedFiles={CHANGED}
          onFocusFile={onFocusFile}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onFocusFile };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});
afterEach(cleanup);

describe("PrBriefCard — what, why and risk level", () => {
  it("renders what, why and the risk level as TEXT, not colour alone", async () => {
    get.mockResolvedValue(brief());
    renderCard();
    expect(await screen.findByText(/token-bucket rate limiter/)).toBeInTheDocument();
    expect(screen.getByText(/Unauthenticated clients/)).toBeInTheDocument();
    // AC-40: a reader who cannot see the colour still gets the level. It appears
    // twice by design — the card's level pill, and this risk's severity tag.
    expect(screen.getAllByText("High risk").length).toBeGreaterThan(0);
  });

  it("renders each risk with its severity, summary and reference", async () => {
    get.mockResolvedValue(brief());
    renderCard();
    expect(await screen.findByText(/live Stripe key is committed/)).toBeInTheDocument();
    expect(screen.getAllByText(/src\/config\.ts:12/).length).toBeGreaterThan(0);
  });

  it("renders model output as text — an HTML payload is never interpreted", async () => {
    get.mockResolvedValue(
      brief({ what: '<img src=x onerror="alert(1)"> injected' }),
    );
    const { container } = { container: document.body };
    renderCard();
    await screen.findByText(/injected/);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("PrBriefCard — review focus navigation", () => {
  it("calls onFocusFile once for a file inside this PR's diff", async () => {
    get.mockResolvedValue(brief());
    const { onFocusFile } = renderCard();
    const row = await screen.findByRole("button", { name: /live Stripe key committed/ });
    fireEvent.click(row);
    expect(onFocusFile).toHaveBeenCalledTimes(1);
    expect(onFocusFile).toHaveBeenCalledWith("src/config.ts", 12);
  });

  it("links an out-of-diff file to github.com pinned to the head SHA", async () => {
    get.mockResolvedValue(brief());
    renderCard();
    const link = await screen.findByRole("link", { name: /caller that is not part/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/acme/payments-api/blob/head-one/src/server.ts"),
    );
    expect(link.getAttribute("href")).toContain("#L88");
  });

  it("renders an endpoint-only reference as non-navigating text", async () => {
    get.mockResolvedValue(brief());
    renderCard();
    await screen.findByText(/endpoint with no file/);
    // Neither a link nor a dead control announced as a control.
    expect(
      screen.queryByRole("link", { name: /endpoint with no file/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /endpoint with no file/ }),
    ).not.toBeInTheDocument();
  });

  it("counts the rows it actually drew", async () => {
    get.mockResolvedValue(brief());
    renderCard();
    await screen.findByText(/live Stripe key committed/);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("says no order could be grounded instead of showing a (0) badge", async () => {
    get.mockResolvedValue(
      brief({ review_focus: [], counts: { risks_proposed: 1, risks_kept: 1, focus_proposed: 4, focus_kept: 0 } }),
    );
    renderCard();
    expect(await screen.findByText(/No reading order could be grounded/)).toBeInTheDocument();
  });
});

describe("PrBriefCard — states", () => {
  it("offers a generate action when no brief is stored, and posts once", async () => {
    get.mockResolvedValue(null);
    post.mockResolvedValue(brief());
    renderCard();
    const cta = await screen.findByRole("button", { name: /Generate brief/ });
    fireEvent.click(cta);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/pulls/pr-1/brief"));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("regenerate targets the explicit regenerate route", async () => {
    get.mockResolvedValue(brief());
    post.mockResolvedValue(brief());
    renderCard();
    const button = await screen.findByRole("button", { name: /Regenerate/ });
    fireEvent.click(button);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/pulls/pr-1/brief/regenerate"),
    );
  });

  it("shows a stale notice ALONGSIDE the retained content, not instead of it", async () => {
    get.mockResolvedValue(brief({ head_sha: "an-older-head" }));
    renderCard({ headSha: "head-one" });
    expect(await screen.findByText(/no longer this pull request's head/)).toBeInTheDocument();
    // AC-50: the brief is still readable while stale.
    expect(screen.getByText(/token-bucket rate limiter/)).toBeInTheDocument();
    expect(screen.getByText(/live Stripe key committed/)).toBeInTheDocument();
  });

  it("renders the engine's own error, and the card survives it", async () => {
    get.mockResolvedValue(brief());
    post.mockRejectedValue(
      new ApiError("This pull request's mandatory inputs exceed the budget", 422),
    );
    renderCard();
    const button = await screen.findByRole("button", { name: /Regenerate/ });
    fireEvent.click(button);
    expect(await screen.findByText(/mandatory inputs exceed the budget/)).toBeInTheDocument();
    // The rest of the brief is still on screen — a failure costs the action,
    // not the page.
    expect(screen.getByText(/token-bucket rate limiter/)).toBeInTheDocument();
  });

  it("renders nothing fatal when the brief query itself fails", async () => {
    get.mockRejectedValue(new ApiError("engine unreachable", 0));
    renderCard();
    // No throw, no blank screen: the section label is always present.
    expect(await screen.findByText(/Why & risk/)).toBeInTheDocument();
  });
});

describe("PrBriefCard — accessible names and in-flight state", () => {
  it("names each focus row by its path, line AND summary (AC-48)", async () => {
    get.mockResolvedValue(brief());
    renderCard();

    // An accessible name of the summary alone would satisfy a getByText query
    // but leave a screen-reader user without the location. Assert the whole
    // computed name, which is what a reader actually hears.
    const inDiff = await screen.findByRole("button", {
      name: /src\/config\.ts:12.*live Stripe key committed in plaintext/,
    });
    expect(inDiff).toBeInTheDocument();

    const outOfDiff = screen.getByRole("link", {
      name: /src\/server\.ts:88.*caller that is not part of this diff/,
    });
    expect(outOfDiff).toBeInTheDocument();
  });

  it("names a symbol-only row without inventing a file (AC-41, AC-47)", async () => {
    get.mockResolvedValue(
      brief({
        review_focus: [
          {
            summary: "the consume path is where the limiter can go wrong",
            reference: { symbol: "consume" },
          },
        ],
        counts: { risks_proposed: 1, risks_kept: 1, focus_proposed: 1, focus_kept: 1 },
      }),
    );
    renderCard();

    expect(await screen.findByText(/the consume path is where/)).toBeInTheDocument();
    // The symbol is rendered as its own labelled pointer ("symbol consume"),
    // not folded into the prose — so a reader can tell what kind of thing it is.
    expect(screen.getAllByText(/^symbol consume$/).length).toBeGreaterThan(0);
    // Nothing to open: it must not become a link or a dead button.
    expect(screen.queryByRole("link", { name: /consume path/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /consume path/ })).toBeNull();
  });

  it("carries the HTTP status alongside the engine's message (AC-52)", async () => {
    get.mockResolvedValue(brief());
    post.mockRejectedValue(new ApiError("the cl100k_base encoder failed to load", 503));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /Regenerate/ }));

    // The status is half the diagnosis — a 503 and a 422 mean different next
    // steps, and the card promises to show which one happened.
    expect(await screen.findByText(/encoder failed to load/)).toBeInTheDocument();
    expect(screen.getByText(/503/)).toBeInTheDocument();
  });

  it("disables both controls while a generation is in flight, and posts once (AC-51)", async () => {
    get.mockResolvedValue(brief());
    let release!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => {
      release = r;
    }));
    renderCard();

    const button = await screen.findByRole("button", { name: /Regenerate/ });
    fireEvent.click(button);

    // The AC's operative condition: while pending, the control cannot be used
    // again. Without this, a double click bills twice.
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);

    release(brief());
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("focusParams — the deep link the card hands the page (AC-45)", () => {
  it("names the diff tab, the file and the line in ONE parameter object", async () => {
    const { focusParams } = await import("./index");
    expect(focusParams("diff", "src/config.ts", 12)).toEqual({
      tab: "diff",
      file: "src/config.ts",
      line: "12",
    });
  });

  it("omits the line when the reference carries none", async () => {
    const { focusParams } = await import("./index");
    const params = focusParams("diff", "src/config.ts", null);
    expect(params.file).toBe("src/config.ts");
    expect(params.line ?? null).toBeNull();
  });
});
