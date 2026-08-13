import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill, SkillStats } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/skills.json";
import { formatRate, toSegments } from "./helpers";

const useSkillStats = vi.fn();

vi.mock("../../../../../../../lib/hooks/skills", () => ({
  useSkillStats: (id: string) => useSkillStats(id),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { StatsTab } from "./StatsTab";

const SKILL: Skill = {
  id: "sk1",
  name: "pr-quality-rubric",
  description: "Rubric",
  type: "rubric",
  source: "manual",
  body: "# PR Quality Rubric",
  enabled: true,
  version: 5,
};

const STATS: SkillStats = {
  skill_id: "sk1",
  used_by_agents: 3,
  linked_agents: 4,
  pull_frequency: 0.71,
  accept_rate: 0.74,
  findings_30d: 96,
  findings_by_category: [
    { category: "security", count: 52 },
    { category: "bug", count: 20 },
  ],
  agents: [
    { id: "ag1", name: "Security Reviewer" },
    { id: "ag2", name: "Performance Reviewer" },
  ],
};

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <StatsTab skill={SKILL} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useSkillStats.mockReset();
});

describe("StatsTab", () => {
  it("renders the four tiles, the agent list and the category legend", () => {
    useSkillStats.mockReturnValue({ data: STATS, isLoading: false, isError: false });
    renderTab();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("71")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
    expect(screen.getByText("96")).toBeInTheDocument();
    expect(screen.getByText("Security Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Performance Reviewer")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
  });

  it("states that findings are association, not attribution", () => {
    useSkillStats.mockReturnValue({ data: STATS, isLoading: false, isError: false });
    renderTab();
    expect(screen.getByText(/association, not attribution/)).toBeInTheDocument();
  });

  it("renders counts without decimals — the donut defaults to a currency format", () => {
    useSkillStats.mockReturnValue({ data: STATS, isLoading: false, isError: false });
    renderTab();
    expect(screen.getByText("52")).toBeInTheDocument();
    expect(screen.queryByText("52.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$52.00")).not.toBeInTheDocument();
  });

  it("shows '—' for a rate with no evidence rather than 0%", () => {
    useSkillStats.mockReturnValue({
      data: { ...STATS, pull_frequency: null, accept_rate: null },
      isLoading: false,
      isError: false,
    });
    renderTab();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("71")).not.toBeInTheDocument();
  });

  it("zero-states an unlinked skill instead of erroring", () => {
    useSkillStats.mockReturnValue({
      data: {
        ...STATS,
        used_by_agents: 0,
        linked_agents: 0,
        agents: [],
        findings_30d: 0,
        findings_by_category: [],
      },
      isLoading: false,
      isError: false,
    });
    renderTab();
    expect(screen.getByText("No agent links this skill yet.")).toBeInTheDocument();
    expect(screen.getByText("No findings in the last 30 days.")).toBeInTheDocument();
  });

  it("offers a retry when the request fails", () => {
    const refetch = vi.fn();
    useSkillStats.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderTab();
    expect(screen.getByText("Could not load stats.")).toBeInTheDocument();
  });
});

describe("formatRate", () => {
  it("rounds a 0..1 rate to whole percent", () => {
    expect(formatRate(0.714)).toBe("71");
    expect(formatRate(0)).toBe("0");
  });

  it("keeps null distinct from zero", () => {
    expect(formatRate(null)).toBeNull();
  });
});

describe("toSegments", () => {
  it("colours known categories and falls back for unknown ones", () => {
    const segments = toSegments([
      { category: "security", count: 5 },
      { category: "novel-category", count: 2 },
    ]);
    expect(segments[0]!.color).toBe("var(--crit)");
    expect(segments[1]!.color).toBe("var(--text-muted)");
    expect(segments.map((s) => s.value)).toEqual([5, 2]);
  });
});
