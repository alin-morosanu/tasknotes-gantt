import type { Bar, GanttTask, RelType, TaskPath } from '../types';
import { addDays, DAY_MS, formatTaskDate, parseTaskDate, startOfDay } from './dates';
import { forwardBound } from './constraints';
import type { Adjacency } from './graph';
import type { WorkingCalendar } from './calendar';

/**
 * Turns a drag gesture into the frontmatter changes it implies.
 *
 * Pure, and deliberately separate from anything that writes: a drag can be previewed,
 * validated and undone entirely in terms of these patches before a file is touched.
 */

export type DragMode = 'move' | 'resize-start' | 'resize-end';

/**
 * A change to one task's dates.
 *
 * `undefined` leaves a field alone; `null` clears it. Values are already formatted the
 * way TaskNotes stores them, so the writer never has to guess at date formatting.
 */
export interface TaskDatePatch {
  path: TaskPath;
  scheduled?: string | null;
  due?: string | null;
}

/** A patch plus the values it replaces, which is what makes undo possible. */
export interface ReversiblePatch {
  patch: TaskDatePatch;
  inverse: TaskDatePatch;
  /** Human summary for the confirmation dialog and the undo notice. */
  description: string;
}

/**
 * Whether a task's dates should be written back as all-day values.
 *
 * Every date in the reference vault is all-day, and a drag measured in whole days has
 * no time information to add, so a task that had no date at all gets an all-day one.
 * A task that carried a time keeps its time.
 */
function isDateOnly(task: GanttTask, field: 'scheduled' | 'due'): boolean {
  const value = task[field];
  return value === null ? true : value.dateOnly;
}

/**
 * The instant a drag should treat as the task's current start.
 *
 * For a task with no `scheduled`, this is the inferred bar start — which is how
 * dragging an inferred bar commits it: the guess becomes the starting point, and the
 * drag writes a real date relative to it.
 */
function currentStart(task: GanttTask, bar: Bar): number {
  return task.scheduled?.ms ?? bar.startMs;
}

function currentEnd(task: GanttTask, bar: Bar): number {
  return task.due?.ms ?? bar.endMs;
}

function formatFor(task: GanttTask, field: 'scheduled' | 'due', ms: number): string {
  const dateOnly = isDateOnly(task, field);
  // An all-day value is anchored to its date; the time of day carries no meaning.
  return formatTaskDate(dateOnly ? startOfDay(ms) : ms, dateOnly);
}

function describe(task: GanttTask, patch: TaskDatePatch): string {
  const parts: string[] = [];
  if (patch.scheduled !== undefined) {
    parts.push(`start ${task.scheduled?.raw ?? '(none)'} to ${patch.scheduled ?? '(none)'}`);
  }
  if (patch.due !== undefined) {
    parts.push(`due ${task.due?.raw ?? '(none)'} to ${patch.due ?? '(none)'}`);
  }
  return `${task.title}: ${parts.join(', ')}`;
}

/**
 * Build the inverse of a patch from the task's present values.
 *
 * A field the task did not have inverts to `null` — a clear — so undoing a drag that
 * materialized an inferred date removes it again rather than leaving the guess behind
 * as though the user had entered it.
 */
function inverseOf(task: GanttTask, patch: TaskDatePatch): TaskDatePatch {
  const inverse: TaskDatePatch = { path: task.path };
  if (patch.scheduled !== undefined) inverse.scheduled = task.scheduled?.raw ?? null;
  if (patch.due !== undefined) inverse.due = task.due?.raw ?? null;
  return inverse;
}

/**
 * Plan a drag of one task by a whole number of days.
 *
 * Returns null when the gesture changes nothing, so a click that happens to wobble a
 * pixel never writes to a file.
 */
export function planDrag(
  task: GanttTask,
  bar: Bar,
  mode: DragMode,
  dayDelta: number
): ReversiblePatch | null {
  if (dayDelta === 0) return null;

  const startMs = currentStart(task, bar);
  const endMs = currentEnd(task, bar);
  const patch: TaskDatePatch = { path: task.path };

  if (mode === 'move') {
    patch.scheduled = formatFor(task, 'scheduled', addDays(startMs, dayDelta));
    patch.due = formatFor(task, 'due', addDays(endMs, dayDelta));
  } else if (mode === 'resize-start') {
    // Dragging the start past the end would invert the task; clamp to a same-day span
    // instead, which is a shape the rest of the model already handles.
    const proposed = addDays(startMs, dayDelta);
    const clamped = Math.min(proposed, startOfDay(endMs));
    patch.scheduled = formatFor(task, 'scheduled', clamped);
  } else {
    const proposed = addDays(endMs, dayDelta);
    const clamped = Math.max(proposed, startOfDay(startMs));
    patch.due = formatFor(task, 'due', clamped);
  }

  // Clamping can leave the patch identical to what is already stored.
  const unchanged =
    (patch.scheduled === undefined || patch.scheduled === task.scheduled?.raw) &&
    (patch.due === undefined || patch.due === task.due?.raw);
  if (unchanged) return null;

  return { patch, inverse: inverseOf(task, patch), description: describe(task, patch) };
}

/** Which relation type a link drag implies, from where it started and ended. */
export function relTypeFor(fromEnd: 'start' | 'finish', toEnd: 'start' | 'finish'): RelType {
  if (fromEnd === 'finish' && toEnd === 'start') return 'FINISHTOSTART';
  if (fromEnd === 'finish' && toEnd === 'finish') return 'FINISHTOFINISH';
  if (fromEnd === 'start' && toEnd === 'start') return 'STARTTOSTART';
  return 'STARTTOFINISH';
}

/** Reverse a set of patches, for undo. Order is preserved. */
export function invert(patches: readonly ReversiblePatch[]): TaskDatePatch[] {
  return patches.map((p) => p.inverse);
}

/**
 * Plan a drag that also pushes everything downstream.
 *
 * Moving one bar in a dependency chain normally leaves the plan self-contradictory:
 * the successors now start before the thing that blocks them. Cascade resolves that by
 * shifting each affected successor by the least amount that restores its constraint.
 *
 * Successors are only ever pushed LATER. Pulling them earlier would silently rewrite
 * dates the user chose for reasons the dependency graph does not know about, and a
 * gap between two tasks is usually deliberate.
 */
export function planCascade(
  primary: ReversiblePatch,
  context: {
    tasks: ReadonlyMap<TaskPath, GanttTask>;
    bars: ReadonlyMap<TaskPath, Bar>;
    adjacency: Adjacency;
    calendar: WorkingCalendar;
    /** Paths inside a dependency cycle, which are left alone. */
    excluded: ReadonlySet<TaskPath>;
  }
): ReversiblePatch[] {
  const { tasks, bars, adjacency, calendar: cal, excluded } = context;
  const patches: ReversiblePatch[] = [primary];

  // Working copy of each task's span, updated as the cascade propagates so that a
  // task with two shifted predecessors is pushed by the larger of the two.
  const spans = new Map<TaskPath, { startMs: number; endMs: number }>();
  for (const [path, bar] of bars) spans.set(path, { startMs: bar.startMs, endMs: bar.endMs });

  const primarySpan = shiftedSpan(primary, tasks.get(primary.patch.path), bars.get(primary.patch.path));
  if (primarySpan) spans.set(primary.patch.path, primarySpan);

  const queue: TaskPath[] = [primary.patch.path];
  // Bounded so a pathological graph cannot spin: the cycle pass already removed real
  // loops, but a very wide fan-out should still terminate.
  let guard = 0;

  while (queue.length > 0 && guard < 10_000) {
    guard += 1;
    const path = queue.shift();
    if (path === undefined) continue;
    const predSpan = spans.get(path);
    if (!predSpan) continue;

    for (const edge of adjacency.successors.get(path) ?? []) {
      if (excluded.has(edge.to)) continue;
      const succTask = tasks.get(edge.to);
      const succSpan = spans.get(edge.to);
      if (!succTask || !succSpan) continue;

      const bound = forwardBound(edge, predSpan.startMs, predSpan.endMs, cal);
      const actual = bound.field === 'start' ? succSpan.startMs : succSpan.endMs;
      if (actual >= bound.ms) continue;

      // Shift by whole days: the successor's dates are all-day, so a partial-day
      // correction has nothing to write.
      const deltaDays = Math.ceil((bound.ms - actual) / DAY_MS);
      if (deltaDays <= 0) continue;

      const succBar = bars.get(edge.to);
      if (!succBar) continue;
      const planned = planDrag(succTask, succBar, 'move', deltaDays);
      if (!planned) continue;

      const next = shiftedSpan(planned, succTask, succBar);
      if (next) spans.set(edge.to, next);

      // A task reached twice is re-queued so the larger push wins, but its patch is
      // replaced rather than duplicated.
      const existing = patches.findIndex((p) => p.patch.path === edge.to);
      if (existing >= 0) patches[existing] = planned;
      else patches.push(planned);

      queue.push(edge.to);
    }
  }

  return patches;
}

/** The span a patch implies, for propagating a cascade without re-deriving bars. */
function shiftedSpan(
  planned: ReversiblePatch,
  task: GanttTask | undefined,
  bar: Bar | undefined
): { startMs: number; endMs: number } | null {
  if (!task || !bar) return null;
  const scheduled = planned.patch.scheduled;
  const due = planned.patch.due;
  const startMs = typeof scheduled === 'string' ? parseTaskDate(scheduled)?.ms ?? bar.startMs : bar.startMs;
  const endMs = typeof due === 'string' ? parseTaskDate(due)?.ms ?? bar.endMs : bar.endMs;
  return { startMs, endMs };
}
