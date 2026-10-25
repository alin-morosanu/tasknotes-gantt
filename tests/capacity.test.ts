import { describe, expect, it } from 'vitest';
import type { Bar, GanttTask, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { makeTask as task } from './fixtures/build';
import {
  computeCapacity,
  planLevelling,
  resourceValues,
  spanByDay,
  UNASSIGNED,
  type CapacityOptions
} from '../src/model/capacity';

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;

const geometry: GeometryOptions = {
  calendar: cal,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};


function options(over: Partial<CapacityOptions> = {}): CapacityOptions {
  return {
    calendar: cal,
    resourceField: 'assignee',
    defaultCapacityMinutes: 480,
    capacityOverrides: {},
    includeCompleted: false,
    ...over
  };
}

function withBars(tasks: GanttTask[]): ReadonlyMap<TaskPath, Bar> {
  return new Map(tasks.map((t) => [t.path, computeBar(t, geometry)]));
}

const dated = (title: string, scheduled: string, due: string, over: Partial<GanttTask> = {}) =>
  task({ title, scheduled: parseTaskDate(scheduled), due: parseTaskDate(due), ...over });

describe('resourceValues', () => {
  it('reads a custom frontmatter field', () => {
    expect(resourceValues(task({ extra: { assignee: 'Avery' } }), 'assignee')).toEqual([
      'Avery'
    ]);
  });

  it('reads a list-valued field, giving one lane per value', () => {
    expect(
      resourceValues(task({ extra: { assignee: ['Avery', 'Alin'] } }), 'assignee')
    ).toEqual(['Avery', 'Alin']);
  });

  it('reads TaskNotes’ own mapped fields, which never reach `extra`', () => {
    // Reading `extra` alone produced a single empty lane for contexts, despite the
    // reference vault having 100% coverage on that field.
    expect(resourceValues(task({ contexts: ['business', 'learning'] }), 'contexts')).toEqual([
      'business',
      'learning'
    ]);
    expect(resourceValues(task({ status: 'in-progress' }), 'status')).toEqual(['in-progress']);
    expect(resourceValues(task({ tags: ['task'] }), 'tags')).toEqual(['task']);
  });

  it('falls back to the unassigned bucket', () => {
    expect(resourceValues(task(), 'assignee')).toEqual([UNASSIGNED]);
    expect(resourceValues(task({ contexts: [] }), 'contexts')).toEqual([UNASSIGNED]);
    expect(resourceValues(task({ extra: { assignee: '   ' } }), 'assignee')).toEqual([UNASSIGNED]);
  });
});

describe('spanByDay', () => {
  it('splits a multi-day bar into its working days', () => {
    const bar = computeBar(dated('A', '2026-04-13', '2026-04-15'), geometry);
    const days = spanByDay(bar, cal);
    expect(days.size).toBe(3);
    expect([...days.values()].every((m) => m === 480)).toBe(true);
  });

  it('skips the weekend', () => {
    const bar = computeBar(dated('A', '2026-04-17', '2026-04-20'), geometry);
    // Friday and Monday carry hours; Saturday and Sunday do not.
    expect(spanByDay(bar, cal).size).toBe(2);
  });

  it('returns nothing for a milestone', () => {
    const bar = computeBar(task({ due: parseTaskDate('2026-04-13'), timeEstimate: 0 }), geometry);
    expect(spanByDay(bar, cal).size).toBe(0);
  });
});

describe('computeCapacity', () => {
  it('spreads an estimate across the days its bar covers', () => {
    const t = dated('A', '2026-04-13', '2026-04-15', {
      timeEstimate: 1440,
      extra: { assignee: 'Avery' }
    });
    const result = computeCapacity([t], withBars([t]), options());
    const lane = result.resources.get('Avery')!;
    expect(lane.days.size).toBe(3);
    // 1440 minutes over three equal working days.
    for (const day of lane.days.values()) expect(day.minutes).toBeCloseTo(480, 6);
    expect(lane.totalMinutes).toBe(1440);
  });

  it('adds the load of overlapping tasks on the same day', () => {
    const a = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 300,
      extra: { assignee: 'Avery' }
    });
    const b = dated('B', '2026-04-13', '2026-04-13', {
      timeEstimate: 300,
      extra: { assignee: 'Avery' }
    });
    const result = computeCapacity([a, b], withBars([a, b]), options());
    const lane = result.resources.get('Avery')!;
    expect(lane.peakMinutes).toBeCloseTo(600, 6);
    expect(lane.overloadedDays).toBe(1);
  });

  it('counts a task once per lane when it names two people', () => {
    const t = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 480,
      extra: { assignee: ['Avery', 'Alin'] }
    });
    const result = computeCapacity([t], withBars([t]), options());
    expect(result.resources.get('Avery')?.totalMinutes).toBe(480);
    expect(result.resources.get('Alin')?.totalMinutes).toBe(480);
  });

  it('never flags the unassigned bucket as over capacity', () => {
    // 141 unowned tasks in the reference vault reported a 38-hour day against one
    // person's capacity, which is arithmetic rather than information.
    const tasks = Array.from({ length: 10 }, (_, i) =>
      dated(`T${i}`, '2026-04-13', '2026-04-13', { timeEstimate: 480 })
    );
    const result = computeCapacity(tasks, withBars(tasks), options());
    const lane = result.resources.get(UNASSIGNED)!;
    expect(lane.unlimited).toBe(true);
    expect(lane.overloadedDays).toBe(0);
    expect(lane.peakMinutes).toBeCloseTo(4800, 6);
  });

  it('does capacity-check the unassigned bucket when given an explicit number', () => {
    const tasks = Array.from({ length: 3 }, (_, i) =>
      dated(`T${i}`, '2026-04-13', '2026-04-13', { timeEstimate: 480 })
    );
    const result = computeCapacity(
      tasks,
      withBars(tasks),
      options({ capacityOverrides: { [UNASSIGNED]: 480 } })
    );
    expect(result.resources.get(UNASSIGNED)?.overloadedDays).toBe(1);
  });

  it('honours a per-resource capacity override', () => {
    const t = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 1200,
      extra: { assignee: 'Team' }
    });
    const result = computeCapacity(
      [t],
      withBars([t]),
      options({ capacityOverrides: { Team: 1920 } })
    );
    expect(result.resources.get('Team')?.overloadedDays).toBe(0);
  });

  it('reports unestimated tasks rather than inventing a number for them', () => {
    const withEstimate = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 480,
      extra: { assignee: 'Avery' }
    });
    const without = dated('B', '2026-04-13', '2026-04-13', { extra: { assignee: 'Avery' } });
    const result = computeCapacity(
      [withEstimate, without],
      withBars([withEstimate, without]),
      options()
    );
    const lane = result.resources.get('Avery')!;
    expect(lane.taskCount).toBe(2);
    expect(lane.unestimatedCount).toBe(1);
    expect(lane.totalMinutes).toBe(480);
    expect(result.unestimatedTotal).toBe(1);
  });

  it('excludes completed and archived work by default', () => {
    const done = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 480,
      completed: true,
      extra: { assignee: 'Avery' }
    });
    const archived = dated('B', '2026-04-13', '2026-04-13', {
      timeEstimate: 480,
      archived: true,
      extra: { assignee: 'Avery' }
    });
    const result = computeCapacity([done, archived], withBars([done, archived]), options());
    expect(result.resources.size).toBe(0);
    expect(result.consideredTasks).toBe(0);
  });

  it('reports how much of the data set the resource axis actually covers', () => {
    const assigned = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 480,
      extra: { assignee: 'Avery' }
    });
    const unassigned = dated('B', '2026-04-13', '2026-04-13', { timeEstimate: 480 });
    const result = computeCapacity(
      [assigned, unassigned],
      withBars([assigned, unassigned]),
      options()
    );
    expect(result.assignedTasks).toBe(1);
    expect(result.consideredTasks).toBe(2);
  });
});

describe('planLevelling', () => {
  const levelling = (tasks: GanttTask[]) =>
    planLevelling(tasks, withBars(tasks), {
      ...options(),
      priorityWeight: (t) => ({ high: 3, normal: 2, low: 1 })[t.priority] ?? 0,
      floatMinutes: () => 0,
      maxPushDays: 30
    });

  it('proposes nothing when everyone is within capacity', () => {
    const t = dated('A', '2026-04-13', '2026-04-13', {
      timeEstimate: 240,
      extra: { assignee: 'Avery' }
    });
    expect(levelling([t])).toEqual([]);
  });

  it('pushes the lower-priority task off an overloaded day', () => {
    const high = dated('High', '2026-04-13', '2026-04-13', {
      timeEstimate: 400,
      priority: 'high',
      extra: { assignee: 'Avery' }
    });
    const low = dated('Low', '2026-04-13', '2026-04-13', {
      timeEstimate: 400,
      priority: 'low',
      extra: { assignee: 'Avery' }
    });
    const proposals = levelling([high, low]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.path).toBe(low.path);
    expect(proposals[0]?.dayDelta).toBeGreaterThan(0);
    expect(proposals[0]?.reason).toContain('Avery');
  });

  it('leaves the unassigned bucket alone, since it has no capacity to exceed', () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      dated(`T${i}`, '2026-04-13', '2026-04-13', { timeEstimate: 480 })
    );
    expect(levelling(tasks)).toEqual([]);
  });

  it('proposes each task at most once', () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      dated(`T${i}`, '2026-04-13', '2026-04-15', {
        timeEstimate: 900,
        extra: { assignee: 'Avery' }
      })
    );
    const proposals = levelling(tasks);
    const paths = proposals.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
