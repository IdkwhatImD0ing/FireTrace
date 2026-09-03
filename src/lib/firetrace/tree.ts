/**
 * Span-tree construction shared by validation (cycle detection) and the UI
 * (depth-first rows). Tolerates multiple roots and parents that are missing
 * from the set: such spans are rendered as roots rather than dropped.
 */
export interface SpanLike {
  id: string;
  parentSpanId: string | null;
}

export interface TreeNode<T extends SpanLike> {
  span: T;
  depth: number;
  children: TreeNode<T>[];
  /** True when parentSpanId points at a span that is not in the set. */
  orphan: boolean;
}

export interface SpanTree<T extends SpanLike> {
  roots: TreeNode<T>[];
  /** Depth-first order, children after their parent. */
  rows: TreeNode<T>[];
  /** Each entry is one cycle as a path of span ids. */
  cycles: string[][];
  orphanCount: number;
}

export function buildSpanTree<T extends SpanLike>(
  spans: readonly T[],
  order: (a: T, b: T) => number = () => 0,
): SpanTree<T> {
  const byId = new Map<string, T>();
  for (const s of spans) byId.set(s.id, s);

  // Cycle detection over parent links.
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const inCycle = new Set<string>();
  for (const s of spans) {
    if (state.has(s.id)) continue;
    const path: string[] = [];
    let cur: T | undefined = s;
    while (cur && !state.has(cur.id)) {
      state.set(cur.id, "visiting");
      path.push(cur.id);
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
    }
    if (cur && state.get(cur.id) === "visiting") {
      const start = path.indexOf(cur.id);
      const cycle = [...path.slice(start), cur.id];
      cycles.push(cycle);
      for (const id of cycle) inCycle.add(id);
    }
    for (const id of path) state.set(id, "done");
  }

  const children = new Map<string | null, T[]>();
  let orphanCount = 0;
  const isOrphan = (s: T) => s.parentSpanId !== null && !byId.has(s.parentSpanId);
  for (const s of spans) {
    let parent: string | null = s.parentSpanId;
    if (parent !== null && (!byId.has(parent) || inCycle.has(s.id))) {
      if (isOrphan(s)) orphanCount++;
      parent = null;
    }
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }

  const rows: TreeNode<T>[] = [];
  const visited = new Set<string>();
  const build = (parent: string | null, depth: number): TreeNode<T>[] => {
    const list = [...(children.get(parent) ?? [])].sort(order);
    const nodes: TreeNode<T>[] = [];
    for (const s of list) {
      if (visited.has(s.id)) continue;
      visited.add(s.id);
      const node: TreeNode<T> = { span: s, depth, children: [], orphan: isOrphan(s) };
      rows.push(node);
      node.children = build(s.id, depth + 1);
      nodes.push(node);
    }
    return nodes;
  };
  const roots = build(null, 0);

  // Anything still unvisited belongs to a cycle with no root; show it flat.
  for (const s of [...spans].sort(order)) {
    if (!visited.has(s.id)) {
      visited.add(s.id);
      const node: TreeNode<T> = { span: s, depth: 0, children: [], orphan: false };
      roots.push(node);
      rows.push(node);
    }
  }

  return { roots, rows, cycles, orphanCount };
}
