import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";

vi.mock("../../../../../../../lib/hooks/reviews", () => ({
  useFindingAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { FindingsPanel } from "./FindingsPanel";

afterEach(cleanup);

const FINDINGS: FindingRecord[] = [
  {
    id: "f1",
    severity: "CRITICAL",
    category: "security",
    title: "Hardcoded secret",
    file: "src/config.ts",
    start_line: 11,
    end_line: 11,
    rationale: "A secret is committed.",
    suggestion: null,
    confidence: 0.95,
    kind: "finding",
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
  },
];

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingsPanel (smoke)", () => {
  it("renders the toolbar + a finding card", () => {
    renderWithIntl(<FindingsPanel findings={FINDINGS} prId="pr1" />);
    expect(screen.getByText("Hide low confidence")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
  });

  it("shows the empty state when nothing matches", () => {
    renderWithIntl(<FindingsPanel findings={[]} prId="pr1" />);
    expect(screen.getByText("No findings match")).toBeInTheDocument();
  });

  describe("out-of-scope findings", () => {
    const demoted: FindingRecord = {
      ...FINDINGS[0]!,
      id: "f2",
      severity: "SUGGESTION",
      category: "style",
      title: "Inconsistent indentation",
      out_of_scope: true,
      scope_note: 'demoted WARNING→SUGGESTION; outside stated scope: "src/theme.css"',
    };

    it("collapses them by default but names the count", () => {
      renderWithIntl(<FindingsPanel findings={[...FINDINGS, demoted]} prId="pr1" />);
      expect(screen.getByText("Hide 1 out of scope")).toBeInTheDocument();
      expect(screen.queryByText("Inconsistent indentation")).not.toBeInTheDocument();
      // The in-scope finding is unaffected.
      expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
    });

    it("reveals them when the toggle is switched off", () => {
      renderWithIntl(<FindingsPanel findings={[...FINDINGS, demoted]} prId="pr1" />);
      // The out-of-scope toggle is the only switch that starts on.
      fireEvent.click(screen.getByRole("switch", { checked: true }));
      expect(screen.getByText("Inconsistent indentation")).toBeInTheDocument();
    });

    it("offers no toggle when nothing was demoted", () => {
      renderWithIntl(<FindingsPanel findings={FINDINGS} prId="pr1" />);
      expect(screen.queryByText(/out of scope/)).not.toBeInTheDocument();
    });
  });
});
