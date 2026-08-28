import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ContextListing } from "@devdigest/shared";
import messages from "../../../messages/en/context.json";

/* ContextFilesPicker declares the `context` namespace for its own chrome and
   takes title/note as PROPS from the caller's namespace (client/INSIGHTS.md,
   2026-07-19 pattern) — so this test provider carries `context` only, and the
   test supplies title/note as plain strings, exactly like a real caller
   (AgentEditor's ContextTab / SkillEditor's ContextTab) would. */

const useContextFile = vi.fn();
vi.mock("../../lib/hooks/context", () => ({
  useContextFile: (...args: unknown[]) => useContextFile(...args),
}));

import { ContextFilesPicker } from "./ContextFilesPicker";

afterEach(() => {
  cleanup();
  useContextFile.mockReset();
  useContextFile.mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ context: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const LISTING: ContextListing = {
  cloned: true,
  roots: ["specs", "docs", "insights"],
  total_tokens: 180,
  files: [
    { path: "specs/api.md", type: "specs", bytes: 400, tokens: 100, used_by_agents: 1 },
    { path: "docs/architecture.md", type: "docs", bytes: 200, tokens: 50, used_by_agents: 0 },
    { path: "insights/lessons.md", type: "insights", bytes: 120, tokens: 30, used_by_agents: 2 },
  ],
};

function baseProps(overrides: Partial<React.ComponentProps<typeof ContextFilesPicker>> = {}) {
  return {
    repoId: "repo-1",
    attached: ["specs/api.md"],
    documents: LISTING,
    onChange: vi.fn(),
    title: "Project context",
    note: "Attach the documents this agent should read.",
    ...overrides,
  };
}

describe("ContextFilesPicker — filtering", () => {
  it("restricts the list to documents whose path contains the typed text (AC-29)", () => {
    renderWithIntl(<ContextFilesPicker {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText("Filter by path…"), {
      target: { value: "arch" },
    });
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();
    expect(screen.queryByText("specs/api.md")).not.toBeInTheDocument();
    expect(screen.queryByText("insights/lessons.md")).not.toBeInTheDocument();
  });

  it("shows the no-match note when the filter matches nothing", () => {
    renderWithIntl(<ContextFilesPicker {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText("Filter by path…"), {
      target: { value: "zzz-no-match" },
    });
    expect(screen.getByText("No document matches that filter.")).toBeInTheDocument();
  });
});

describe("ContextFilesPicker — reordering (AC-31, AC-32)", () => {
  it("disables drag reordering while the filter is non-empty", () => {
    renderWithIntl(<ContextFilesPicker {...baseProps()} />);
    // Unfiltered: every row offers a drag handle and the arrow-button fallback.
    expect(screen.getAllByTestId("drag-handle").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/^Move /).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByPlaceholderText("Filter by path…"), {
      target: { value: "api" },
    });

    // Filtered: the drag handle and the keyboard-reachable move buttons both
    // disappear — matching the existing linked-skills list's rule (no honest
    // drop target while a filter hides rows).
    expect(screen.queryAllByTestId("drag-handle")).toHaveLength(0);
    expect(screen.queryAllByLabelText(/^Move /)).toHaveLength(0);
  });

  /* The reported bug: "when I click a checkbox it only works intermittently."
     The row itself carried `draggable`, so the browser started a native drag
     on the first mousemove after mousedown and dispatched NO click — a press
     with a pixel of drift silently did nothing, and drift into the next row
     reordered the list instead of ticking the box. jsdom dispatches click
     directly and can never reproduce that, so what is pinned here is the DOM
     contract that makes it impossible: at rest, no row is draggable. */
  it("makes a row draggable only while its handle is held", () => {
    const { container } = renderWithIntl(<ContextFilesPicker {...baseProps()} />);
    const row = () => container.querySelector("[draggable]");

    expect(row()?.getAttribute("draggable")).toBe("false");

    fireEvent.mouseDown(screen.getAllByTestId("drag-handle")[0]!);
    expect(row()?.getAttribute("draggable")).toBe("true");

    // Released anywhere, including off the handle: the row must not stay armed.
    fireEvent.mouseUp(window);
    expect(row()?.getAttribute("draggable")).toBe("false");
  });

  /* The reported bug, second cause: the click DID reach the handler — twice.
     `Checkbox` wraps its <button role="checkbox"> in a <label>, which makes the
     button its labeled control, so the browser re-dispatches a synthetic click
     back to it. The handler then ran against two different renders of
     `checked` (off, then on again) and the toggle netted to zero — the box
     refused to change. An on-screen click counter in the running app read +2
     per click, which is what pinned it.

     jsdom applies the spec's interactive-content carve-out and so fires once
     either way; it cannot reproduce the double dispatch. What IS assertable
     here is the guard that prevents it — the click must come back
     defaultPrevented, because label forwarding is the click's default action. */
  it("cancels the click's default action, so the label cannot re-dispatch it", () => {
    const onChange = vi.fn();
    renderWithIntl(<ContextFilesPicker {...baseProps({ attached: [], onChange })} />);
    const box = screen.getAllByRole("checkbox")[0]!;

    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    box.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("still toggles a checkbox on a row whose handle was never touched", () => {
    const onChange = vi.fn();
    renderWithIntl(<ContextFilesPicker {...baseProps({ attached: [], onChange })} />);
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(onChange).toHaveBeenCalledWith(["insights/lessons.md"]);
  });

  it("moving a row down via the arrow button reports the new order through onChange (AC-31)", () => {
    const onChange = vi.fn();
    renderWithIntl(
      <ContextFilesPicker
        {...baseProps({ attached: ["specs/api.md", "docs/architecture.md"], onChange })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Move specs/api.md down"));
    expect(onChange).toHaveBeenCalledWith(["docs/architecture.md", "specs/api.md"]);
  });

  it("moving a row up via the arrow button reports the new order through onChange", () => {
    const onChange = vi.fn();
    renderWithIntl(
      <ContextFilesPicker
        {...baseProps({ attached: ["specs/api.md", "docs/architecture.md"], onChange })}
      />,
    );
    fireEvent.click(screen.getByLabelText("Move docs/architecture.md up"));
    expect(onChange).toHaveBeenCalledWith(["docs/architecture.md", "specs/api.md"]);
  });
});

describe("ContextFilesPicker — token warning (AC-34)", () => {
  it("warns past 20,000 tokens and states nothing is truncated (EC-7)", () => {
    const bigListing: ContextListing = {
      cloned: true,
      roots: ["specs", "docs", "insights"],
      total_tokens: 25_000,
      files: [{ path: "docs/huge.md", type: "docs", bytes: 100_000, tokens: 25_000, used_by_agents: 0 }],
    };
    renderWithIntl(
      <ContextFilesPicker {...baseProps({ attached: ["docs/huge.md"], documents: bigListing })} />,
    );
    expect(screen.getByText(/25,000 tokens to every review/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is truncated/)).toBeInTheDocument();
  });

  it("shows no warning when attached tokens stay under the threshold", () => {
    renderWithIntl(<ContextFilesPicker {...baseProps()} />);
    expect(screen.queryByText(/Nothing is truncated/)).not.toBeInTheDocument();
  });
});

describe("ContextFilesPicker — empty and not-cloned states (AC-35, AC-36)", () => {
  it("names the configured roots in the empty state when discovery returns no documents", () => {
    renderWithIntl(
      <ContextFilesPicker
        {...baseProps({
          attached: [],
          documents: { cloned: true, roots: ["specs", "docs", "insights"], total_tokens: 0, files: [] },
        })}
      />,
    );
    expect(screen.getByText("No documents found")).toBeInTheDocument();
    expect(screen.getByText(/specs, docs, insights/)).toBeInTheDocument();
  });

  it("shows a distinct 'not cloned yet' state when the repository has no clone", () => {
    renderWithIntl(
      <ContextFilesPicker
        {...baseProps({
          attached: [],
          documents: { cloned: false, roots: ["specs", "docs", "insights"], total_tokens: 0, files: [] },
        })}
      />,
    );
    expect(screen.getByText("Repository not cloned yet")).toBeInTheDocument();
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
  });
});

describe("ContextFilesPicker — preview (AC-33)", () => {
  it("opens a read-only preview with no control that modifies the document", () => {
    useContextFile.mockReturnValue({
      data: { path: "specs/api.md", content: "# API contract\nNever break a public field.", bytes: 10, tokens: 5 },
      isLoading: false,
      isError: false,
    });
    renderWithIntl(<ContextFilesPicker {...baseProps()} />);

    fireEvent.click(screen.getAllByText("Preview")[0]!);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Never break a public field.")).toBeInTheDocument();
    // Read-only: nothing inside the preview dialog itself can modify the
    // document — no textbox, no save/edit control. (The picker's own filter
    // input, rendered behind the modal, is deliberately out of scope here.)
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Edit$/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Save$/)).not.toBeInTheDocument();
  });
});

/* Regression coverage for the two defects reported from the running app.

   Neither was catchable by the suite above, and the reason is worth stating:
   every test there calls `baseProps()` once and renders once, so the props keep
   a stable identity for the component's whole life. Both bugs needed a
   RE-RENDER with a freshly-built prop — which is exactly what the real wrappers
   did while their attachments query was pending. */
describe("ContextFilesPicker — an in-flight selection survives a listing refetch", () => {
  it("does not discard a just-ticked checkbox when the listing comes back", () => {
    // The reported bug. Ticking a box fires a PUT and invalidates the listing
    // to refresh its "used by N agents" counts. That refetch returns a NEW
    // response object while `attached` still holds the PRE-toggle set, because
    // the write has not round-tripped yet. The old sentinel compared object
    // identity, so the refetch reset local state and the checkbox silently
    // unticked itself. Comparing a value signature instead — attached paths
    // plus discovered paths, and deliberately NOT the counts — leaves the
    // pending selection alone.
    const props = baseProps({ attached: [] });
    const { rerender } = renderWithIntl(<ContextFilesPicker {...props} />);

    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByText("1 of 3 attached")).toBeInTheDocument();

    // The listing refetch lands: same documents, counts bumped, and `attached`
    // is unchanged because the PUT is still in flight.
    const refetched: ContextListing = {
      ...LISTING,
      files: LISTING.files.map((f) => ({ ...f, used_by_agents: f.used_by_agents + 1 })),
    };
    rerender(
      <NextIntlClientProvider locale="en" messages={{ context: messages }}>
        <ContextFilesPicker {...props} documents={refetched} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("1 of 3 attached")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
  });

  it("still adopts the server's set when the attachments themselves change", () => {
    // The flip side: the sentinel must not become so sticky that a genuine
    // change is ignored. When `attached` really does change, local state yields.
    const props = baseProps({ attached: [] });
    const { rerender } = renderWithIntl(<ContextFilesPicker {...props} />);
    expect(screen.getByText("0 of 3 attached")).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={{ context: messages }}>
        <ContextFilesPicker {...props} attached={["docs/architecture.md"]} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("1 of 3 attached")).toBeInTheDocument();
  });
});

describe("ContextFilesPicker — listing loading and failure", () => {
  it("shows a placeholder while the listing is in flight, not an empty state", () => {
    renderWithIntl(
      <ContextFilesPicker {...baseProps({ documents: undefined, isLoading: true })} />,
    );
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
  });

  it("reports a failed listing instead of claiming there are no documents", () => {
    // The empty state's body interpolates the configured roots, which come from
    // the very response that failed — so the old code rendered a "no documents
    // under " sentence with a blank list, and never surfaced the error.
    renderWithIntl(
      <ContextFilesPicker {...baseProps({ documents: undefined, listingError: true })} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
  });
});

describe("ContextFilesPicker — a not-cloned repo still shows what is attached", () => {
  const NOT_CLONED: ContextListing = {
    cloned: false,
    roots: ["specs", "docs", "insights"],
    total_tokens: 0,
    files: [],
  };

  it("renders the caveat ABOVE the attachments rather than instead of them", () => {
    // Attachments are bare, repo-independent paths: they are still real and
    // still read on the next run, so an uncloned repo must not make them
    // invisible and unmanageable.
    renderWithIntl(
      <ContextFilesPicker
        {...baseProps({ documents: NOT_CLONED, attached: ["specs/api.md"] })}
      />,
    );
    expect(screen.getByText("Repository not cloned yet")).toBeInTheDocument();
    expect(screen.getByText("specs/api.md")).toBeInTheDocument();
    expect(screen.getByText("not in repo")).toBeInTheDocument();
  });

  it("does not also claim 'no documents found' when there is nothing attached", () => {
    // Two statements where only one is known: the repo was never walked, so we
    // have no standing to say it contains no documents.
    renderWithIntl(
      <ContextFilesPicker {...baseProps({ documents: NOT_CLONED, attached: [] })} />,
    );
    expect(screen.getByText("Repository not cloned yet")).toBeInTheDocument();
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
  });
});

describe("ContextFilesPicker — ticking a box does not move the row", () => {
  /* The reported bug: "when I try to choose one document it chooses another."
     `toRows` groups attached documents first, so attaching one moved it to
     index 0 and shifted everything below down — the click was right, the list
     moved out from under it. Rows now reconcile in place. */

  const paths = () =>
    screen.getAllByText(/^(specs|docs|insights)\//).map((el) => el.textContent);

  it("checks the row that was clicked, and leaves the order alone", () => {
    const onChange = vi.fn();
    const props = baseProps({ attached: [], onChange });
    const { rerender } = renderWithIntl(<ContextFilesPicker {...props} />);

    const before = paths();
    // Third row — the one furthest from where an attached-first regroup would
    // put it, so a jump is unmistakable.
    const third = before[2]!;
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);

    expect(onChange).toHaveBeenCalledWith([third]);

    // The optimistic cache write comes back as a changed `attached` prop; this
    // is the moment the old code re-grouped.
    rerender(
      <NextIntlClientProvider locale="en" messages={{ context: messages }}>
        <ContextFilesPicker {...props} attached={[third]} />
      </NextIntlClientProvider>,
    );

    expect(paths()).toEqual(before);
    expect(screen.getAllByRole("checkbox")[2]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
  });

  it("keeps the order when a document is unticked too", () => {
    const props = baseProps({ attached: ["docs/architecture.md"] });
    const { rerender } = renderWithIntl(<ContextFilesPicker {...props} />);
    const before = paths();
    const idx = before.indexOf("docs/architecture.md");

    fireEvent.click(screen.getAllByRole("checkbox")[idx]!);
    rerender(
      <NextIntlClientProvider locale="en" messages={{ context: messages }}>
        <ContextFilesPicker {...props} attached={[]} />
      </NextIntlClientProvider>,
    );

    expect(paths()).toEqual(before);
    expect(screen.getAllByRole("checkbox")[idx]).not.toBeChecked();
  });

  it("still reconciles a genuine change in the discovered set", () => {
    // Stability must not become staleness: a document that disappears from the
    // repository has to leave, and a new one has to arrive.
    const props = baseProps({ attached: [] });
    const { rerender } = renderWithIntl(<ContextFilesPicker {...props} />);
    expect(screen.getByText("insights/lessons.md")).toBeInTheDocument();

    const changed: ContextListing = {
      ...LISTING,
      files: [
        ...LISTING.files.filter((f) => f.path !== "insights/lessons.md"),
        { path: "specs/new-rule.md", type: "specs", bytes: 90, tokens: 20, used_by_agents: 0 },
      ],
    };
    rerender(
      <NextIntlClientProvider locale="en" messages={{ context: messages }}>
        <ContextFilesPicker {...props} documents={changed} />
      </NextIntlClientProvider>,
    );

    expect(screen.queryByText("insights/lessons.md")).not.toBeInTheDocument();
    expect(screen.getByText("specs/new-rule.md")).toBeInTheDocument();
  });
});
