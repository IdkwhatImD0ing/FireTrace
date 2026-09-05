import { describe, expect, it } from "vitest";
import { buildSpanTree, descendantCount, visibleRows } from "@/lib/firetrace/tree";

const spans = [
  { id: "root", parentSpanId: null, name: "agent" },
  { id: "plan", parentSpanId: "root", name: "plan step" },
  { id: "search", parentSpanId: "root", name: "search-notes" },
  { id: "fetch", parentSpanId: "search", name: "fetch page" },
  { id: "other", parentSpanId: null, name: "orphan-ish" },
];
const tree = buildSpanTree(spans);
const ids = (rows: ReturnType<typeof visibleRows<(typeof spans)[number]>>) =>
  rows.map((r) => r.span.id);

describe("visibleRows", () => {
  it("returns every row when nothing is collapsed or searched", () => {
    expect(ids(visibleRows(tree.rows, new Set(), ""))).toEqual([
      "root",
      "plan",
      "search",
      "fetch",
      "other",
    ]);
  });

  it("hides the descendants of collapsed rows", () => {
    expect(ids(visibleRows(tree.rows, new Set(["search"]), ""))).toEqual([
      "root",
      "plan",
      "search",
      "other",
    ]);
    expect(ids(visibleRows(tree.rows, new Set(["root"]), ""))).toEqual(["root", "other"]);
    expect(descendantCount(tree.rows[0])).toBe(3);
    expect(descendantCount(tree.rows[2])).toBe(1);
  });

  it("keeps matches with their ancestors and ignores collapsing while searching", () => {
    expect(ids(visibleRows(tree.rows, new Set(["root", "search"]), "FETCH"))).toEqual([
      "root",
      "search",
      "fetch",
    ]);
    expect(ids(visibleRows(tree.rows, new Set(), "zzz"))).toEqual([]);
    expect(ids(visibleRows(tree.rows, new Set(), "  agent "))).toEqual(["root"]);
  });
});
