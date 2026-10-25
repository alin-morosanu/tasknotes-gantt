import type { Bar, Cycle, Edge, GanttTask, TaskPath } from '../types';
import { addDays, DAY_MS } from './dates';
import { forwardBound } from './constraints';
import { planDrag, type ReversiblePatch } from './reschedule';
import { topologicalOrder, type Adjacency } from './graph';
import type { WorkingCalendar } from './calendar';

/**
 * Proposals for the two problems the chart reports but cannot resolve on its own.
 *
 * Both are preview-first and go through the ordinary write gates. Neither runs
 * automatically: a plan that silently rearranged itself would be worse than one that
 * points at its own contradictions.
 */

export interface AutofixContext {
  tasks: ReadonlyMap<TaskPath, GanttTask>;
  bars: ReadonlyMap<TaskPath, Bar>;
  adjacency: Adjacency;
  calendar: WorkingCalendar;
  /** Tasks inside a cycle, which have no meaningful earliest start. */
  excluded: ReadonlySet<TaskPath>;
}

/**
 * How far past a constraint a successor is scheduled, or 0 when it is satisfied.
 *
 * Exported because levelling needs the same rule: pushing a task off an overloaded day
 * moves it past its successors, and both passes must agree on what "too early" means.
 */
export function shortfallDays(
  edge: Edge,
  predSpan: { startMs: number; endMs: number },
  succSpan: { startMs: number; endMs: number },
  cal: WorkingCalendar
): number {
  const bound = forwardBound(edge, predSpan.startMs, predSpan.endMs, cal);
  const actual = bound.field === 'start' ? succSpan.startMs : succSpan.endMs;
  if (actual >= bound.ms) return 0;
  return Math.ceil((bound.ms - actual) / DAY_MS);
}

/**
 * Push every task that starts before a dependency allows, until none do.
 *
 * Walks in topological order, so each task is moved once against predecessors that are
 * already final — one pass, no iteration to a fixed point.
 *
 * Tasks only ever move LATER. Pulling one earlier to close a gap would rewrite a date
 * chosen for reasons the dependency graph cannot see, and the conflict being reported
 * is that a task starts too EARLY.
 */
export function planConflictFixes(context: AutofixContext): ReversiblePatch[] {
  const { tasks, bars, adjacency, calendar: cal, excluded } = context;

  const spans = new Map<TaskPath, { startMs: number; endMs: number }>();
  for (const [path, bar] of bars) spans.set(path, { startMs: bar.startMs, endMs: bar.endMs });

  const { order } = topologicalOrder([...bars.keys()], adjacency, new Set(excluded));
  const patches: ReversiblePatch[] = [];

  for (const path of order) {
    const task = tasks.get(path);
    const bar = bars.get(path);
    const span = spans.get(path);
    if (!task || !bar || !span) continue;

    let needed = 0;
    for (const edge of adjacency.predecessors.get(path) ?? []) {
      if (excluded.has(edge.from)) continue;
      const predSpan = spans.get(edge.from);
      if (!predSpan) continue;
      needed = Math.max(needed, shortfallDays(edge, predSpan, span, cal));
    }
    if (needed <= 0) continue;

    // Verify rather than trust the arithmetic: a day is not always 24 hours, and a
    // shift that lands an hour short across a clock change would leave the conflict
    // reported but unfixed.
    let delta = needed;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const moved = { startMs: addDays(span.startMs, delta), endMs: addDays(span.endMs, delta) };
      const stillShort = (adjacency.predecessors.get(path) ?? []).some((edge) => {
        if (excluded.has(edge.from)) return false;
        const predSpan = spans.get(edge.from);
        return predSpan ? shortfallDays(edge, predSpan, moved, cal) > 0 : false;
      });
      if (!stillShort) break;
      delta += 1;
    }

    const planned = planDrag(task, bar, 'move', delta);
    if (!planned) continue;
    patches.push(planned);
    spans.set(path, { startMs: addDays(span.startMs, delta), endMs: addDays(span.endMs, delta) });
  }

  return patches;
}

/** A dependency proposed for removal, to break a cycle. */
export interface CycleBreak {
  /** The task whose `blockedBy` entry would be removed. */
  successor: TaskPath;
  predecessor: TaskPath;
  /** The authored uid of the entry, which is what TaskNotes matches on. */
  uid: string;
  /** Which cycle this break resolves, for grouping in the dialog. */
  members: TaskPath[];
  description: string;
}

/**
 * Choose one dependency to remove from each cycle.
 *
 * Any single edge breaks a cycle, so the question is which one is most likely to be
 * the mistake. The edge picked is the one the dates contradict most: where the
 * predecessor finishes furthest after the successor starts. In a two-task deadlock,
 * the task scheduled first is almost never the one that genuinely waits for the other,
 * so the entry claiming it does is the error.
 *
 * Nothing is removed without confirmation. A dependency is a statement about the work,
 * and deleting one on a heuristic is not a decision a plugin should take alone.
 */
export function planCycleBreaks(
  cycles: readonly Cycle[],
  edges: readonly Edge[],
  bars: ReadonlyMap<TaskPath, Bar>,
  labelFor: (path: TaskPath) => string
): CycleBreak[] {
  const breaks: CycleBreak[] = [];

  for (const cycle of cycles) {
    const members = new Set(cycle.members);
    const internal = edges.filter((e) => members.has(e.from) && members.has(e.to));
    if (internal.length === 0) continue;

    let worst: Edge | null = null;
    let worstScore = Number.NEGATIVE_INFINITY;

    for (const edge of internal) {
      const pred = bars.get(edge.from);
      const succ = bars.get(edge.to);
      // Without dates on both ends there is nothing to judge by; such an edge is only
      // chosen if no better candidate exists.
      const score = pred && succ ? pred.endMs - succ.startMs : Number.NEGATIVE_INFINITY / 2;
      if (score > worstScore) {
        worstScore = score;
        worst = edge;
      }
    }

    if (!worst) continue;
    breaks.push({
      successor: worst.to,
      predecessor: worst.from,
      uid: worst.uid,
      members: cycle.members,
      description: `${labelFor(worst.to)}: stop waiting for ${labelFor(worst.from)}`
    });
  }

  return breaks;
}
