import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { invert, planDrag, relTypeFor } from '../src/model/reschedule';
import { makeTask as task } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;

const options: GeometryOptions = {
  calendar: DEFAULT_CALENDAR,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};


const dated = (scheduled: string, due: string) =>
  task({ scheduled: parseTaskDate(scheduled), due: parseTaskDate(due) });

describe('planDrag: move', () => {
  it('shifts both dates by the same number of days', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'move', 3);
    expect(planned?.patch).toEqual({
      path: t.path,
      scheduled: '2026-04-17',
      due: '2026-04-19'
    });
  });

  it('moves backwards for a negative delta', () => {
    const t = dated('2026-04-14', '2026-04-16');
    expect(planDrag(t, computeBar(t, options), 'move', -2)?.patch.scheduled).toBe('2026-04-12');
  });

  it('does nothing for a zero delta, so a jittery click never writes', () => {
    const t = dated('2026-04-14', '2026-04-16');
    expect(planDrag(t, computeBar(t, options), 'move', 0)).toBeNull();
  });

  it('preserves an all-day value rather than adding a spurious time', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'move', 1);
    expect(planned?.patch.scheduled).toBe('2026-04-15');
    expect(planned?.patch.scheduled).not.toContain('T');
  });

  it('keeps the time component when the author wrote one', () => {
    const t = task({
      scheduled: parseTaskDate('2026-04-14T09:30'),
      due: parseTaskDate('2026-04-14T17:30')
    });
    const planned = planDrag(t, computeBar(t, options), 'move', 1);
    expect(planned?.patch.scheduled).toBe('2026-04-15T09:30');
    expect(planned?.patch.due).toBe('2026-04-15T17:30');
  });
});

describe('planDrag: materializing inferred dates', () => {
  it('writes a real start for a due-only task — the BOA-* case', () => {
    // Dragging an inferred bar is how a guess becomes a plan.
    const t = task({ due: parseTaskDate('2026-08-21'), timeEstimate: 120 });
    const planned = planDrag(t, computeBar(t, options), 'move', 2);
    expect(planned?.patch.scheduled).toBe('2026-08-23');
    expect(planned?.patch.due).toBe('2026-08-23');
  });

  it('writes both dates for a task that had neither', () => {
    const t = task({ timeEstimate: 480 });
    const planned = planDrag(t, computeBar(t, options), 'move', 1);
    expect(planned?.patch.scheduled).toBe('2026-04-14');
    expect(planned?.patch.due).toBe('2026-04-14');
  });

  it('inverts a materialized date back to absent, not to the guess', () => {
    const t = task({ due: parseTaskDate('2026-08-21'), timeEstimate: 120 });
    const planned = planDrag(t, computeBar(t, options), 'move', 2)!;
    // Undo must remove the start it invented, rather than leaving an inference behind
    // looking like something the user typed.
    expect(planned.inverse.scheduled).toBeNull();
    expect(planned.inverse.due).toBe('2026-08-21');
  });
});

describe('planDrag: resize', () => {
  it('changes only the start when resizing from the left', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'resize-start', 1);
    expect(planned?.patch.scheduled).toBe('2026-04-15');
    expect(planned?.patch.due).toBeUndefined();
  });

  it('changes only the due date when resizing from the right', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'resize-end', 2);
    expect(planned?.patch.due).toBe('2026-04-18');
    expect(planned?.patch.scheduled).toBeUndefined();
  });

  it('clamps a start dragged past the end to a same-day span', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'resize-start', 10);
    expect(planned?.patch.scheduled).toBe('2026-04-16');
  });

  it('clamps an end dragged before the start', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'resize-end', -10);
    expect(planned?.patch.due).toBe('2026-04-14');
  });

  it('returns null when clamping leaves the value unchanged', () => {
    const t = dated('2026-04-16', '2026-04-16');
    // Already collapsed; dragging the start further right cannot change anything.
    expect(planDrag(t, computeBar(t, options), 'resize-start', 5)).toBeNull();
  });
});

describe('undo', () => {
  it('restores the exact previous values', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'move', 5)!;
    expect(planned.inverse).toEqual({
      path: t.path,
      scheduled: '2026-04-14',
      due: '2026-04-16'
    });
    expect(invert([planned])).toEqual([planned.inverse]);
  });

  it('only inverts the fields the patch actually touched', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'resize-end', 1)!;
    expect(planned.inverse.scheduled).toBeUndefined();
    expect(planned.inverse.due).toBe('2026-04-16');
  });

  it('describes the change in terms the user can check', () => {
    const t = dated('2026-04-14', '2026-04-16');
    const planned = planDrag(t, computeBar(t, options), 'move', 1)!;
    expect(planned.description).toContain('T:');
    expect(planned.description).toContain('2026-04-14');
    expect(planned.description).toContain('2026-04-15');
  });
});

describe('relTypeFor', () => {
  it('maps each pair of bar ends to its relation type', () => {
    expect(relTypeFor('finish', 'start')).toBe('FINISHTOSTART');
    expect(relTypeFor('finish', 'finish')).toBe('FINISHTOFINISH');
    expect(relTypeFor('start', 'start')).toBe('STARTTOSTART');
    expect(relTypeFor('start', 'finish')).toBe('STARTTOFINISH');
  });
});
