import { describe, expect, it } from 'vitest';
import {
  addWorkMinutes,
  DEFAULT_CALENDAR,
  isWorkday,
  minutesPerDay,
  normalizeCalendar,
  snapBackward,
  snapForward,
  subWorkMinutes,
  workDaysBetween,
  workMinutesBetween,
  type WorkingCalendar
} from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';

const cal = DEFAULT_CALENDAR;
const at = (s: string) => parseTaskDate(s)!.ms;
const show = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 2026-04-13 is a Monday; 2026-04-18/19 is the following weekend.
describe('isWorkday', () => {
  it('excludes weekends', () => {
    expect(isWorkday(cal, at('2026-04-13'))).toBe(true);
    expect(isWorkday(cal, at('2026-04-18'))).toBe(false);
    expect(isWorkday(cal, at('2026-04-19'))).toBe(false);
  });

  it('excludes configured holidays', () => {
    const withHoliday: WorkingCalendar = { ...cal, holidays: new Set(['2026-04-15']) };
    expect(isWorkday(withHoliday, at('2026-04-15'))).toBe(false);
    expect(isWorkday(withHoliday, at('2026-04-16'))).toBe(true);
  });
});

describe('snapping', () => {
  it('moves an instant before the working day to its start', () => {
    expect(show(snapForward(cal, at('2026-04-13T06:00')))).toBe('2026-04-13 09:00');
  });

  it('moves an instant after the working day to the next working morning', () => {
    expect(show(snapForward(cal, at('2026-04-13T20:00')))).toBe('2026-04-14 09:00');
  });

  it('skips the weekend when moving forward', () => {
    expect(show(snapForward(cal, at('2026-04-18T10:00')))).toBe('2026-04-20 09:00');
  });

  it('leaves an instant already inside the working window alone', () => {
    expect(show(snapForward(cal, at('2026-04-13T11:30')))).toBe('2026-04-13 11:30');
    expect(show(snapBackward(cal, at('2026-04-13T11:30')))).toBe('2026-04-13 11:30');
  });

  it('moves backward to the previous working day end', () => {
    expect(show(snapBackward(cal, at('2026-04-20T06:00')))).toBe('2026-04-17 17:00');
  });
});

describe('addWorkMinutes', () => {
  it('stays inside one day when the work fits', () => {
    expect(show(addWorkMinutes(cal, at('2026-04-13T09:00'), 120))).toBe('2026-04-13 11:00');
  });

  it('rolls over into the next working day', () => {
    // 8h/day, so 10h from Monday 09:00 lands 2h into Tuesday.
    expect(show(addWorkMinutes(cal, at('2026-04-13T09:00'), 600))).toBe('2026-04-14 11:00');
  });

  it('skips the weekend', () => {
    // Friday 09:00 + 16h of work: 8h fills Friday, the next 8h fills Monday, because
    // Saturday and Sunday carry no working hours at all.
    expect(show(addWorkMinutes(cal, at('2026-04-17T09:00'), 960))).toBe('2026-04-20 17:00');
  });

  it('lands exactly on the day end without spilling into the next day', () => {
    expect(show(addWorkMinutes(cal, at('2026-04-13T09:00'), 480))).toBe('2026-04-13 17:00');
  });

  it('leaves a zero duration exactly where it is, even outside working hours', () => {
    const midnightSunday = at('2026-04-19');
    expect(addWorkMinutes(cal, midnightSunday, 0)).toBe(midnightSunday);
  });

  it('treats a negative duration as a rewind', () => {
    expect(show(addWorkMinutes(cal, at('2026-04-14T11:00'), -600))).toBe('2026-04-13 09:00');
  });
});

describe('subWorkMinutes', () => {
  it('is the inverse of addWorkMinutes across a weekend', () => {
    const start = at('2026-04-17T09:00');
    for (const minutes of [30, 480, 960, 2400]) {
      const end = addWorkMinutes(cal, start, minutes);
      expect(show(subWorkMinutes(cal, end, minutes))).toBe(show(start));
    }
  });

  it('infers a start for a due-only task', () => {
    // Due Friday end of day, 2 working days of effort, so it starts Thursday morning.
    expect(show(subWorkMinutes(cal, at('2026-04-17T17:00'), 960))).toBe('2026-04-16 09:00');
  });
});

describe('workMinutesBetween', () => {
  it('counts only working time across a weekend', () => {
    expect(workMinutesBetween(cal, at('2026-04-17T09:00'), at('2026-04-20T17:00'))).toBe(960);
  });

  it('returns zero for a span entirely outside working hours', () => {
    expect(workMinutesBetween(cal, at('2026-04-18T01:00'), at('2026-04-19T23:00'))).toBe(0);
  });

  it('is signed, so it inverts cleanly', () => {
    const a = at('2026-04-13T09:00');
    const b = at('2026-04-15T09:00');
    expect(workMinutesBetween(cal, a, b)).toBe(960);
    expect(workMinutesBetween(cal, b, a)).toBe(-960);
  });

  it('agrees with addWorkMinutes for a range of durations', () => {
    const start = at('2026-04-13T09:00');
    for (const minutes of [0, 30, 480, 481, 960, 2400, 10_000]) {
      const end = addWorkMinutes(cal, start, minutes);
      expect(workMinutesBetween(cal, start, end)).toBeCloseTo(minutes, 6);
    }
  });

  it('reports whole working days for display', () => {
    expect(workDaysBetween(cal, at('2026-04-13T09:00'), at('2026-04-15T17:00'))).toBe(3);
  });
});

describe('normalizeCalendar', () => {
  it('repairs a calendar with no working days rather than looping forever', () => {
    const broken: WorkingCalendar = { ...cal, workdays: [false, false, false, false, false, false, false] };
    expect(normalizeCalendar(broken).workdays.every(Boolean)).toBe(true);
    // The real guarantee: these must terminate.
    expect(Number.isFinite(addWorkMinutes(broken, at('2026-04-13'), 480))).toBe(true);
    expect(Number.isFinite(workMinutesBetween(broken, at('2026-04-13'), at('2026-04-20')))).toBe(true);
  });

  it('repairs an inverted working window', () => {
    const broken: WorkingCalendar = { ...cal, dayStartMinutes: 17 * 60, dayEndMinutes: 9 * 60 };
    expect(minutesPerDay(normalizeCalendar(broken))).toBe(480);
  });

  it('supports a 24/7 calendar', () => {
    const always: WorkingCalendar = {
      workdays: [true, true, true, true, true, true, true],
      dayStartMinutes: 0,
      dayEndMinutes: 24 * 60,
      holidays: new Set()
    };
    expect(show(addWorkMinutes(always, at('2026-04-17T00:00'), 1440 * 3))).toBe('2026-04-20 00:00');
  });
});
