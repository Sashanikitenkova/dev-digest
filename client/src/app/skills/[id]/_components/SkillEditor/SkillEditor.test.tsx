import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { Skill } from "@devdigest/shared";
import messages from "../../../../../../messages/en/skills.json";
import { ToastProvider } from "../../../../../lib/toast";

const updateMutate = vi.fn();

vi.mock("../../../../../lib/hooks/skills", () => ({
  useUpdateSkill: () => ({
    mutate: updateMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
  }),
  useSkillVersions: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));

import { SkillEditor } from "./SkillEditor";

const SKILL: Skill = {
  id: "sk1",
  name: "pr-quality-rubric",
  description: "Rubric for evaluating PR quality",
  type: "rubric",
  source: "manual",
  // 40 chars → ~10 tokens with the chars/4 estimate.
  body: "0123456789012345678901234567890123456789",
  enabled: true,
  version: 3,
};

function renderEditor(tab = "config") {
  return render(
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <ToastProvider>
        <SkillEditor skill={SKILL} tab={tab} onTab={() => {}} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => updateMutate.mockReset());
afterEach(cleanup);

describe("SkillEditor — Config tab", () => {
  it("renders the config fields, the description hint and a token estimate badge", () => {
    renderEditor();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByDisplayValue("pr-quality-rubric")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Rubric for evaluating PR quality")).toBeInTheDocument();
    expect(screen.getByText(/The skill's interface/)).toBeInTheDocument();
    expect(screen.getByText("~10 tokens")).toBeInTheDocument();
  });

  it("saves the edited name and body through the update mutation", () => {
    renderEditor();
    fireEvent.change(screen.getByDisplayValue("pr-quality-rubric"), {
      target: { value: "pr-quality-rubric-v2" },
    });
    fireEvent.change(screen.getByDisplayValue(SKILL.body), { target: { value: "# New body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({
      id: "sk1",
      patch: {
        name: "pr-quality-rubric-v2",
        description: "Rubric for evaluating PR quality",
        type: "rubric",
        body: "# New body",
        enabled: true,
      },
    });
  });
});

describe("SkillEditor — Preview tab", () => {
  it("renders the body as markdown with the 'as the agent receives it' subtitle", () => {
    renderEditor("preview");
    expect(screen.getByText("Rendered as the reviewing agent receives it.")).toBeInTheDocument();
    expect(screen.getByText(SKILL.body)).toBeInTheDocument();
  });
});
