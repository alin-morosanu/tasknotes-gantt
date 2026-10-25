import type { Bar, GanttTask, TaskDate, TaskPath } from '../types';
import { formatTaskDate, parseTaskDate, startOfDay } from './dates';
import {
  minutesPerDay,
  normalizeCalendar,
  workMinutesBetween,
  type WorkingCalendar
} from './calendar';
import { resolveEnd, resolveStart } from './geometry';

/**
 * A snapshot of the plan, and how far the plan has moved since.
 *
 * Baselines live in the task's own frontmatter under names this plugin owns, so they
 * survive without it and show up in a git diff. They are only ever written when the
 * user explicitly takes a snapshot — nothing here happens as a side effect of dragging.
 */

export interface BaselineFields {
  start: string;
  end: string;
}

export const DEFAULT_BASELINE_FIELDS: BaselineFields = {
  start: 'ganttBaselineStart',
  end: 'ganttBaselineEnd'
};

export interface Baseline {
  /**
   * The stored dates, unresolved.
   *
   * Kept as `TaskDate` rather than instants because an all-day baseline has to be
   * anchored the same way a bar is — start of the working day, end of it — or a task
   * that has not moved at all reports a day of slip purely from midnight versus 17:00.
   */
  start: TaskDate;
  end: TaskDate;
  /** The raw frontmatter values, for round-tripping and for display. */
  rawStart: string;
  rawEnd: string;
}

/**
 * Read a task's baseline, if it has one.
 *
 * Returns null unless BOTH ends are present and valid: half a baseline cannot be
 * compared against anything, and showing a variance derived from one end would be
 * worse than showing none.
 */
export function readBaseline(
  task: GanttTask,
  fields: BaselineFields = DEFAULT_BASELINE_FIELDS
): Baseline | null {
  const start = parseTaskDate(task.extra[fields.start]);
  const end = parseTaskDate(task.extra[fields.end]);
  if (start === null || end === null) return null;
  if (end.ms < start.ms) return null;
  return { start, end, rawStart: start.raw, rawEnd: end.raw };
}

export interface Variance {
  /** Working days the start has moved. Positive means later than baseline. */
  startDays: number;
  /** Working days the end has moved. Positive means later than baseline. */
  endDays: number;
  /** Working days the span has grown. Positive means longer than baseline. */
  durationDays: number;
  /** True when the task now finishes later than it was baselined to. */
  slipped: boolean;
}

/**
 * Compare a task's current bar against its baseline.
 *
 * The baseline's dates are resolved with the same rules the geometry pass uses, so
 * both sides of the comparison mean the same thing.
 */
export function computeVariance(
  bar: Bar,
  baseline: Baseline,
  calendar: WorkingCalendar,
  dueDateInclusive = true
): Variance {
  const cal = normalizeCalendar(calendar);
  const perDay = minutesPerDay(cal);
  const toDays = (minutes: number) => (perDay > 0 ? minutes / perDay : 0);

  const baseStart = resolveStart(baseline.start, cal);
  const baseEnd = resolveEnd(baseline.end, cal, dueDateInclusive);

  const startDays = toDays(workMinutesBetween(cal, baseStart, bar.startMs));
  const endDays = toDays(workMinutesBetween(cal, baseEnd, bar.endMs));
  const baselineSpan = toDays(workMinutesBetween(cal, baseStart, baseEnd));
  const currentSpan = toDays(workMinutesBetween(cal, bar.startMs, bar.endMs));

  return {
    startDays,
    endDays,
    durationDays: currentSpan - baselineSpan,
    // Half a working day of tolerance, so rounding never reports a phantom slip.
    slipped: endDays > 0.5
  };
}

/** A baseline snapshot to write, plus what it replaces. */
export interface BaselinePatch {
  path: TaskPath;
  /** Frontmatter values to write. Null clears the field. */
  start: string | null;
  end: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  description: string;
}

/**
 * Build the snapshot for one task from its current bar.
 *
 * Written as all-day values: the baseline records which days were planned, and a
 * time-of-day derived from working-hours arithmetic would imply a precision the plan
 * never had.
 */
export function planBaseline(
  task: GanttTask,
  bar: Bar,
  fields: BaselineFields = DEFAULT_BASELINE_FIELDS
): BaselinePatch {
  const existing = readBaseline(task, fields);
  const start = formatTaskDate(startOfDay(bar.displayStartMs), true);
  // The drawn end is exclusive — the start of the day after — so step back inside it.
  const end = formatTaskDate(startOfDay(bar.displayEndMs - 1), true);
  return {
    path: task.path,
    start,
    end,
    previousStart: existing?.rawStart ?? null,
    previousEnd: existing?.rawEnd ?? null,
    description: `${task.title}: baseline ${start} to ${end}`
  };
}

/** Build the patch that removes a task's baseline. */
export function planClearBaseline(
  task: GanttTask,
  fields: BaselineFields = DEFAULT_BASELINE_FIELDS
): BaselinePatch | null {
  const existing = readBaseline(task, fields);
  if (!existing) return null;
  return {
    path: task.path,
    start: null,
    end: null,
    previousStart: existing.rawStart,
    previousEnd: existing.rawEnd,
    description: `${task.title}: clear baseline`
  };
}

export interface SlippageSummary {
  /** Tasks that have a baseline at all. */
  baselined: number;
  slipped: number;
  ahead: number;
  onPlan: number;
  /** Worst slip in working days. */
  worstDays: number;
  worstPath: TaskPath | null;
}

export function summariseSlippage(
  tasks: readonly GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  calendar: WorkingCalendar,
  fields: BaselineFields = DEFAULT_BASELINE_FIELDS,
  dueDateInclusive = true
): SlippageSummary {
  const summary: SlippageSummary = {
    baselined: 0,
    slipped: 0,
    ahead: 0,
    onPlan: 0,
    worstDays: 0,
    worstPath: null
  };

  for (const task of tasks) {
    const baseline = readBaseline(task, fields);
    const bar = bars.get(task.path);
    if (!baseline || !bar) continue;
    summary.baselined += 1;
    const variance = computeVariance(bar, baseline, calendar, dueDateInclusive);
    if (variance.endDays > 0.5) {
      summary.slipped += 1;
      if (variance.endDays > summary.worstDays) {
        summary.worstDays = variance.endDays;
        summary.worstPath = task.path;
      }
    } else if (variance.endDays < -0.5) {
      summary.ahead += 1;
    } else {
      summary.onPlan += 1;
    }
  }

  return summary;
}
