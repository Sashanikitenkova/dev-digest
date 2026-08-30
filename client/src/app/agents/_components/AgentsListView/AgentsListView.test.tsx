import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent } from "@devdigest/shared";
import messages from "../../../../../messages/en/agents.json";

/* Regression guard for a wiring bug, not a rendering one: AgentCard has always
   been able to render the skills badge, and the i18n string has always existed
   — the list simply never passed the number down, so the badge was dead code
   that only its own unit test ever exercised.

   AppShell is stubbed because no other test in this corpus mounts it (it pulls
   in nav, breadcrumbs and the global g-then-key shortcut handler); everything
   under test here — the map over agents and the prop it passes — stays real. */
vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const useAgents = vi.fn();
vi.mock("../../../../lib/hooks/agents", () => ({
  useAgents: () => useAgents(),
  useUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  // AgentCard's own delete button reaches for this.
  useDeleteAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AgentsListView } from "./AgentsListView";

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Finds injection and secret leaks",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "You are a reviewer.",
  output_schema: null,
  enabled: true,
  version: 2,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};

function renderList() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agents: messages }}>
      <AgentsListView />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useAgents.mockReset();
});

describe("AgentsListView", () => {
  it("passes each agent's skills_count down to its card", () => {
    useAgents.mockReturnValue({
      data: [{ ...AGENT, skills_count: 3 }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderList();
    expect(screen.getByText("3 skills")).toBeInTheDocument();
  });

  it("still renders the badge for an agent with no enabled skills", () => {
    useAgents.mockReturnValue({
      data: [{ ...AGENT, skills_count: 0 }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderList();
    expect(screen.getByText("0 skills")).toBeInTheDocument();
  });

  it("omits the badge when the server sent no count at all", () => {
    useAgents.mockReturnValue({
      data: [AGENT],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderList();
    expect(screen.queryByText(/skills$/)).not.toBeInTheDocument();
  });
});
