import {
  type FileScope,
  overlappingPaths,
  scopesOverlap,
  touchesSharedSurface,
} from "./scope";

/**
 * Dependency graph over child tickets. Validated server-side on every
 * Architect Agent response; a cyclic or dangling graph is never persisted.
 */

export interface DagNode {
  key: string;
  dependsOn: readonly string[];
  fileScope: FileScope;
}

export type DagProblem =
  | { kind: "dangling"; from: string; to: string }
  | { kind: "self"; key: string }
  | { kind: "duplicate"; key: string }
  | { kind: "cycle"; cycle: string[] }
  | { kind: "scope_overlap"; a: string; b: string; paths: Array<[string, string]> };

export interface DagValidation {
  ok: boolean;
  problems: DagProblem[];
}

export function validateDag(nodes: readonly DagNode[]): DagValidation {
  const problems: DagProblem[] = [];
  const byKey = new Map<string, DagNode>();

  for (const node of nodes) {
    if (byKey.has(node.key)) {
      problems.push({ kind: "duplicate", key: node.key });
      continue;
    }
    byKey.set(node.key, node);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.key) {
        problems.push({ kind: "self", key: node.key });
      } else if (!byKey.has(dep)) {
        problems.push({ kind: "dangling", from: node.key, to: dep });
      }
    }
  }

  const cycle = findCycle(nodes, byKey);
  if (cycle) problems.push({ kind: "cycle", cycle });

  // Scope overlap only matters between tickets that could run at the same
  // time. Tickets on a dependency path are ordered, so sharing files is fine.
  const reach = transitiveClosure(nodes, byKey);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const ordered =
        reach.get(a.key)?.has(b.key) || reach.get(b.key)?.has(a.key);
      if (ordered) continue;
      const paths = overlappingPaths(a.fileScope, b.fileScope);
      if (paths.length > 0) {
        problems.push({ kind: "scope_overlap", a: a.key, b: b.key, paths });
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

function findCycle(
  nodes: readonly DagNode[],
  byKey: ReadonlyMap<string, DagNode>,
): string[] | null {
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function visit(key: string): string[] | null {
    const state = color.get(key) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GREY) {
      const at = stack.indexOf(key);
      return at >= 0 ? [...stack.slice(at), key] : [key];
    }

    color.set(key, GREY);
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    color.set(key, BLACK);
    return null;
  }

  for (const node of nodes) {
    const found = visit(node.key);
    if (found) return found;
  }
  return null;
}

/** For each node, every node reachable through its dependency edges. */
function transitiveClosure(
  nodes: readonly DagNode[],
  byKey: ReadonlyMap<string, DagNode>,
): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const inProgress = new Set<string>();

  function reach(key: string): Set<string> {
    const cached = memo.get(key);
    if (cached) return cached;
    if (inProgress.has(key)) return new Set();

    inProgress.add(key);
    const out = new Set<string>();
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      out.add(dep);
      for (const deeper of reach(dep)) out.add(deeper);
    }
    inProgress.delete(key);
    memo.set(key, out);
    return out;
  }

  for (const node of nodes) reach(node.key);
  return memo;
}

/** Dependency-first ordering. Throws if the graph is cyclic. */
export function topologicalOrder(nodes: readonly DagNode[]): string[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = node.dependsOn.filter((d) => byKey.has(d));
    indegree.set(node.key, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.key]);
    }
  }

  const queue = nodes.filter((n) => (indegree.get(n.key) ?? 0) === 0).map((n) => n.key);
  const order: string[] = [];

  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const next of dependents.get(key) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("Cannot order a cyclic dependency graph.");
  }
  return order;
}

/** Tickets whose dependencies are all complete. */
export function unblocked(
  nodes: readonly DagNode[],
  completed: ReadonlySet<string>,
): string[] {
  return nodes
    .filter((n) => !completed.has(n.key))
    .filter((n) => n.dependsOn.every((d) => completed.has(d)))
    .map((n) => n.key);
}

/**
 * The set of tickets that may run *simultaneously*: unblocked, mutually
 * independent, with disjoint file scopes, and at most one touching the shared
 * surface.
 */
export function concurrentBatch(
  nodes: readonly DagNode[],
  completed: ReadonlySet<string>,
  running: ReadonlySet<string> = new Set(),
): string[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const candidates = unblocked(nodes, completed).filter((k) => !running.has(k));

  const chosen: DagNode[] = [];
  const active = [...running].map((k) => byKey.get(k)).filter((n): n is DagNode => !!n);
  let sharedTaken = active.some((n) => touchesSharedSurface(n.fileScope).length > 0);

  for (const key of candidates) {
    const node = byKey.get(key);
    if (!node) continue;

    const usesShared = touchesSharedSurface(node.fileScope).length > 0;
    if (usesShared && sharedTaken) continue;

    const collides = [...chosen, ...active].some((other) =>
      scopesOverlap(node.fileScope, other.fileScope),
    );
    if (collides) continue;

    chosen.push(node);
    if (usesShared) sharedTaken = true;
  }

  return chosen.map((n) => n.key);
}
