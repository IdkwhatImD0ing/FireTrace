import { describe, expect, it } from "vitest";
import { buildSpanTree, type SpanLike } from "@/lib/firetrace/tree";

interface TestSpan extends SpanLike {
  startedAt: number;
}

const s = (id: string, parentSpanId: string | null = null, startedAt = 0): TestSpan => ({
  id,
  parentSpanId,
  startedAt,
});

const byStart = (a: TestSpan, b: TestSpan) => a.startedAt - b.startedAt;

describe("buildSpanTree", () => {
  it("returns empty output for no spans", () => {
    expect(buildSpanTree([])).toEqual({ roots: [], rows: [], cycles: [], orphanCount: 0 });
  });

  it("builds a single chain with increasing depth", () => {
    const tree = buildSpanTree([s("root"), s("child", "root"), s("grandchild", "child")]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["root", "child", "grandchild"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(tree.roots[0].children[0].children[0].span.id).toBe("grandchild");
    expect(tree.rows.every((r) => !r.orphan)).toBe(true);
    expect(tree.cycles).toEqual([]);
    expect(tree.orphanCount).toBe(0);
    expect(tree.roots[0]).toBe(tree.rows[0]);
  });

  it("emits rows depth-first with children directly after their parent", () => {
    const tree = buildSpanTree([
      s("root"),
      s("a", "root"),
      s("b", "root"),
      s("a1", "a"),
      s("a2", "a"),
      s("b1", "b"),
    ]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["root", "a", "a1", "a2", "b", "b1"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 2]);
  });

  it("tolerates input order where children precede their parents", () => {
    const tree = buildSpanTree([s("grandchild", "child"), s("child", "root"), s("root")]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["root", "child", "grandchild"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(tree.orphanCount).toBe(0);
  });

  it("supports multiple roots", () => {
    const tree = buildSpanTree([s("r1"), s("r1c", "r1"), s("r2"), s("r2c", "r2")]);
    expect(tree.roots.map((r) => r.span.id)).toEqual(["r1", "r2"]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["r1", "r1c", "r2", "r2c"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 1, 0, 1]);
    expect(tree.orphanCount).toBe(0);
  });

  it("surfaces spans whose parent is missing as orphan roots", () => {
    const tree = buildSpanTree([s("root"), s("lost", "missing"), s("lostChild", "lost")]);
    expect(tree.roots.map((r) => r.span.id)).toEqual(["root", "lost"]);
    const lost = tree.roots[1];
    expect(lost.orphan).toBe(true);
    expect(lost.depth).toBe(0);
    expect(lost.children.map((c) => c.span.id)).toEqual(["lostChild"]);
    expect(lost.children[0].orphan).toBe(false);
    expect(lost.children[0].depth).toBe(1);
    expect(tree.roots[0].orphan).toBe(false);
    expect(tree.orphanCount).toBe(1);
    expect(tree.cycles).toEqual([]);
  });

  it("counts every orphan", () => {
    const tree = buildSpanTree([s("a", "x"), s("b", "y"), s("c")]);
    expect(tree.orphanCount).toBe(2);
    expect(tree.rows.filter((r) => r.orphan).map((r) => r.span.id)).toEqual(["a", "b"]);
  });

  it("detects a two-span cycle and flattens it into roots", () => {
    const tree = buildSpanTree([s("a", "b"), s("b", "a")]);
    expect(tree.cycles).toEqual([["a", "b", "a"]]);
    expect(tree.roots.map((r) => r.span.id)).toEqual(["a", "b"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 0]);
    expect(tree.rows.every((r) => r.children.length === 0)).toBe(true);
    expect(tree.rows.every((r) => !r.orphan)).toBe(true);
    expect(tree.orphanCount).toBe(0);
  });

  it("detects a self-referencing span", () => {
    const tree = buildSpanTree([s("a", "a")]);
    expect(tree.cycles).toEqual([["a", "a"]]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["a"]);
    expect(tree.rows[0].depth).toBe(0);
  });

  it("detects longer cycles once and keeps every span exactly once", () => {
    const tree = buildSpanTree([
      s("root"),
      s("a", "c"),
      s("b", "a"),
      s("c", "b"),
      s("leaf", "root"),
    ]);
    expect(tree.cycles).toHaveLength(1);
    expect(tree.cycles[0]).toEqual(["a", "c", "b", "a"]);
    const ids = tree.rows.map((r) => r.span.id);
    expect([...ids].sort()).toEqual(["a", "b", "c", "leaf", "root"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      tree.rows.filter((r) => ["a", "b", "c"].includes(r.span.id)).every((r) => r.depth === 0),
    ).toBe(true);
    expect(tree.orphanCount).toBe(0);
  });

  it("keeps children of cycle members attached to their parent", () => {
    const tree = buildSpanTree([s("a", "b"), s("b", "a"), s("c", "a")]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["a", "c", "b"]);
    expect(tree.rows.map((r) => r.depth)).toEqual([0, 1, 0]);
    expect(tree.roots.map((r) => r.span.id)).toEqual(["a", "b"]);
  });

  it("reports several independent cycles", () => {
    const tree = buildSpanTree([s("a", "b"), s("b", "a"), s("x", "y"), s("y", "x")]);
    expect(tree.cycles).toEqual([
      ["a", "b", "a"],
      ["x", "y", "x"],
    ]);
    expect(tree.rows).toHaveLength(4);
  });

  it("applies the sort callback to roots and to every child list", () => {
    const tree = buildSpanTree(
      [
        s("r2", null, 20),
        s("r1", null, 10),
        s("c2", "r1", 12),
        s("c1", "r1", 11),
        s("c3", "r2", 21),
      ],
      byStart,
    );
    expect(tree.roots.map((r) => r.span.id)).toEqual(["r1", "r2"]);
    expect(tree.rows.map((r) => r.span.id)).toEqual(["r1", "c1", "c2", "r2", "c3"]);
  });

  it("keeps input order when no sort callback is given", () => {
    const tree = buildSpanTree([s("b", null, 2), s("a", null, 1)]);
    expect(tree.roots.map((r) => r.span.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input spans", () => {
    const input = [s("child", "root"), s("root")];
    const snapshot = structuredClone(input);
    buildSpanTree(input, byStart);
    expect(input).toEqual(snapshot);
  });
});
