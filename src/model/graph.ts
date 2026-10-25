import type { Cycle, Edge, GanttTask, TaskPath } from '../types';
import { parseDurationMinutes } from './dates';

export interface GraphBuildResult {
  edges: Edge[];
  /** Dependencies whose link resolved to nothing, or to a task outside the data set. */
  dangling: { from: TaskPath; uid: string }[];
  /** Dependencies pointing at the task itself, which are always an authoring error. */
  selfLinks: TaskPath[];
}

/**
 * Build the dependency edge list from normalized tasks.
 *
 * `blockedBy` names the PREDECESSOR, so an entry on task B naming task A becomes the
 * edge A to B. Only edges where both endpoints are present in `tasks` are kept; the
 * rest are reported so the view can flag them rather than silently dropping work.
 */
export function buildEdges(tasks: GanttTask[]): GraphBuildResult {
  const present = new Set(tasks.map((t) => t.path));
  const edges: Edge[] = [];
  const dangling: { from: TaskPath; uid: string }[] = [];
  const selfLinks: TaskPath[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (dep.path === null || !present.has(dep.path)) {
        dangling.push({ from: task.path, uid: dep.uid });
        continue;
      }
      if (dep.path === task.path) {
        selfLinks.push(task.path);
        continue;
      }
      // A task can list the same predecessor twice across the two authored shapes.
      const key = `${dep.path} ${task.path} ${dep.reltype}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: dep.path,
        uid: dep.uid,
        to: task.path,
        reltype: dep.reltype,
        gapMinutes: parseDurationMinutes(dep.gap) ?? 0
      });
    }
  }

  return { edges, dangling, selfLinks };
}

/** Adjacency built once and shared by the cycle and ordering passes. */
export interface Adjacency {
  successors: Map<TaskPath, Edge[]>;
  predecessors: Map<TaskPath, Edge[]>;
}

export function buildAdjacency(paths: readonly TaskPath[], edges: readonly Edge[]): Adjacency {
  const successors = new Map<TaskPath, Edge[]>();
  const predecessors = new Map<TaskPath, Edge[]>();
  for (const path of paths) {
    successors.set(path, []);
    predecessors.set(path, []);
  }
  for (const edge of edges) {
    successors.get(edge.from)?.push(edge);
    predecessors.get(edge.to)?.push(edge);
  }
  return { successors, predecessors };
}

/**
 * Find circular dependencies using Tarjan's strongly-connected-components algorithm.
 *
 * Any component with more than one member is a cycle. The implementation is iterative
 * rather than recursive: 147 tasks carry dependencies today and nothing validates them,
 * so a deep or hostile chain must not blow the stack or hang the view.
 */
export function detectCycles(paths: readonly TaskPath[], adjacency: Adjacency): Cycle[] {
  const index = new Map<TaskPath, number>();
  const lowlink = new Map<TaskPath, number>();
  const onStack = new Set<TaskPath>();
  const stack: TaskPath[] = [];
  const cycles: Cycle[] = [];
  let counter = 0;

  for (const root of paths) {
    if (index.has(root)) continue;

    // Explicit work stack: each frame tracks how far through its successors it is.
    const work: { node: TaskPath; edgeIndex: number }[] = [{ node: root, edgeIndex: 0 }];
    index.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const successors = adjacency.successors.get(frame.node) ?? [];

      if (frame.edgeIndex < successors.length) {
        const next = successors[frame.edgeIndex]?.to;
        frame.edgeIndex += 1;
        if (next === undefined) continue;

        if (!index.has(next)) {
          index.set(next, counter);
          lowlink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edgeIndex: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node) ?? 0, index.get(next) ?? 0)
          );
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0)
        );
      }

      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const members: TaskPath[] = [];
        let member: TaskPath | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.node);
        if (members.length > 1) cycles.push({ members: members.reverse() });
      }
    }
  }

  return cycles;
}

/**
 * Topological order over the edges, skipping any node inside a cycle.
 *
 * Returns the order plus the set of paths that could not be ordered, which the
 * schedule pass excludes rather than looping on.
 */
export function topologicalOrder(
  paths: readonly TaskPath[],
  adjacency: Adjacency,
  excluded: Set<TaskPath> = new Set()
): { order: TaskPath[]; unordered: TaskPath[] } {
  const indegree = new Map<TaskPath, number>();
  const active = paths.filter((p) => !excluded.has(p));

  for (const path of active) indegree.set(path, 0);
  for (const path of active) {
    for (const edge of adjacency.successors.get(path) ?? []) {
      if (excluded.has(edge.to)) continue;
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }

  const queue = active.filter((p) => (indegree.get(p) ?? 0) === 0);
  const order: TaskPath[] = [];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    order.push(node);
    for (const edge of adjacency.successors.get(node) ?? []) {
      if (excluded.has(edge.to)) continue;
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }

  const ordered = new Set(order);
  return { order, unordered: active.filter((p) => !ordered.has(p)) };
}

/**
 * Would adding an edge from `from` to `to` close a cycle? Used to reject a dependency
 * drag before anything is written to disk.
 */
export function wouldCreateCycle(
  from: TaskPath,
  to: TaskPath,
  adjacency: Adjacency
): boolean {
  if (from === to) return true;
  // The new edge is a cycle exactly when `from` is already reachable from `to`.
  const stack: TaskPath[] = [to];
  const visited = new Set<TaskPath>([to]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node === from) return true;
    for (const edge of adjacency.successors.get(node) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      stack.push(edge.to);
    }
  }
  return false;
}

/**
 * Weakly-connected components of the dependency graph.
 *
 * A vault is rarely one project. Treating it as a single network makes the backward
 * pass cap every chain at the latest task anywhere, so an April chain measures its
 * slack against an August deadline it has nothing to do with — float becomes noise
 * and almost nothing reads as critical. Each component is scheduled against its own
 * end date instead.
 *
 * Direction is ignored deliberately: two tasks that share a predecessor belong to the
 * same plan even though neither depends on the other.
 */
export function connectedComponents(
  paths: readonly TaskPath[],
  adjacency: Adjacency
): TaskPath[][] {
  const seen = new Set<TaskPath>();
  const components: TaskPath[][] = [];

  for (const root of paths) {
    if (seen.has(root)) continue;
    const component: TaskPath[] = [];
    const stack: TaskPath[] = [root];
    seen.add(root);

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      component.push(node);
      const neighbours = [
        ...(adjacency.successors.get(node) ?? []).map((e) => e.to),
        ...(adjacency.predecessors.get(node) ?? []).map((e) => e.from)
      ];
      for (const next of neighbours) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }

    components.push(component);
  }

  return components;
}
