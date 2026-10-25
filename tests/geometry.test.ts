import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import {
  barDurationDays,
  boundsOf,
  computeBar,
  isInferred,
  isMilestone,
  type GeometryOptions
} from '../src/model/geometry';
import { makeTask as task } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;
const show = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 2026-04-13 is a Monday.
const options: GeometryOptions = {
  calendar: DEFAULT_CALENDAR,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};


describe('computeBar with both dates', () => {
  it('spans from the scheduled morning to the due evening', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14'), due: parseTaskDate('2026-04-15') }),
      options
    );
    expect(bar.kind).toBe('planned');
    expect(show(bar.startMs)).toBe('2026-04-14 09:00');
    expect(show(bar.endMs)).toBe('2026-04-15 17:00');
  });

  it('gives a same-day task a visible span rather than zero width', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14'), due: parseTaskDate('2026-04-14') }),
      options
    );
    expect(bar.endMs).toBeGreaterThan(bar.startMs);
    expect(barDurationDays(bar, DEFAULT_CALENDAR)).toBe(1);
  });

  it('ends at the start of the due day when the due date is exclusive', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14'), due: parseTaskDate('2026-04-15') }),
      { ...options, dueDateInclusive: false }
    );
    expect(show(bar.endMs)).toBe('2026-04-15 09:00');
  });

  it('honours an explicit time instead of snapping to working hours', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14T06:30'), due: parseTaskDate('2026-04-14T22:00') }),
      options
    );
    expect(show(bar.startMs)).toBe('2026-04-14 06:30');
    expect(show(bar.endMs)).toBe('2026-04-14 22:00');
  });

  it('flags an inverted range rather than silently swapping the dates', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-16'), due: parseTaskDate('2026-04-14') }),
      options
    );
    expect(bar.kind).toBe('invalid');
    expect(bar.problem).toBeTruthy();
    // Still drawable, so the user can see and fix it.
    expect(bar.endMs).toBeGreaterThan(bar.startMs);
  });
});

describe('computeBar with one date', () => {
  it('infers an end from the estimate when only scheduled is set', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14'), timeEstimate: 960 }),
      options
    );
    expect(bar.kind).toBe('inferred-end');
    expect(show(bar.startMs)).toBe('2026-04-14 09:00');
    expect(show(bar.endMs)).toBe('2026-04-15 17:00');
  });

  it('infers a start backwards from the due date — the BOA-* case', () => {
    // 12 vault tasks look exactly like this: due set, scheduled blank, estimate 120.
    const bar = computeBar(task({ due: parseTaskDate('2026-08-21'), timeEstimate: 120 }), options);
    expect(bar.kind).toBe('inferred-start');
    expect(show(bar.endMs)).toBe('2026-08-21 17:00');
    expect(show(bar.startMs)).toBe('2026-08-21 15:00');
  });

  it('falls back to the default duration when there is no estimate', () => {
    const bar = computeBar(task({ scheduled: parseTaskDate('2026-04-14') }), options);
    expect(barDurationDays(bar, DEFAULT_CALENDAR)).toBe(1);
  });

  it('skips the weekend when inferring backwards over one', () => {
    // Due Monday evening with 2 working days of effort: Monday absorbs one day, and
    // the second lands on Friday, because the weekend in between carries no hours.
    const bar = computeBar(task({ due: parseTaskDate('2026-04-20'), timeEstimate: 960 }), options);
    expect(show(bar.endMs)).toBe('2026-04-20 17:00');
    expect(show(bar.startMs)).toBe('2026-04-17 09:00');
  });
});

describe('computeBar with no dates', () => {
  it('anchors an undated task at today and marks it unplanned', () => {
    const bar = computeBar(task({ timeEstimate: 480 }), options);
    expect(bar.kind).toBe('unplanned');
    expect(show(bar.startMs)).toBe('2026-04-13 09:00');
    expect(isInferred(bar)).toBe(true);
  });

  it('anchors to the next working day when today is a weekend', () => {
    const bar = computeBar(task({ timeEstimate: 480 }), {
      ...options,
      todayMs: at('2026-04-18T12:00')
    });
    expect(show(bar.startMs)).toBe('2026-04-20 09:00');
  });
});

describe('milestones', () => {
  it('treats a zero estimate as a milestone — 5 vault tasks look like this', () => {
    const t = task({ due: parseTaskDate('2026-06-30'), timeEstimate: 0 });
    expect(isMilestone(t)).toBe(true);
    const bar = computeBar(t, options);
    expect(bar.kind).toBe('milestone');
    expect(bar.startMs).toBe(bar.endMs);
    expect(show(bar.startMs)).toBe('2026-06-30 17:00');
  });

  it('lets an explicit flag override the estimate in both directions', () => {
    expect(isMilestone(task({ timeEstimate: 480, extra: { ganttMilestone: true } }))).toBe(true);
    expect(isMilestone(task({ timeEstimate: 0, extra: { ganttMilestone: false } }))).toBe(false);
  });

  it('reports zero duration', () => {
    const bar = computeBar(task({ due: parseTaskDate('2026-06-30'), timeEstimate: 0 }), options);
    expect(barDurationDays(bar, DEFAULT_CALENDAR)).toBe(0);
  });

  it('falls back to scheduled when a milestone has no due date', () => {
    const bar = computeBar(task({ scheduled: parseTaskDate('2026-06-30'), timeEstimate: 0 }), options);
    expect(bar.kind).toBe('milestone');
  });
});

describe('display extents', () => {
  const days = (bar: { displayStartMs: number; displayEndMs: number }) =>
    Math.round((bar.displayEndMs - bar.displayStartMs) / 86_400_000);

  it('gives a same-day task a full day of width', () => {
    // Drawn literally this is 09:00-17:00, a third of a day column: a 1px sliver at
    // month zoom and invisible below it.
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-09-07'), due: parseTaskDate('2026-09-07') }),
      options
    );
    expect(show(bar.displayStartMs)).toBe('2026-09-07 00:00');
    expect(show(bar.displayEndMs)).toBe('2026-09-08 00:00');
    expect(days(bar)).toBe(1);
  });

  it('covers the due day inclusively for a multi-day task', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14'), due: parseTaskDate('2026-04-15') }),
      options
    );
    expect(show(bar.displayStartMs)).toBe('2026-04-14 00:00');
    expect(show(bar.displayEndMs)).toBe('2026-04-16 00:00');
    expect(days(bar)).toBe(2);
  });

  it('gives an undated task a full day rather than a sliver', () => {
    expect(days(computeBar(task({ timeEstimate: 480 }), options))).toBe(1);
  });

  it('gives a due-only task a full day rather than a sliver', () => {
    // The BOA-* shape: due set, no scheduled, a 2-hour estimate.
    const bar = computeBar(task({ due: parseTaskDate('2026-08-21'), timeEstimate: 120 }), options);
    expect(days(bar)).toBe(1);
    expect(show(bar.displayStartMs)).toBe('2026-08-21 00:00');
  });

  it('leaves an author-specified time exactly where it was put', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-04-14T06:30'), due: parseTaskDate('2026-04-14T22:00') }),
      options
    );
    expect(show(bar.displayStartMs)).toBe('2026-04-14 06:30');
    expect(show(bar.displayEndMs)).toBe('2026-04-14 22:00');
  });

  it('keeps the logical span in working time, so duration is unaffected', () => {
    const bar = computeBar(
      task({ scheduled: parseTaskDate('2026-09-07'), due: parseTaskDate('2026-09-07') }),
      options
    );
    // One working day, not the three that 24h/8h would imply.
    expect(barDurationDays(bar, DEFAULT_CALENDAR)).toBe(1);
  });

  it('centres a milestone in its day instead of pinning it to 17:00', () => {
    const bar = computeBar(task({ due: parseTaskDate('2026-06-30'), timeEstimate: 0 }), options);
    expect(bar.displayStartMs).toBe(bar.displayEndMs);
    expect(show(bar.displayStartMs)).toBe('2026-06-30 12:00');
  });
});

describe('boundsOf', () => {
  it('pads the range to whole days on both sides', () => {
    const bars = [
      computeBar(task({ scheduled: parseTaskDate('2026-04-14'), due: parseTaskDate('2026-04-15') }), options)
    ];
    // The drawn extent runs 14 Apr 00:00 to 16 Apr 00:00, so 2 days of padding
    // reaches 12 Apr and 19 Apr.
    const bounds = boundsOf(bars, 2)!;
    expect(show(bounds.startMs)).toBe('2026-04-12 00:00');
    expect(show(bounds.endMs)).toBe('2026-04-19 00:00');
  });

  it('returns null when there is nothing to bound', () => {
    expect(boundsOf([])).toBeNull();
  });
});
