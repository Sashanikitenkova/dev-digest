import { describe, it, expect } from "vitest";
import type { SpecFile } from "@devdigest/shared";
import { mergeRows, toRows, type DocRow } from "./helpers";

const f = (path: string): SpecFile => ({
  path,
  type: path.split("/")[0]!,
  bytes: 100,
  tokens: 25,
  used_by_agents: 0,
});

const FILES = [f("specs/api.md"), f("docs/architecture.md"), f("insights/lessons.md")];

describe("mergeRows", () => {
  it("falls back to toRows' attached-first grouping when there is nothing to preserve", () => {
    // First mount: the grouping is what shows the order the prompt will use.
    expect(mergeRows([], FILES, ["insights/lessons.md"])).toEqual(
      toRows(FILES, ["insights/lessons.md"]),
    );
  });

  it("keeps every row in place when a document becomes attached", () => {
    // The regression this function exists for: attaching must not reorder.
    const prev = toRows(FILES, []);
    const before = prev.map((r) => r.file.path);

    const next = mergeRows(prev, FILES, ["insights/lessons.md"]);

    expect(next.map((r) => r.file.path)).toEqual(before);
    expect(next.find((r) => r.file.path === "insights/lessons.md")!.attached).toBe(true);
    expect(next.filter((r) => r.attached)).toHaveLength(1);
  });

  it("keeps every row in place when a document is detached", () => {
    const prev = mergeRows(toRows(FILES, []), FILES, ["specs/api.md"]);
    const before = prev.map((r) => r.file.path);
    const next = mergeRows(prev, FILES, []);
    expect(next.map((r) => r.file.path)).toEqual(before);
    expect(next.every((r) => !r.attached)).toBe(true);
  });

  it("appends a newly discovered document at the end rather than inserting it", () => {
    // Inserting alphabetically would move existing rows, which is the whole
    // thing this function avoids.
    const prev = toRows(FILES, []);
    const next = mergeRows(prev, [...FILES, f("specs/aaa-first.md")], []);
    expect(next.at(-1)!.file.path).toBe("specs/aaa-first.md");
    expect(next.slice(0, prev.length).map((r) => r.file.path)).toEqual(
      prev.map((r) => r.file.path),
    );
  });

  it("drops a row that is neither discovered nor attached any more", () => {
    const prev = toRows(FILES, []);
    // prev is alphabetical (nothing attached), so removing the first entry
    // leaves the remaining two in their existing relative order.
    expect(prev.map((r) => r.file.path)).toEqual([
      "docs/architecture.md",
      "insights/lessons.md",
      "specs/api.md",
    ]);
    const next = mergeRows(prev, FILES.filter((x) => x.path !== "docs/architecture.md"), []);
    expect(next.map((r) => r.file.path)).toEqual(["insights/lessons.md", "specs/api.md"]);
  });

  it("keeps an attached document that vanished from the repo, as a stale row", () => {
    // It is still real: the next run will report it missing, and the author
    // needs to see why rather than have it silently disappear.
    const prev: DocRow[] = toRows(FILES, ["docs/architecture.md"]);
    const next = mergeRows(prev, FILES.filter((x) => x.path !== "docs/architecture.md"), [
      "docs/architecture.md",
    ]);
    const stale = next.find((r) => r.file.path === "docs/architecture.md");
    expect(stale).toBeDefined();
    expect(stale!.attached).toBe(true);
  });

  it("takes fresh metadata for a row it keeps", () => {
    const prev = toRows(FILES, []);
    const updated = FILES.map((x) =>
      x.path === "specs/api.md" ? { ...x, tokens: 999, used_by_agents: 7 } : x,
    );
    const next = mergeRows(prev, updated, []);
    const row = next.find((r) => r.file.path === "specs/api.md")!;
    expect(row.file.tokens).toBe(999);
    expect(row.file.used_by_agents).toBe(7);
  });
});
