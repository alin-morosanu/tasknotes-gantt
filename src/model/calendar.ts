import { MINUTE_MS, addDays, startOfDay } from './dates';

/**
 * A working calendar: which days count as work, and which part of each day.
 *
 * All duration arithmetic in the Gantt runs through here rather than over wall-clock
 * time, so a 480-minute estimate spans one working day rather than eight hours that
 * might land on a Sunday night.
 */
export interface WorkingCalendar {
  /** Indexed by `Date.getDay()`, 0 = Sunday. */
  workdays: readonly boolean[];
  /** Minutes past local midnight when the working day starts. */
  dayStartMinutes: number;
  /** Minutes past local midnight when the working day ends. */
  dayEndMinutes: number;
  /** Non-working dates as `YYYY-MM-DD`, on top of the weekly pattern. */
  holidays: ReadonlySet<string>;
}

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workdays: [false, true, true, true, true, true, false],
  dayStartMinutes: 9 * 60,
  dayEndMinutes: 17 * 60,
  holidays: new Set()
};

/**
 * Cap on how many days the walkers will step through.
 *
 * A calendar with no working days would otherwise loop forever. `normalize` already
 * guards against that, but a misconfigured holiday set could still starve a long span,
 * and a Gantt must never hang the Obsidian UI thread.
 */
const MAX_DAY_STEPS = 20_000;

function dateKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Repair a calendar that would make progress impossible.
 *
 * A user can switch every weekday off, or drag the day end before the day start.
 * Rather than throwing or hanging, fall back to something usable.
 */
export function normalizeCalendar(cal: WorkingCalendar): WorkingCalendar {
  const hasWorkday = cal.workdays.some(Boolean);
  const validWindow = cal.dayEndMinutes > cal.dayStartMinutes;
  if (hasWorkday && validWindow) return cal;
  return {
    ...cal,
    workdays: hasWorkday ? cal.workdays : [true, true, true, true, true, true, true],
    dayStartMinutes: validWindow ? cal.dayStartMinutes : DEFAULT_CALENDAR.dayStartMinutes,
    dayEndMinutes: validWindow ? cal.dayEndMinutes : DEFAULT_CALENDAR.dayEndMinutes
  };
}

/** Working minutes available in a single working day. */
export function minutesPerDay(cal: WorkingCalendar): number {
  return cal.dayEndMinutes - cal.dayStartMinutes;
}

export function isWorkday(cal: WorkingCalendar, ms: number): boolean {
  if (cal.workdays[new Date(ms).getDay()] !== true) return false;
  return !cal.holidays.has(dateKey(ms));
}

/** Local instant at which the working day containing `ms` begins. */
export function startOfWorkday(cal: WorkingCalendar, ms: number): number {
  return startOfDay(ms) + cal.dayStartMinutes * MINUTE_MS;
}

/** Local instant at which the working day containing `ms` ends. */
export function endOfWorkday(cal: WorkingCalendar, ms: number): number {
  return startOfDay(ms) + cal.dayEndMinutes * MINUTE_MS;
}

/**
 * Move forward to the next instant that is inside a working window.
 * An instant already inside one is returned unchanged.
 */
export function snapForward(cal: WorkingCalendar, ms: number): number {
  const c = normalizeCalendar(cal);
  let cursor = ms;
  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    if (isWorkday(c, cursor)) {
      const start = startOfWorkday(c, cursor);
      const end = endOfWorkday(c, cursor);
      if (cursor < start) return start;
      if (cursor < end) return cursor;
    }
    cursor = startOfDay(addDays(cursor, 1));
  }
  return cursor;
}

/**
 * Move backward to the previous instant inside a working window.
 * An instant already inside one is returned unchanged.
 */
export function snapBackward(cal: WorkingCalendar, ms: number): number {
  const c = normalizeCalendar(cal);
  let cursor = ms;
  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    if (isWorkday(c, cursor)) {
      const start = startOfWorkday(c, cursor);
      const end = endOfWorkday(c, cursor);
      if (cursor > end) return end;
      if (cursor > start) return cursor;
    }
    // Land at the end of the previous day, then re-test.
    cursor = endOfWorkday(c, addDays(startOfDay(cursor), -1));
  }
  return cursor;
}

/**
 * Advance `minutes` of working time from `fromMs`.
 *
 * Zero minutes is a milestone and stays exactly where it is, without being snapped
 * into a working window — a deadline at midnight on a Sunday is still that deadline.
 */
export function addWorkMinutes(cal: WorkingCalendar, fromMs: number, minutes: number): number {
  if (minutes === 0) return fromMs;
  if (minutes < 0) return subWorkMinutes(cal, fromMs, -minutes);

  const c = normalizeCalendar(cal);
  let cursor = snapForward(c, fromMs);
  let remaining = minutes;

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    const end = endOfWorkday(c, cursor);
    const available = (end - cursor) / MINUTE_MS;
    if (available >= remaining) return cursor + remaining * MINUTE_MS;
    remaining -= available;
    cursor = snapForward(c, startOfDay(addDays(cursor, 1)));
  }
  return cursor;
}

/** Rewind `minutes` of working time from `fromMs`. */
export function subWorkMinutes(cal: WorkingCalendar, fromMs: number, minutes: number): number {
  if (minutes === 0) return fromMs;
  if (minutes < 0) return addWorkMinutes(cal, fromMs, -minutes);

  const c = normalizeCalendar(cal);
  let cursor = snapBackward(c, fromMs);
  let remaining = minutes;

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    const start = startOfWorkday(c, cursor);
    const available = (cursor - start) / MINUTE_MS;
    if (available >= remaining) return cursor - remaining * MINUTE_MS;
    remaining -= available;
    cursor = snapBackward(c, endOfWorkday(c, addDays(startOfDay(cursor), -1)));
  }
  return cursor;
}

/**
 * Working minutes between two instants. Negative when `toMs` precedes `fromMs`, so it
 * is a true inverse of `addWorkMinutes` for float and variance arithmetic.
 */
export function workMinutesBetween(cal: WorkingCalendar, fromMs: number, toMs: number): number {
  if (fromMs === toMs) return 0;
  if (toMs < fromMs) return -workMinutesBetween(cal, toMs, fromMs);

  const c = normalizeCalendar(cal);
  const start = snapForward(c, fromMs);
  // A span that ends before the next working window contains no working time at all.
  if (start >= toMs) return 0;

  let cursor = start;
  let total = 0;

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    const end = endOfWorkday(c, cursor);
    if (toMs <= end) return total + (toMs - cursor) / MINUTE_MS;
    total += (end - cursor) / MINUTE_MS;
    const next = snapForward(c, startOfDay(addDays(cursor, 1)));
    if (next >= toMs) return total;
    cursor = next;
  }
  return total;
}

/** Whole working days spanned, for display as "3d" rather than "1440m". */
export function workDaysBetween(cal: WorkingCalendar, fromMs: number, toMs: number): number {
  return workMinutesBetween(cal, fromMs, toMs) / minutesPerDay(normalizeCalendar(cal));
}
