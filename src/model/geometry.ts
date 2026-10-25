import type { Bar, GanttTask, TaskDate } from '../types';
import { addDays, startOfDay, startOfNextDay } from './dates';
import {
  addWorkMinutes,
  endOfWorkday,
  minutesPerDay,
  normalizeCalendar,
  snapForward,
  startOfWorkday,
  subWorkMinutes,
  type WorkingCalendar
} from './calendar';

export interface GeometryOptions {
  calendar: WorkingCalendar;
  /**
   * Whether an all-day `due` means "by the end of that day" (true) or "by the start
   * of it" (false). Inclusive is the common reading and the default; getting this
   * wrong shifts every bar by a day, which is the classic Gantt off-by-one.
   */
  dueDateInclusive: boolean;
  /** Span given to a task that has dates but no estimate, in working minutes. */
  defaultDurationMinutes: number;
  /** Anchor for tasks with no dates at all. Injected so the pass stays pure. */
  todayMs: number;
}

export const DEFAULT_GEOMETRY: Omit<GeometryOptions, 'calendar' | 'todayMs'> = {
  dueDateInclusive: true,
  defaultDurationMinutes: 480
};

/**
 * Resolve a frontmatter date to the instant a bar should START at.
 *
 * An all-day value means the start of that working day; a value with a time component
 * is taken literally, because the author was explicit.
 */
export function resolveStart(date: TaskDate, cal: WorkingCalendar): number {
  return date.dateOnly ? startOfWorkday(cal, date.ms) : date.ms;
}

/**
 * Resolve a frontmatter date to the instant a bar should END at.
 *
 * With `dueDateInclusive`, an all-day `due: 2026-04-16` means end of business on the
 * 16th, so a task due the same day it is scheduled still has a visible span.
 */
export function resolveEnd(
  date: TaskDate,
  cal: WorkingCalendar,
  inclusive: boolean
): number {
  if (!date.dateOnly) return date.ms;
  return inclusive ? endOfWorkday(cal, date.ms) : startOfWorkday(cal, date.ms);
}

/**
 * Is this task a milestone — a point in time rather than a span?
 *
 * A zero estimate is the strongest signal and occurs in the vault today; an explicit
 * `ganttMilestone` flag wins over everything.
 */
export function isMilestone(task: GanttTask): boolean {
  const flag = task.extra['ganttMilestone'];
  if (flag === true) return true;
  if (flag === false) return false;
  return task.timeEstimate === 0;
}

/**
 * Widen a working-time span to the whole days it touches, for drawing.
 *
 * A task scheduled and due on 7 September spans 09:00 to 17:00. Drawn literally that
 * is a third of a day column — a sliver a few pixels wide at month zoom, and invisible
 * below that. Snapping the drawn extent out to day boundaries makes a one-day task
 * read as one day, which is what the dates in the grid say.
 *
 * Endpoints the author gave an explicit time to are left exactly where they are: they
 * asked for that precision on purpose.
 */
function displayExtent(
  startMs: number,
  endMs: number,
  exactStart: boolean,
  exactEnd: boolean
): { displayStartMs: number; displayEndMs: number } {
  const displayStartMs = exactStart ? startMs : startOfDay(startMs);
  if (exactEnd) {
    // An author who wrote a time meant that time; never widen past it. The only
    // guarantee here is that the bar has some width at all.
    return { displayStartMs, displayEndMs: Math.max(endMs, displayStartMs + 1) };
  }
  // `startOfNextDay` of the last instant, so an inclusive due date covers its own day,
  // which also guarantees at least one full day of width.
  return {
    displayStartMs,
    displayEndMs: Math.max(startOfNextDay(endMs - 1), startOfNextDay(displayStartMs))
  };
}

function bar(
  path: string,
  startMs: number,
  endMs: number,
  kind: Bar['kind'],
  exactStart: boolean,
  exactEnd: boolean,
  problem?: string
): Bar {
  const extent = displayExtent(startMs, endMs, exactStart, exactEnd);
  const result: Bar = { path, startMs, endMs, kind, ...extent };
  if (problem !== undefined) result.problem = problem;
  return result;
}

/** A milestone is a point, drawn centred on the day it falls in. */
function milestoneBar(path: string, ms: number, dateOnly: boolean, kind: Bar['kind']): Bar {
  const at = dateOnly ? startOfDay(ms) + (startOfNextDay(ms) - startOfDay(ms)) / 2 : ms;
  return { path, startMs: ms, endMs: ms, displayStartMs: at, displayEndMs: at, kind };
}

/**
 * Derive a task's extent on the timeline.
 *
 * The vault this is built for has 23 tasks with a due date but no start and 19 with
 * neither, so inference is the normal case rather than an edge case. Every inferred
 * bar is labelled with the `kind` that produced it, and the view styles those
 * differently so a guess never reads as a plan.
 */
export function computeBar(task: GanttTask, options: GeometryOptions): Bar {
  const cal = normalizeCalendar(options.calendar);
  const { dueDateInclusive: inclusive, defaultDurationMinutes } = options;
  const duration = task.timeEstimate ?? defaultDurationMinutes;

  const scheduled = task.scheduled;
  const due = task.due;

  if (isMilestone(task)) {
    const anchor = due ?? scheduled;
    if (anchor) {
      const at = anchor.dateOnly ? endOfWorkday(cal, anchor.ms) : anchor.ms;
      return milestoneBar(task.path, at, anchor.dateOnly, 'milestone');
    }
    const at = snapForward(cal, options.todayMs);
    return milestoneBar(task.path, at, true, 'unplanned');
  }

  if (scheduled && due) {
    const startMs = resolveStart(scheduled, cal);
    const endMs = resolveEnd(due, cal, inclusive);
    if (endMs < startMs) {
      // Real data contains inverted ranges; show them rather than silently swapping,
      // because only the author knows which of the two dates is wrong.
      return bar(
        task.path,
        endMs,
        startMs,
        'invalid',
        !due.dateOnly,
        !scheduled.dateOnly,
        'Due date falls before the scheduled date.'
      );
    }
    return bar(task.path, startMs, endMs, 'planned', !scheduled.dateOnly, !due.dateOnly);
  }

  if (scheduled) {
    const startMs = resolveStart(scheduled, cal);
    const endMs = addWorkMinutes(cal, startMs, duration);
    return bar(task.path, startMs, endMs, 'inferred-end', !scheduled.dateOnly, false);
  }

  if (due) {
    const endMs = resolveEnd(due, cal, inclusive);
    const startMs = subWorkMinutes(cal, endMs, duration);
    return bar(task.path, startMs, endMs, 'inferred-start', false, !due.dateOnly);
  }

  const startMs = snapForward(cal, options.todayMs);
  return bar(task.path, startMs, addWorkMinutes(cal, startMs, duration), 'unplanned', false, false);
}

/** True for bars the user has not actually planned, which the view draws differently. */
export function isInferred(bar: Bar): boolean {
  return bar.kind === 'inferred-start' || bar.kind === 'inferred-end' || bar.kind === 'unplanned';
}

export function computeBars(tasks: GanttTask[], options: GeometryOptions): Map<string, Bar> {
  const bars = new Map<string, Bar>();
  for (const task of tasks) bars.set(task.path, computeBar(task, options));
  return bars;
}

/**
 * The date range every supplied bar fits inside, padded to whole days.
 * Uses the drawn extents, since this sizes the scrollable canvas.
 */
export function boundsOf(
  bars: Iterable<Bar>,
  padDays = 3
): { startMs: number; endMs: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    if (b.displayStartMs < min) min = b.displayStartMs;
    if (b.displayEndMs > max) max = b.displayEndMs;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {
    startMs: startOfDay(addDays(min, -padDays)),
    endMs: startOfDay(addDays(max, padDays + 1))
  };
}

/** A bar's span in working days, for the duration column. */
export function barDurationDays(bar: Bar, cal: WorkingCalendar): number {
  if (bar.kind === 'milestone') return 0;
  const c = normalizeCalendar(cal);
  const minutes = (bar.endMs - bar.startMs) / 60_000;
  return minutes / minutesPerDay(c);
}
