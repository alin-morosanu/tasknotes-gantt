import type { Bar, GanttTask, TaskPath } from '../types';
import { resourceValuesOf } from './resource';
import { addDays, startOfDay } from './dates';
import {
  endOfWorkday,
  isWorkday,
  normalizeCalendar,
  startOfWorkday,
  type WorkingCalendar
} from './calendar';

/**
 * How much work each resource is carrying, day by day.
 *
 * A task's estimate is spread across the working days its bar covers, in proportion to
 * the working minutes available on each. That is the only defensible reading of a
 * `timeEstimate` with no per-day breakdown behind it.
 */

/** The bucket for tasks with no value in the resource field. */
export const UNASSIGNED = '';

export interface CapacityOptions {
  calendar: WorkingCalendar;
  /** Frontmatter property naming the resource, e.g. `assignee`. */
  resourceField: string;
  /** Working minutes a resource can absorb per day. */
  defaultCapacityMinutes: number;
  /** Per-resource overrides, keyed by resource name. */
  capacityOverrides: Readonly<Record<string, number>>;
  /** Completed work is history; including it would misreport what is still to do. */
  includeCompleted: boolean;
}

export interface DayLoad {
  /** Local midnight of the day. */
  dayMs: number;
  /** Working minutes allocated to this resource on this day. */
  minutes: number;
  capacity: number;
  /** Minutes above capacity. Zero when within it. */
  over: number;
}

export interface ResourceLoad {
  key: string;
  label: string;
  capacity: number;
  /**
   * True for a lane that is not a real resource, so overload means nothing.
   *
   * "Unassigned" holds every task nobody owns — 141 of them in the reference vault.
   * Measuring that pile against one person's working day reports a 38-hour day, which
   * is arithmetic, not information.
   */
  unlimited: boolean;
  days: Map<number, DayLoad>;
  totalMinutes: number;
  /** Days where allocation exceeds capacity. */
  overloadedDays: number;
  peakMinutes: number;
  /** Tasks contributing to this lane. */
  taskCount: number;
  /**
   * Tasks in this lane with no `timeEstimate`.
   *
   * They contribute nothing to the load, so the totals understate reality whenever
   * this is non-zero. Reported rather than guessed at: inventing an estimate would
   * make the histogram look authoritative while being fiction.
   */
  unestimatedCount: number;
}

export interface CapacityResult {
  resources: Map<string, ResourceLoad>;
  /** Every day any resource is loaded on, sorted ascending. */
  dayRange: number[];
  /** Total tasks with no estimate anywhere in the data set. */
  unestimatedTotal: number;
  /** Tasks that landed in a real lane rather than the Unassigned bucket. */
  assignedTasks: number;
  /** Tasks considered at all, so a view can report the coverage honestly. */
  consideredTasks: number;
}

/**
 * The resource lanes a task belongs to, with the unassigned bucket for none.
 *
 * A task naming two people belongs to both lanes: each of them owes that work.
 */
export function resourceValues(task: GanttTask, field: string): string[] {
  const values = resourceValuesOf(task, field);
  return values.length > 0 ? values : [UNASSIGNED];
}

/** Working minutes available on the calendar day containing `dayMs`. */
function workMinutesOnDay(cal: WorkingCalendar, dayMs: number): number {
  if (!isWorkday(cal, dayMs)) return 0;
  return (endOfWorkday(cal, dayMs) - startOfWorkday(cal, dayMs)) / 60_000;
}

/**
 * The working minutes a bar occupies on each day it touches.
 *
 * Returns an empty map for a bar that covers no working time at all — a milestone, or
 * a span that falls entirely across a weekend.
 */
export function spanByDay(
  bar: Bar,
  cal: WorkingCalendar,
  maxDays = 3650
): Map<number, number> {
  const result = new Map<number, number>();
  if (bar.endMs <= bar.startMs) return result;

  let cursor = startOfDay(bar.startMs);
  const last = startOfDay(bar.endMs);
  let guard = 0;

  while (cursor <= last && guard < maxDays) {
    guard += 1;
    const available = workMinutesOnDay(cal, cursor);
    if (available > 0) {
      // Intersect the bar with this day's working window.
      const from = Math.max(bar.startMs, startOfWorkday(cal, cursor));
      const to = Math.min(bar.endMs, endOfWorkday(cal, cursor));
      const minutes = Math.max(0, (to - from) / 60_000);
      if (minutes > 0) result.set(cursor, minutes);
    }
    cursor = addDays(cursor, 1);
  }

  return result;
}

/**
 * Build the per-resource daily load.
 *
 * Note what is deliberately NOT counted: tasks with no estimate contribute nothing,
 * and the count of those is reported so a lane can say how much of its picture is
 * missing rather than quietly showing a low number as though it were the whole truth.
 */
export function computeCapacity(
  tasks: readonly GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: CapacityOptions
): CapacityResult {
  const cal = normalizeCalendar(options.calendar);
  const resources = new Map<string, ResourceLoad>();
  const allDays = new Set<number>();
  let unestimatedTotal = 0;
  let assignedTasks = 0;
  let consideredTasks = 0;

  const laneFor = (key: string): ResourceLoad => {
    let lane = resources.get(key);
    if (!lane) {
      const override = options.capacityOverrides[key];
      // Unassigned is capacity-checked only if the user explicitly gives it a number.
      const unlimited = key === UNASSIGNED && override === undefined;
      lane = {
        key,
        label: key === UNASSIGNED ? 'Unassigned' : key,
        capacity: unlimited
          ? Number.POSITIVE_INFINITY
          : (override ?? options.defaultCapacityMinutes),
        unlimited,
        days: new Map(),
        totalMinutes: 0,
        overloadedDays: 0,
        peakMinutes: 0,
        taskCount: 0,
        unestimatedCount: 0
      };
      resources.set(key, lane);
    }
    return lane;
  };

  for (const task of tasks) {
    if (task.archived) continue;
    if (!options.includeCompleted && task.completed) continue;

    const bar = bars.get(task.path);
    if (!bar) continue;

    const keys = resourceValues(task, options.resourceField);
    const hasEstimate = task.timeEstimate !== null && task.timeEstimate > 0;
    consideredTasks += 1;
    if (!hasEstimate) unestimatedTotal += 1;
    if (keys.some((k) => k !== UNASSIGNED)) assignedTasks += 1;

    for (const key of keys) {
      const lane = laneFor(key);
      lane.taskCount += 1;
      if (!hasEstimate) {
        lane.unestimatedCount += 1;
        continue;
      }

      const perDay = spanByDay(bar, cal, 3650);
      const totalSpanMinutes = [...perDay.values()].reduce((a, b) => a + b, 0);
      if (totalSpanMinutes <= 0) continue;

      const estimate = task.timeEstimate ?? 0;
      for (const [dayMs, minutes] of perDay) {
        // Proportional to the working time the bar occupies that day, so a task that
        // only overlaps a morning is not charged a whole day.
        const share = estimate * (minutes / totalSpanMinutes);
        const existing = lane.days.get(dayMs);
        const next = (existing?.minutes ?? 0) + share;
        lane.days.set(dayMs, {
          dayMs,
          minutes: next,
          capacity: lane.capacity,
          over: Math.max(0, next - lane.capacity)
        });
        allDays.add(dayMs);
      }
      lane.totalMinutes += estimate;
    }
  }

  for (const lane of resources.values()) {
    let overloaded = 0;
    let peak = 0;
    for (const day of lane.days.values()) {
      if (!lane.unlimited && day.over > 0.5) overloaded += 1;
      if (day.minutes > peak) peak = day.minutes;
    }
    lane.overloadedDays = overloaded;
    lane.peakMinutes = peak;
  }

  return {
    resources,
    dayRange: [...allDays].sort((a, b) => a - b),
    unestimatedTotal,
    assignedTasks,
    consideredTasks
  };
}

/** A proposed move to bring a resource back within capacity. */
export interface LevellingProposal {
  path: TaskPath;
  /** Whole days to push the task later. Always positive. */
  dayDelta: number;
  reason: string;
}

export interface LevellingOptions extends CapacityOptions {
  /** Rank tasks; higher goes first and is left in place. */
  priorityWeight: (task: GanttTask) => number;
  /** Total float in working minutes, so tasks with slack are moved before others. */
  floatMinutes: (path: TaskPath) => number | null;
  /** Never push a task more than this many days. */
  maxPushDays: number;
}

/**
 * Propose pushes that would bring overloaded days within capacity.
 *
 * A greedy serial scheduler: on each overloaded day, the least important task with the
 * most slack is pushed just past the overload. It is intentionally simple and always
 * preview-only — resource levelling reorders someone's work, and a plugin should not
 * do that to a vault unasked.
 */
export function planLevelling(
  tasks: readonly GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: LevellingOptions
): LevellingProposal[] {
  const cal = normalizeCalendar(options.calendar);
  const proposals = new Map<TaskPath, LevellingProposal>();

  const capacity = computeCapacity(tasks, bars, options);

  for (const lane of capacity.resources.values()) {
    const overloaded = [...lane.days.values()]
      .filter((d) => d.over > 0.5)
      .sort((a, b) => a.dayMs - b.dayMs);

    for (const day of overloaded) {
      // Candidates: tasks in this lane whose bar covers the overloaded day and which
      // have not already been proposed for a move.
      const candidates = tasks.filter((task) => {
        if (proposals.has(task.path)) return false;
        if (!resourceValues(task, options.resourceField).includes(lane.key)) return false;
        if (task.timeEstimate === null || task.timeEstimate <= 0) return false;
        const bar = bars.get(task.path);
        if (!bar) return false;
        return spanByDay(bar, cal, 3650).has(day.dayMs);
      });

      if (candidates.length <= 1) continue;

      // Move the least important task with the most slack: the one whose delay costs
      // least. Ties break on title so the proposal is deterministic.
      candidates.sort((a, b) => {
        const byPriority = options.priorityWeight(a) - options.priorityWeight(b);
        if (byPriority !== 0) return byPriority;
        const floatA = options.floatMinutes(a.path) ?? Number.MAX_SAFE_INTEGER;
        const floatB = options.floatMinutes(b.path) ?? Number.MAX_SAFE_INTEGER;
        if (floatA !== floatB) return floatB - floatA;
        return a.title.localeCompare(b.title);
      });

      const victim = candidates[0];
      if (!victim) continue;
      const bar = bars.get(victim.path);
      if (!bar) continue;

      // Push just past the end of the contiguous overload on this lane.
      let cursor = day.dayMs;
      let pushDays = 0;
      while (pushDays < options.maxPushDays) {
        cursor = addDays(cursor, 1);
        pushDays += 1;
        const next = lane.days.get(cursor);
        if (!next || next.over <= 0.5) break;
      }

      if (pushDays <= 0 || pushDays > options.maxPushDays) continue;
      proposals.set(victim.path, {
        path: victim.path,
        dayDelta: pushDays,
        reason: `${lane.label} is over capacity on ${new Date(day.dayMs).toLocaleDateString()}`
      });
    }
  }

  return [...proposals.values()];
}
