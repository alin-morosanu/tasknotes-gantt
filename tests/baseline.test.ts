import { describe, expect, it } from 'vitest';
import type { Bar, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import {
  computeVariance,
  DEFAULT_BASELINE_FIELDS,
  planBaseline,
  planClearBaseline,
  readBaseline,
  summariseSlippage
} from '../src/model/baseline';
import { makeTask as task } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;

const geometry: GeometryOptions = {
  calendar: cal,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};

const dated = (scheduled: string, due: string, extra: Record<string, unknown> = {}) =>
  task({ scheduled: parseTaskDate(scheduled), due: parseTaskDate(due), extra });

const baselined = (scheduled: string, due: string, bStart: string, bEnd: string) =>
  dated(scheduled, due, {
    [DEFAULT_BASELINE_FIELDS.start]: bStart,
    [DEFAULT_BASELINE_FIELDS.end]: bEnd
  });

describe('readBaseline', () => {
  it('reads both ends from frontmatter', () => {
    const b = readBaseline(baselined('2026-04-14', '2026-04-16', '2026-04-13', '2026-04-15'));
    expect(b?.rawStart).toBe('2026-04-13');
    expect(b?.rawEnd).toBe('2026-04-15');
  });

  it('returns null when only one end is present', () => {
    // Half a baseline cannot be compared against anything; a variance derived from
    // one end would be worse than none.
    expect(
      readBaseline(dated('2026-04-14', '2026-04-16', { ganttBaselineStart: '2026-04-13' }))
    ).toBeNull();
  });

  it('returns null for an inverted baseline', () => {
    expect(
      readBaseline(baselined('2026-04-14', '2026-04-16', '2026-04-20', '2026-04-13'))
    ).toBeNull();
  });

  it('returns null when the task has no baseline at all', () => {
    expect(readBaseline(dated('2026-04-14', '2026-04-16'))).toBeNull();
  });

  it('honours renamed baseline properties', () => {
    const t = dated('2026-04-14', '2026-04-16', { planStart: '2026-04-13', planEnd: '2026-04-15' });
    expect(readBaseline(t, { start: 'planStart', end: 'planEnd' })?.rawStart).toBe('2026-04-13');
  });
});

describe('computeVariance', () => {
  it('reports a slip in working days', () => {
    const t = baselined('2026-04-15', '2026-04-17', '2026-04-13', '2026-04-15');
    const variance = computeVariance(computeBar(t, geometry), readBaseline(t)!, cal);
    expect(variance.startDays).toBeCloseTo(2, 1);
    expect(variance.endDays).toBeCloseTo(2, 1);
    expect(variance.slipped).toBe(true);
  });

  it('reports being ahead of plan as a negative variance', () => {
    const t = baselined('2026-04-13', '2026-04-15', '2026-04-15', '2026-04-17');
    const variance = computeVariance(computeBar(t, geometry), readBaseline(t)!, cal);
    expect(variance.endDays).toBeLessThan(0);
    expect(variance.slipped).toBe(false);
  });

  it('reports no slip when nothing moved', () => {
    const t = baselined('2026-04-14', '2026-04-16', '2026-04-14', '2026-04-16');
    const variance = computeVariance(computeBar(t, geometry), readBaseline(t)!, cal);
    expect(variance.startDays).toBeCloseTo(0, 6);
    expect(variance.endDays).toBeCloseTo(0, 6);
    expect(variance.durationDays).toBeCloseTo(0, 6);
    expect(variance.slipped).toBe(false);
  });

  it('separates a task growing longer from one starting later', () => {
    // Same start, later end: the task got bigger, it did not slip its start.
    const t = baselined('2026-04-14', '2026-04-20', '2026-04-14', '2026-04-16');
    const variance = computeVariance(computeBar(t, geometry), readBaseline(t)!, cal);
    expect(variance.startDays).toBeCloseTo(0, 6);
    expect(variance.durationDays).toBeGreaterThan(0);
  });

  it('counts only working days across a weekend', () => {
    // Friday to Monday is one working day of movement, not three calendar days.
    const t = baselined('2026-04-20', '2026-04-20', '2026-04-17', '2026-04-17');
    const variance = computeVariance(computeBar(t, geometry), readBaseline(t)!, cal);
    expect(variance.startDays).toBeCloseTo(1, 1);
  });
});

describe('planBaseline', () => {
  it('snapshots the current dates as all-day values', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const patch = planBaseline(t, computeBar(t, geometry));
    expect(patch.start).toBe('2026-04-14');
    // The drawn end is exclusive, so the snapshot must land on the due day itself.
    expect(patch.end).toBe('2026-04-16');
    expect(patch.previousStart).toBeNull();
  });

  it('snapshots a same-day task as one day, not zero', () => {
    const t = dated('2026-04-14', '2026-04-14');
    const patch = planBaseline(t, computeBar(t, geometry));
    expect(patch.start).toBe('2026-04-14');
    expect(patch.end).toBe('2026-04-14');
  });

  it('records the previous baseline so re-baselining is reversible', () => {
    const t = baselined('2026-04-14', '2026-04-16', '2026-04-01', '2026-04-02');
    const patch = planBaseline(t, computeBar(t, geometry));
    expect(patch.previousStart).toBe('2026-04-01');
    expect(patch.previousEnd).toBe('2026-04-02');
  });

  it('snapshots an inferred bar, since that is what the chart shows', () => {
    const t = task({ due: parseTaskDate('2026-08-21'), timeEstimate: 120 });
    const patch = planBaseline(t, computeBar(t, geometry));
    expect(patch.start).toBe('2026-08-21');
    expect(patch.end).toBe('2026-08-21');
  });
});

describe('planClearBaseline', () => {
  it('clears both fields and remembers what they held', () => {
    const t = baselined('2026-04-14', '2026-04-16', '2026-04-13', '2026-04-15');
    const patch = planClearBaseline(t)!;
    expect(patch.start).toBeNull();
    expect(patch.end).toBeNull();
    expect(patch.previousStart).toBe('2026-04-13');
  });

  it('returns null for a task with no baseline, so nothing is written', () => {
    expect(planClearBaseline(dated('2026-04-14', '2026-04-16'))).toBeNull();
  });
});

describe('summariseSlippage', () => {
  it('counts slipped, ahead and on-plan separately', () => {
    const slipped = { ...baselined('2026-04-20', '2026-04-22', '2026-04-13', '2026-04-15'), path: 'a.md' };
    const ahead = { ...baselined('2026-04-13', '2026-04-14', '2026-04-20', '2026-04-21'), path: 'b.md' };
    const onPlan = { ...baselined('2026-04-14', '2026-04-16', '2026-04-14', '2026-04-16'), path: 'c.md' };
    const noBaseline = { ...dated('2026-04-14', '2026-04-16'), path: 'd.md' };

    const tasks = [slipped, ahead, onPlan, noBaseline];
    const bars = new Map<TaskPath, Bar>(tasks.map((t) => [t.path, computeBar(t, geometry)]));
    const summary = summariseSlippage(tasks, bars, cal);

    expect(summary.baselined).toBe(3);
    expect(summary.slipped).toBe(1);
    expect(summary.ahead).toBe(1);
    expect(summary.onPlan).toBe(1);
    expect(summary.worstPath).toBe('a.md');
    expect(summary.worstDays).toBeGreaterThan(0);
  });

  it('reports nothing when no task is baselined', () => {
    const t = { ...dated('2026-04-14', '2026-04-16'), path: 'a.md' };
    const bars = new Map<TaskPath, Bar>([[t.path, computeBar(t, geometry)]]);
    const summary = summariseSlippage([t], bars, cal);
    expect(summary.baselined).toBe(0);
    expect(summary.worstPath).toBeNull();
  });
});
