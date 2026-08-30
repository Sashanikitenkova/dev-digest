import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import { FindingCard } from "./FindingCard";

afterEach(cleanup);

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "security",
  title: "Hardcoded Stripe secret key",
  file: "src/config.ts",
  start_line: 11,
  end_line: 11,
  rationale: "A **live** Stripe key is committed in source.",
  suggestion: "Move the key to an environment variable.",
  confidence: 0.95,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingCard (smoke, both themes)", () => {
  (["dark", "light"] as const).forEach((theme) => {
    it(`renders severity + file:line + rationale in ${theme}`, () => {
      renderWithIntl(
        <div data-theme={theme}>
          <FindingCard f={FINDING} defaultExpanded onAction={() => {}} />
        </div>,
      );
      expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
      expect(screen.getByText("src/config.ts:11")).toBeInTheDocument();
      // category label is shown alongside the severity badge
      expect(screen.getByText("security")).toBeInTheDocument();
    });
  });

  it("expands and scrolls itself when it is the deep-link target", () => {
    // jsdom has no scrollIntoView; the call is what we assert on.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderWithIntl(<FindingCard f={FINDING} isTarget onAction={() => {}} />);

    // Body content is only in the DOM while expanded.
    expect(screen.getByText("Move the key to an environment variable.")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("stays collapsed when it is not the target", () => {
    renderWithIntl(<FindingCard f={FINDING} onAction={() => {}} />);
    expect(
      screen.queryByText("Move the key to an environment variable."),
    ).not.toBeInTheDocument();
  });

  it("fires accept/dismiss actions", () => {
    const onAction = vi.fn();
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onAction={onAction} />);
    fireEvent.click(screen.getByText("Accept"));
    expect(onAction).toHaveBeenCalledWith("accept");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });
});

describe("FindingCard — turn into eval case (SPEC-03)", () => {
  it("is not rendered at all when the parent supplies no handler", () => {
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onAction={() => {}} />);
    expect(screen.queryByText("Turn into eval case")).not.toBeInTheDocument();
  });

  it("stays disabled until the finding has been accepted or dismissed", () => {
    // An eval case records a decision the reviewer already made. An undecided
    // finding is not a label, so offering to freeze it would seed the gold set
    // with unreviewed model output.
    const onCreateEvalCase = vi.fn();
    renderWithIntl(
      <FindingCard f={FINDING} defaultExpanded onAction={() => {}} onCreateEvalCase={onCreateEvalCase} />,
    );
    const button = screen.getByText("Turn into eval case");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCreateEvalCase).not.toHaveBeenCalled();
  });

  it("becomes clickable once the finding is accepted", () => {
    const onCreateEvalCase = vi.fn();
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-30T10:00:00.000Z" }}
        defaultExpanded
        onAction={() => {}}
        onCreateEvalCase={onCreateEvalCase}
      />,
    );
    fireEvent.click(screen.getByText("Turn into eval case"));
    expect(onCreateEvalCase).toHaveBeenCalledTimes(1);
  });

  it("becomes clickable once the finding is dismissed", () => {
    const onCreateEvalCase = vi.fn();
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, dismissed_at: "2026-08-30T10:00:00.000Z" }}
        defaultExpanded
        onAction={() => {}}
        onCreateEvalCase={onCreateEvalCase}
      />,
    );
    fireEvent.click(screen.getByText("Turn into eval case"));
    expect(onCreateEvalCase).toHaveBeenCalledTimes(1);
  });

  it("reads as already-in-set and refuses a second click once a case exists", () => {
    // A silent duplicate would double this finding's weight in the metrics.
    const onCreateEvalCase = vi.fn();
    renderWithIntl(
      <FindingCard
        f={{ ...FINDING, accepted_at: "2026-08-30T10:00:00.000Z" }}
        defaultExpanded
        onAction={() => {}}
        onCreateEvalCase={onCreateEvalCase}
        inEvalSet
      />,
    );
    const button = screen.getByText("In eval set");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCreateEvalCase).not.toHaveBeenCalled();
  });
});
