import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ContextListing, SpecFileContent } from "@devdigest/shared";
import messages from "@/../messages/en/context.json";
import commonMessages from "@/../messages/en/common.json";

/* AppShell is stubbed for the same reason AgentsListView.test.tsx stubs it —
   it pulls in nav, breadcrumbs and the global g-then-key shortcut handler,
   none of which are under test here. */
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

/* The repo now comes from the ROUTE, so useParams is the thing under test in
   the scoping case below. useRouter has to be supplied too: this corpus mocks
   next/navigation by whole-module replacement, and <RepoNotFound /> calls it
   for its CTA — a useParams-only mock passes every other test here and then
   throws the moment the not-found branch renders. */
const useParams = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => useParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

const useActiveRepo = vi.fn();
const useRepoNotFound = vi.fn();
vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => useActiveRepo(),
  useRepoNotFound: (...args: unknown[]) => useRepoNotFound(...args),
}));

/* Two hooks share this module — route by call signature (the arg count
   differs) rather than a blanket mockResolvedValue, per client/INSIGHTS.md
   (2026-08-12): a blanket mock would feed the listing's shape to the preview
   query too. */
const useContextFiles = vi.fn();
const useContextFile = vi.fn();
vi.mock("@/lib/hooks/context", () => ({
  useContextFiles: (...args: unknown[]) => useContextFiles(...args),
  useContextFile: (...args: unknown[]) => useContextFile(...args),
}));

import { ProjectContextView } from "./ProjectContextView";

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ context: messages, common: commonMessages }}>
      <ProjectContextView />
    </NextIntlClientProvider>,
  );
}

const LISTING: ContextListing = {
  cloned: true,
  roots: ["specs", "docs", "insights"],
  total_tokens: 130,
  files: [
    { path: "specs/api.md", type: "specs", bytes: 400, tokens: 100, used_by_agents: 2 },
    { path: "docs/orphan.md", type: "docs", bytes: 120, tokens: 30, used_by_agents: 0 },
  ],
};

const OTHER_LISTING: ContextListing = {
  cloned: true,
  roots: ["specs"],
  total_tokens: 40,
  files: [{ path: "specs/billing.md", type: "specs", bytes: 160, tokens: 40, used_by_agents: 1 }],
};

const OTHER_DOC: SpecFileContent = {
  path: "specs/billing.md",
  content: "# Billing\nInvoices are immutable once sent.",
  bytes: 160,
  tokens: 40,
};

const DOC: SpecFileContent = {
  path: "specs/api.md",
  content: "# API contract\nNever break a public field.",
  bytes: 400,
  tokens: 100,
};

beforeEach(() => {
  useParams.mockReturnValue({ repoId: "repo-1" });
  useActiveRepo.mockReturnValue({ activeRepo: { full_name: "acme/payments-api" } });
  useRepoNotFound.mockReturnValue(false);
  useContextFiles.mockReturnValue({ data: LISTING, isLoading: false, isError: false, refetch: vi.fn() });
  useContextFile.mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

afterEach(() => {
  cleanup();
  useParams.mockReset();
  useActiveRepo.mockReset();
  useRepoNotFound.mockReset();
  useContextFiles.mockReset();
  useContextFile.mockReset();
});

describe("ProjectContextView — list + type badges (AC-37)", () => {
  it("renders every discovered document with its type badge", () => {
    renderView();
    expect(screen.getByText("specs/api.md")).toBeInTheDocument();
    expect(screen.getByText("docs/orphan.md")).toBeInTheDocument();
    expect(screen.getByText("specs")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });

  it("renders a selected document's markdown read-only (AC-37)", () => {
    useContextFile.mockReturnValue({ data: DOC, isLoading: false, isError: false });
    renderView();
    fireEvent.click(screen.getByText("specs/api.md"));
    expect(screen.getByText("Never break a public field.")).toBeInTheDocument();
  });
});

describe("ProjectContextView — used-by count (AC-38)", () => {
  it("shows a document attached by nobody as 0, never hidden (EC-15)", () => {
    renderView();
    expect(screen.getByText("specs/api.md")).toBeInTheDocument();
    expect(screen.getByText("docs/orphan.md")).toBeInTheDocument();
    expect(screen.getByText(/0 agents/)).toBeInTheDocument();
    expect(screen.getByText(/2 agents/)).toBeInTheDocument();
  });
});

describe("ProjectContextView — footer (AC-39)", () => {
  it("states the discovered document count and combined token total", () => {
    renderView();
    expect(screen.getByText(/2 documents.*130 tokens/)).toBeInTheDocument();
  });
});

describe("ProjectContextView — no write path (AC-40, negative criterion)", () => {
  it("exposes no control that creates, edits, uploads or deletes a file", () => {
    renderView();
    for (const label of [/^create$/i, /^edit$/i, /^upload$/i, /^delete$/i, /^new document$/i, /^remove$/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // No file input anywhere on the page — the only way documents change here
    // is by changing the repository itself.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("ProjectContextView — empty and not-cloned states", () => {
  it("names the configured roots when discovery returns no documents (AC-35 precedent)", () => {
    useContextFiles.mockReturnValue({
      data: { cloned: true, roots: ["specs", "docs", "insights"], total_tokens: 0, files: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderView();
    expect(screen.getByText("No documents found")).toBeInTheDocument();
    // The roots appear TWICE — the page subtitle and the empty-state body —
    // so assert the count rather than a single unique match.
    expect(screen.getAllByText(/specs, docs, insights/).length).toBeGreaterThanOrEqual(2);
  });

  it("shows a distinct state when the repository has no clone (AC-36 precedent)", () => {
    useContextFiles.mockReturnValue({
      data: { cloned: false, roots: ["specs", "docs", "insights"], total_tokens: 0, files: [] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderView();
    expect(screen.getByText("Repository not cloned yet")).toBeInTheDocument();
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
  });
});

describe("ProjectContextView — repo scoping (/repos/:repoId/context)", () => {
  /* Two repos with two different corpora, so "which repo is on screen" is
     something the READER can see, not something a spy's call log knows. Before
     the move the repo came from localStorage / "first repo from the API" and
     the URL had no say at all — so repo-1's documents rendered here. */
  it("shows the documents of the repo named in the URL", () => {
    useContextFiles.mockImplementation((repoId: string) => ({
      data: repoId === "repo-2" ? OTHER_LISTING : LISTING,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }));
    useParams.mockReturnValue({ repoId: "repo-2" });

    renderView();

    expect(screen.getByText("specs/billing.md")).toBeInTheDocument();
    expect(screen.queryByText("specs/api.md")).not.toBeInTheDocument();
  });

  it("reads a document preview from that same repo", () => {
    useContextFiles.mockImplementation((repoId: string) => ({
      data: repoId === "repo-2" ? OTHER_LISTING : LISTING,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }));
    useContextFile.mockImplementation((repoId: string, path: string | null) => ({
      data: repoId === "repo-2" && path ? OTHER_DOC : undefined,
      isLoading: false,
      isError: false,
    }));
    useParams.mockReturnValue({ repoId: "repo-2" });

    renderView();
    fireEvent.click(screen.getByText("specs/billing.md"));

    expect(screen.getByText("Invoices are immutable once sent.")).toBeInTheDocument();
  });

  it("shows the shared not-found state for a stale :repoId instead of an error", () => {
    useRepoNotFound.mockReturnValue(true);
    renderView();
    expect(screen.getByText("No repo selected")).toBeInTheDocument();
    // ...and it does NOT fall through to the listing.
    expect(screen.queryByText("specs/api.md")).not.toBeInTheDocument();
  });
});
