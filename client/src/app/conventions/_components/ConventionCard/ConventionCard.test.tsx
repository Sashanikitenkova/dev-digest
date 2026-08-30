import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ConventionCandidate } from "@devdigest/shared";
import messages from "../../../../../messages/en/conventions.json";
import { ConventionCard } from "./ConventionCard";
import { evidenceLabel, confidenceColor } from "./helpers";

afterEach(cleanup);

const REPO = { owner: "acme", name: "payments-api", default_branch: "main" };

const CONVENTION: ConventionCandidate = {
  id: "c1",
  category: "naming",
  rule: "Always use async/await instead of .then() chains",
  evidence_path: "src/api/users.ts",
  evidence_line: 23,
  evidence_snippet: "const user = await db.users.find(id);",
  confidence: 0.91,
  status: "pending",
  created_at: "2026-07-19T10:00:00.000Z",
};

function renderCard(over: Partial<ConventionCandidate> = {}, props: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ conventions: messages }}>
      <ConventionCard
        convention={{ ...CONVENTION, ...over }}
        repo={REPO}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("ConventionCard", () => {
  it("renders the rule, category and the real evidence snippet", () => {
    renderCard();
    expect(screen.getByText(CONVENTION.rule)).toBeInTheDocument();
    expect(screen.getByText("naming")).toBeInTheDocument();
    expect(screen.getByText(CONVENTION.evidence_snippet)).toBeInTheDocument();
  });

  it("shows confidence as a whole percentage", () => {
    renderCard();
    expect(screen.getByText("91%")).toBeInTheDocument();
  });

  it("links the evidence to the exact line on GitHub", () => {
    renderCard();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/main/src/api/users.ts#L23",
    );
  });

  it("renders evidence as plain text (no link) when the repo is unknown", () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ conventions: messages }}>
        <ConventionCard convention={CONVENTION} repo={null} onAccept={vi.fn()} onReject={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("src/api/users.ts:23")).toBeInTheDocument();
  });

  it("fires onAccept / onReject", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    renderCard({}, { onAccept, onReject });
    fireEvent.click(screen.getByText("Accept"));
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Reject"));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("reflects accepted state in the button label", () => {
    renderCard({ status: "accepted" });
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });
});

describe("evidenceLabel", () => {
  it("renders a single line as file:line", () => {
    expect(evidenceLabel(CONVENTION)).toBe("src/api/users.ts:23");
  });

  it("renders a multi-line snippet as a file:line-range", () => {
    const label = evidenceLabel({
      ...CONVENTION,
      evidence_snippet: "line one\nline two\nline three",
    });
    expect(label).toBe("src/api/users.ts:23-25");
  });

  it("ignores blank lines when sizing the range", () => {
    const label = evidenceLabel({ ...CONVENTION, evidence_snippet: "line one\n\n\nline two" });
    expect(label).toBe("src/api/users.ts:23-24");
  });

  it("falls back to the bare path when there is no line", () => {
    expect(evidenceLabel({ ...CONVENTION, evidence_line: null })).toBe("src/api/users.ts");
  });
});

describe("confidenceColor", () => {
  it("bands high / medium / low", () => {
    expect(confidenceColor(0.9)).toBe("var(--ok)");
    expect(confidenceColor(0.7)).toBe("var(--warn)");
    expect(confidenceColor(0.3)).toBe("var(--text-muted)");
  });
});
