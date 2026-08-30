import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";

const setSkillsMutate = vi.fn();
const toggleMutate = vi.fn();
const links: AgentSkillLink[] = [
  { agent_id: "ag1", skill_id: "sk-a", order: 0, enabled: true },
  { agent_id: "ag1", skill_id: "sk-b", order: 1, enabled: false },
  { agent_id: "ag1", skill_id: "sk-c", order: 2, enabled: true },
];

vi.mock("../../../../../../../lib/hooks/agents", () => ({
  useAgentSkills: () => ({ data: links, isError: false }),
  useSetAgentSkills: () => ({ mutate: setSkillsMutate, isError: false }),
  useToggleAgentSkill: () => ({ mutate: toggleMutate, isError: false }),
}));

vi.mock("../../../../../../../lib/hooks/skills", () => ({
  useSkills: () => ({ data: SKILLS }),
}));

import { SkillsTab } from "./SkillsTab";

const skill = (id: string, name: string): Skill => ({
  id,
  name,
  // Deliberately does NOT repeat the name — the ordering assertions below
  // query by text and would otherwise match the description too.
  description: `Rule ${id}`,
  type: "custom",
  source: "manual",
  body: "# body",
  enabled: true,
  version: 1,
});

const SKILLS: Skill[] = [
  skill("sk-a", "test-coverage-nudge"),
  skill("sk-b", "no-then-chains"),
  skill("sk-c", "pr-quality-rubric"),
  skill("sk-d", "phantom-api-gate"),
];

const AGENT: Agent = {
  id: "ag1",
  name: "Test Quality Reviewer",
  description: "",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <SkillsTab agent={AGENT} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  setSkillsMutate.mockClear();
  toggleMutate.mockClear();
});
afterEach(cleanup);

describe("Agent editor — Skills tab", () => {
  it("lists linked skills in order with the enabled count", () => {
    renderTab();
    expect(screen.getByText("2 of 3 enabled")).toBeInTheDocument();
    const names = screen.getAllByText(/test-coverage-nudge|no-then-chains|pr-quality-rubric/);
    expect(names.map((n) => n.textContent)).toEqual([
      "test-coverage-nudge",
      "no-then-chains",
      "pr-quality-rubric",
    ]);
  });

  it("keeps a disabled link in the list — order stays meaningful when it is off", () => {
    renderTab();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
  });

  it("toggling a row checkbox PUTs that one link", () => {
    renderTab();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(toggleMutate).toHaveBeenCalledWith({ agentId: "ag1", skillId: "sk-a", enabled: false });
  });

  it("re-enabling an off link sends enabled: true", () => {
    renderTab();
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(toggleMutate).toHaveBeenCalledWith({ agentId: "ag1", skillId: "sk-b", enabled: true });
  });

  it("moving a row down POSTs the whole new skill_ids order", () => {
    renderTab();
    fireEvent.click(screen.getByLabelText("Move test-coverage-nudge later in the prompt"));
    expect(setSkillsMutate).toHaveBeenCalledWith({
      agentId: "ag1",
      skillIds: ["sk-b", "sk-a", "sk-c"],
    });
  });

  it("moving a row up POSTs the whole new skill_ids order", () => {
    renderTab();
    fireEvent.click(screen.getByLabelText("Move pr-quality-rubric earlier in the prompt"));
    expect(setSkillsMutate).toHaveBeenCalledWith({
      agentId: "ag1",
      skillIds: ["sk-a", "sk-c", "sk-b"],
    });
  });

  it("does not move the first row above itself", () => {
    renderTab();
    fireEvent.click(screen.getByLabelText("Move test-coverage-nudge earlier in the prompt"));
    expect(setSkillsMutate).not.toHaveBeenCalled();
  });

  it("filters the list and hides reorder controls while filtering", () => {
    renderTab();
    fireEvent.change(screen.getByLabelText("Filter skills…"), { target: { value: "then" } });
    expect(screen.getByText("no-then-chains")).toBeInTheDocument();
    expect(screen.queryByText("pr-quality-rubric")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Move no-then-chains/)).not.toBeInTheDocument();
    // The count still reflects every link, not just the visible ones.
    expect(screen.getByText("2 of 3 enabled")).toBeInTheDocument();
  });

  it("shows the no-match note when the filter matches nothing", () => {
    renderTab();
    fireEvent.change(screen.getByLabelText("Filter skills…"), { target: { value: "zzz" } });
    expect(screen.getByText("No linked skill matches that filter.")).toBeInTheDocument();
  });

  it("unlinking POSTs the remaining links", () => {
    renderTab();
    const rows = screen.getAllByLabelText("Unlink");
    fireEvent.click(rows[1]!);
    expect(setSkillsMutate).toHaveBeenCalledWith({ agentId: "ag1", skillIds: ["sk-a", "sk-c"] });
  });

  it("explains that order drives the assembled prompt", () => {
    const { container } = renderTab();
    expect(
      within(container).getByText(/earlier skills appear earlier in the assembled prompt/i),
    ).toBeInTheDocument();
  });
});
