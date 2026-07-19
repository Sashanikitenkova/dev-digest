import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../messages/en/skills.json";
import { SkillCard } from "./SkillCard";
import { filterSkills, isUntrusted } from "./helpers";

afterEach(cleanup);

const SKILL: Skill = {
  id: "sk1",
  name: "pr-quality-rubric",
  description: "Rubric for evaluating PR quality",
  type: "rubric",
  source: "manual",
  body: "# PR Quality Rubric",
  enabled: true,
  version: 3,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("SkillCard", () => {
  it("renders the name, type badge, source badge and description", () => {
    renderWithIntl(<SkillCard skill={SKILL} />);
    expect(screen.getByText("pr-quality-rubric")).toBeInTheDocument();
    expect(screen.getByText("rubric")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Rubric for evaluating PR quality")).toBeInTheDocument();
  });

  it("flags an imported skill as needing vetting", () => {
    renderWithIntl(<SkillCard skill={{ ...SKILL, source: "community" }} />);
    expect(screen.getByText("needs vetting")).toBeInTheDocument();
  });

  it("toggles enabled without triggering the card's own click", () => {
    const onToggle = vi.fn();
    const onClick = vi.fn();
    renderWithIntl(<SkillCard skill={SKILL} onToggle={onToggle} onClick={onClick} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("filterSkills", () => {
  const list: Skill[] = [
    SKILL,
    { ...SKILL, id: "sk2", name: "no-then-chains", description: "Prefer async/await", type: "convention" },
    { ...SKILL, id: "sk3", name: "secret-scan", description: "Flags hardcoded keys", type: "security" },
  ];

  it("returns everything for an empty query", () => {
    expect(filterSkills(list, "  ")).toHaveLength(3);
  });

  it("matches name, description and type case-insensitively", () => {
    expect(filterSkills(list, "THEN").map((s) => s.id)).toEqual(["sk2"]);
    expect(filterSkills(list, "hardcoded").map((s) => s.id)).toEqual(["sk3"]);
    expect(filterSkills(list, "rubric").map((s) => s.id)).toEqual(["sk1"]);
  });

  it("returns nothing when no skill matches", () => {
    expect(filterSkills(list, "zzz")).toEqual([]);
  });
});

describe("isUntrusted", () => {
  it("trusts only manually authored bodies", () => {
    expect(isUntrusted("manual")).toBe(false);
    expect(isUntrusted("community")).toBe(true);
    expect(isUntrusted("imported_url")).toBe(true);
    expect(isUntrusted("extracted")).toBe(true);
  });
});
