import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReviewRecord, RunSummary } from "@devdigest/shared";
import brief from "../../../../../../../../messages/en/brief.json";
import prReview from "../../../../../../../../messages/en/prReview.json";
import { PrBriefHeader } from "./PrBriefHeader";

afterEach(cleanup);

const FINDING = {
  review_id: "rev-1",
  accepted_at: null,
  dismissed_at: null,
} as unknown as ReviewRecord["findings"][number];

const REVIEW: ReviewRecord = {
  id: "rev-1",
  pr_id: "pr-1",
  agent_id: "agent-1",
  run_id: "run-1",
  agent_name: "Reviewer",
  kind: "review",
  verdict: "request_changes",
  summary: "Solid middleware approach, but a secret key is committed in plaintext.",
  score: 61,
  model: "gpt-4.1",
  grounding: null,
  created_at: "2026-08-11T10:00:00.000Z",
  findings: [
    { ...FINDING, severity: "CRITICAL" },
    { ...FINDING, severity: "CRITICAL", dismissed_at: "2026-08-11T11:00:00.000Z" },
    { ...FINDING, severity: "WARNING" },
  ] as ReviewRecord["findings"],
};

const RUN = {
  run_id: "run-1",
  tokens_in: 8234,
  tokens_out: 1290,
  cost_usd: 0.0142,
} as unknown as RunSummary;

function renderHeader(reviews: ReviewRecord[], runs?: RunSummary[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ brief, prReview }}>
      <PrBriefHeader reviews={reviews} runs={runs} />
    </NextIntlClientProvider>,
  );
}

describe("PrBriefHeader", () => {
  it("renders the verdict, summary and score of the newest review", () => {
    renderHeader([REVIEW], [RUN]);

    expect(screen.getByText("Request changes")).toBeInTheDocument();
    expect(screen.getByText(/secret key is committed in plaintext/)).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText("PR SCORE")).toBeInTheDocument();
  });

  it("counts blockers as undismissed CRITICAL findings only", () => {
    // Two CRITICALs, one of them dismissed → one blocker, three findings.
    renderHeader([REVIEW], [RUN]);
    expect(screen.getByText(/3 findings · 1 blockers/)).toBeInTheDocument();
  });

  it("shows the cost and token footnote from the review's run", () => {
    renderHeader([REVIEW], [RUN]);
    expect(screen.getByText("$0.014")).toBeInTheDocument();
    expect(screen.getByText("8.2K→1.3K")).toBeInTheDocument();
  });

  it("keeps the verdict when the run row is gone, just without the footnote", () => {
    renderHeader([REVIEW], []);
    expect(screen.getByText("Request changes")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("skips a review that never produced a verdict", () => {
    const noVerdict: ReviewRecord = { ...REVIEW, id: "rev-0", verdict: null, findings: [] };
    renderHeader([noVerdict, REVIEW], [RUN]);
    expect(screen.getByText("Request changes")).toBeInTheDocument();
  });

  it("renders an empty state when the PR has never been reviewed", () => {
    renderHeader([]);
    expect(screen.getByText("Brief not available yet.")).toBeInTheDocument();
    expect(screen.getByText(/Run a review or open the PR/)).toBeInTheDocument();
  });
});
