import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../../messages/en/agents.json";
// ContextFilesPicker declares the `context` namespace for its own chrome while
// title/note arrive as props from `agents` — so the provider needs BOTH, or the
// picker throws MISSING_MESSAGE (client/INSIGHTS.md, 2026-07-19).
import contextMessages from "../../../../../../messages/en/context.json";
import { ToastProvider } from "../../../../../lib/toast";
import { ApiError } from "../../../../../lib/api";

// Mock the data hooks so the editor renders without a network/query client.
vi.mock("../../../../../lib/hooks/agents", () => ({
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined }),
  useProviderModels: () => ({ data: [{ id: "gpt-4.1", provider: "openai" }] }),
}));

// ContextTab calls three data hooks of its own; stub them at the module
// boundary so the tab can be mounted without a query client.
const setAgentContext = vi.fn(() => ({ mutate: vi.fn(), isError: false, error: null as unknown }));
vi.mock("../../../../../lib/hooks/context", () => ({
  useContextFiles: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useAgentContext: () => ({ data: { paths: [] }, isError: false }),
  useSetAgentContext: () => setAgentContext(),
  useContextFile: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock("../../../../../lib/repo-context", () => ({
  useActiveRepo: () => ({ repoId: "repo-1", repos: [], activeRepo: null, reposLoaded: true, setRepoId: vi.fn() }),
}));

import { AgentEditor } from "./AgentEditor";
import { TABS, VALID_TABS } from "./constants";

afterEach(cleanup);

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: messages, context: contextMessages }}>
      <ToastProvider>{ui}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

describe("A2 Agent Editor (smoke)", () => {
  it("renders the Config tab fields", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="config" onTab={() => {}} />);
    expect(screen.getByText("Config")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Save agent")).toBeInTheDocument();
  });
});

describe("A2 Agent Editor — every tab is routable", () => {
  it("accepts every declared tab key in ?tab=", () => {
    // The route rejects an unknown `?tab=` and silently falls back to `config`,
    // so a whitelist that lags behind TABS makes the missing tab UNREACHABLE:
    // the click sets the query param and the next render throws it away. That
    // is what happened to `context` while the page kept its own hardcoded
    // ["config", "skills"] literal. Deriving VALID_TABS from TABS is what makes
    // this assertion true by construction.
    for (const t of TABS) {
      expect(VALID_TABS).toContain(t.key);
    }
    expect(VALID_TABS).toContain("context");
  });

  it("renders the Context pane when tab=context, not the Config pane", () => {
    renderWithIntl(<AgentEditor agent={AGENT} tab="context" onTab={() => {}} />);
    expect(screen.getByText("Project context to read")).toBeInTheDocument();
    // The Config pane's save button must be gone — proof the switch happened
    // rather than the editor quietly staying on Config.
    expect(screen.queryByText("Save agent")).not.toBeInTheDocument();
  });
});

describe("A2 Agent Editor — a failed save says what actually failed", () => {
  it("renders the ApiError's message and status, not a generic sentence", () => {
    // The generic copy made a 404, a 422 and an unreachable API indistinguishable
    // on screen — which is exactly when the difference matters.
    setAgentContext.mockReturnValueOnce({
      mutate: vi.fn(),
      isError: true,
      error: new ApiError("Agent not found", 404, "not_found"),
    });
    renderWithIntl(<AgentEditor agent={AGENT} tab="context" onTab={() => {}} />);
    expect(screen.getByText(/Agent not found/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 404/)).toBeInTheDocument();
  });

  it("falls back to the generic sentence for a non-ApiError throw", () => {
    setAgentContext.mockReturnValueOnce({
      mutate: vi.fn(),
      isError: true,
      error: new Error("boom"),
    });
    renderWithIntl(<AgentEditor agent={AGENT} tab="context" onTab={() => {}} />);
    expect(screen.getByText("Couldn’t save the change")).toBeInTheDocument();
  });
});
