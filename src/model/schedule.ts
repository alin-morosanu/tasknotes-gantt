import type { Bar, Edge, ScheduleNode, ScheduleResult, TaskPath } from '../types';
import {
  addWorkMinutes,
  workMinutesBetween,
  type WorkingCalendar
} from './calendar';
import {
  backwardBound,
  checkEdge,
  forwardBound,
  resolveEarlyStart,
  resolveLateFinish,
  type Bound,
  type Violation
} from './constraints';
import {
  buildAdjacency,
  connectedComponents,
  detectCycles,
  topologicalOrder,
  type Adjacency
} from './graph';

/**
 * Critical path analysis over the dependency network.
 *
 * Two questions are answered separately, because they are different questions:
 *
 *   - The forward and backward passes answer "what does the network imply" — the
 *     earliest and latest each task could run, and therefore which chain determines
 *     the end of the project.
 *   - The violation check answers "does the plan as written contradict its own
 *     dependencies" — a task scheduled before the thing that blocks it.
 *
 * Conflating them would produce a critical path that silently ignores the dates in
 * the user's notes, or violations that disappear because the maths moved the task.
 */

export interface ScheduleInput {
  bars: ReadonlyMap<TaskPath, Bar>;
  edges: readonly Edge[];
  calendar: WorkingCalendar;
  /** Total float at or below which a task counts as critical, in working minutes. */
  criticalThresholdMinutes?: number;
  /** Resolve a path to a display name, for violation messages. */
  labelFor?: (path: TaskPath) => string;
}

export interface FullScheduleResult extends ScheduleResult {
  violations: Violation[];
  /** Paths on the critical path, for quick lookup during rendering. */
  critical: Set<TaskPath>;
}

const EMPTY: FullScheduleResult = {
  nodes: new Map(),
  cycles: [],
  droppedEdges: [],
  projectStartMs: 0,
  projectEndMs: 0,
  violations: [],
  critical: new Set()
};

function defaultLabel(path: TaskPath): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}

/**
 * Run the critical path analysis.
 *
 * Tasks inside a dependency cycle are excluded from both passes rather than iterated
 * on — a cycle has no earliest start, and the reference vault contains a real one, so
 * this is a normal case rather than a defensive afterthought.
 */
export function computeSchedule(input: ScheduleInput): FullScheduleResult {
  const { bars, edges, calendar: cal } = input;
  const threshold = input.criticalThresholdMinutes ?? 0;
  const labelFor = input.labelFor ?? defaultLabel;

  const paths = [...bars.keys()];
  if (paths.length === 0) return EMPTY;

  const adjacency = buildAdjacency(paths, edges);
  const cycles = detectCycles(paths, adjacency);
  const inCycle = new Set<TaskPath>();
  for (const cycle of cycles) for (const member of cycle.members) inCycle.add(member);

  const droppedEdges = edges.filter((e) => inCycle.has(e.from) || inCycle.has(e.to));
  const { order } = topologicalOrder(paths, adjacency, inCycle);

  const duration = new Map<TaskPath, number>();
  for (const path of order) {
    const bar = bars.get(path);
    duration.set(path, bar ? Math.max(0, workMinutesBetween(cal, bar.startMs, bar.endMs)) : 0);
  }

  const es = new Map<TaskPath, number>();
  const ef = new Map<TaskPath, number>();

  // Forward pass. A task with no predecessors is anchored at its own planned start:
  // the network cannot say when work with nothing before it should begin, so the
  // user's date is the only meaningful answer.
  for (const path of order) {
    const bar = bars.get(path);
    if (!bar) continue;
    const preds = (adjacency.predecessors.get(path) ?? []).filter((e) => !inCycle.has(e.from));

    let start: number;
    if (preds.length === 0) {
      start = bar.startMs;
    } else {
      const bounds: Bound[] = [];
      for (const edge of preds) {
        const predStart = es.get(edge.from);
        const predFinish = ef.get(edge.from);
        if (predStart === undefined || predFinish === undefined) continue;
        bounds.push(forwardBound(edge, predStart, predFinish, cal));
      }
      start = resolveEarlyStart(bounds, duration.get(path) ?? 0, cal) ?? bar.startMs;
    }

    es.set(path, start);
    ef.set(path, addWorkMinutes(cal, start, duration.get(path) ?? 0));
  }

  const projectStartMs = order.length > 0 ? Math.min(...order.map((p) => es.get(p) ?? 0)) : 0;
  const projectEndMs = order.length > 0 ? Math.max(...order.map((p) => ef.get(p) ?? 0)) : 0;

  // Each connected component is its own plan, with its own end date. See
  // `connectedComponents` for why a single global end date is the wrong answer here.
  const componentEnd = new Map<TaskPath, number>();
  const componentSize = new Map<TaskPath, number>();
  for (const component of connectedComponents(order, adjacency)) {
    let end = Number.NEGATIVE_INFINITY;
    for (const path of component) end = Math.max(end, ef.get(path) ?? Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(end)) end = projectEndMs;
    for (const path of component) {
      componentEnd.set(path, end);
      componentSize.set(path, component.length);
    }
  }

  const ls = new Map<TaskPath, number>();
  const lf = new Map<TaskPath, number>();

  // Backward pass, in reverse topological order. A task with no successors is capped
  // at the end of ITS OWN component, so float measures slack against the plan the task
  // actually belongs to.
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const path = order[i];
    if (path === undefined) continue;
    const succs = (adjacency.successors.get(path) ?? []).filter((e) => !inCycle.has(e.to));

    let finish: number;
    if (succs.length === 0) {
      finish = componentEnd.get(path) ?? projectEndMs;
    } else {
      const bounds: Bound[] = [];
      for (const edge of succs) {
        const succStart = ls.get(edge.to);
        const succFinish = lf.get(edge.to);
        if (succStart === undefined || succFinish === undefined) continue;
        bounds.push(backwardBound(edge, succStart, succFinish, cal));
      }
      finish =
        resolveLateFinish(bounds, duration.get(path) ?? 0, cal) ??
        componentEnd.get(path) ??
        projectEndMs;
    }

    lf.set(path, finish);
    ls.set(path, addWorkMinutes(cal, finish, -(duration.get(path) ?? 0)));
  }

  const nodes = new Map<TaskPath, ScheduleNode>();
  const critical = new Set<TaskPath>();

  for (const path of order) {
    const nodeEs = es.get(path);
    const nodeEf = ef.get(path);
    const nodeLs = ls.get(path);
    const nodeLf = lf.get(path);
    if (
      nodeEs === undefined ||
      nodeEf === undefined ||
      nodeLs === undefined ||
      nodeLf === undefined
    ) {
      continue;
    }

    const totalFloat = workMinutesBetween(cal, nodeEs, nodeLs);

    // Free float: how far this task can slip before it delays any successor.
    const succs = (adjacency.successors.get(path) ?? []).filter((e) => !inCycle.has(e.to));
    let freeFloat = totalFloat;
    for (const edge of succs) {
      const succEs = es.get(edge.to);
      const succEf = ef.get(edge.to);
      if (succEs === undefined || succEf === undefined) continue;
      const bound = forwardBound(edge, nodeEs, nodeEf, cal);
      const actual = bound.field === 'start' ? succEs : succEf;
      const slack = workMinutesBetween(cal, bound.ms, actual);
      if (slack < freeFloat) freeFloat = slack;
    }

    // A task with no dependencies at all is trivially "critical" in its own
    // one-task component, which is noise rather than information.
    const isCritical = totalFloat <= threshold && (componentSize.get(path) ?? 1) > 1;
    if (isCritical) critical.add(path);

    nodes.set(path, {
      path,
      es: nodeEs,
      ef: nodeEf,
      ls: nodeLs,
      lf: nodeLf,
      totalFloat,
      freeFloat: Math.max(0, freeFloat),
      critical: isCritical
    });
  }

  // Violations are checked against the PLANNED bars, not the computed early dates,
  // so they report what the user actually wrote.
  const violations: Violation[] = [];
  for (const edge of edges) {
    if (inCycle.has(edge.from) || inCycle.has(edge.to)) continue;
    const pred = bars.get(edge.from);
    const succ = bars.get(edge.to);
    if (!pred || !succ) continue;
    const violation = checkEdge(
      edge,
      pred.startMs,
      pred.endMs,
      succ.startMs,
      succ.endMs,
      cal,
      labelFor
    );
    if (violation) violations.push(violation);
  }

  return {
    nodes,
    cycles,
    droppedEdges,
    projectStartMs,
    projectEndMs,
    violations,
    critical
  };
}

/** Tasks whose plan contradicts a dependency, keyed by path, for badge rendering. */
export function violationsByTask(violations: readonly Violation[]): Map<TaskPath, Violation[]> {
  const map = new Map<TaskPath, Violation[]>();
  for (const violation of violations) {
    const list = map.get(violation.edge.to);
    if (list) list.push(violation);
    else map.set(violation.edge.to, [violation]);
  }
  return map;
}

/** Edges on the critical path, for drawing them differently. */
export function criticalEdges(
  edges: readonly Edge[],
  critical: ReadonlySet<TaskPath>
): Set<Edge> {
  const result = new Set<Edge>();
  for (const edge of edges) {
    if (critical.has(edge.from) && critical.has(edge.to)) result.add(edge);
  }
  return result;
}

export type { Adjacency, Violation };
