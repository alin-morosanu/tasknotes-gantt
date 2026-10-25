import { describe, expect, it } from 'vitest';
import type { Bar, GanttTask, RelType, ResolvedDependency, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { buildAdjacency, buildEdges } from '../src/model/graph';
import { computeCapacity } from '../src/model/capacity';
import { checkEdge } from '../src/model/constraints';
import { planLevellingRun, type LevellingRunOptions } from '../src/model/levelling';
import { makeTask } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;

const geometry: GeometryOptions = {
  calendar: cal,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  // 2026-04-13 is a Monday.
  todayMs: at('2026-04-13T09:00')
};

const dep = (id: string, reltype: RelType = 'FINISHTOSTART'): ResolvedDependency => ({
  uid: id,
  path: `TaskNotes/Tasks/${id}.md`,
  reltype
});

/** A task with a resource, an estimate and a one-day span unless told otherwise. */
function task(
  id: string,
  scheduled: string,
  due: string,
  over: Partial<GanttTask> = {}
): GanttTask {
  return makeTask({
    path: `TaskNotes/Tasks/${id}.md`,
    title: id,
    scheduled: parseTaskDate(scheduled),
    due: parseTaskDate(due),
    timeEstimate: 480,
    contexts: ['alice'],
    ...over
  });
}

function bars(tasks: readonly GanttTask[]): Map<TaskPath, Bar> {
  return new Map(tasks.map((t) => [t.path, computeBar(t, geometry)]));
}

function options(
  tasks: readonly GanttTask[],
  over: Partial<LevellingRunOptions> = {}
): LevellingRunOptions {
  const { edges } = buildEdges([...tasks]);
  return {
    calendar: cal,
    resourceField: 'contexts',
    defaultCapacityMinutes: 480,
    capacityOverrides: {},
    includeCompleted: false,
    priorityWeight: () => 0,
    floatMinutes: () => null,
    maxPushDays: 60,
    adjacency: buildAdjacency(
      tasks.map((t) => t.path),
      edges
    ),
    excluded: new Set<TaskPath>(),
    ...over
  };
}

const run = (tasks: readonly GanttTask[], over: Partial<LevellingRunOptions> = {}) =>
  planLevellingRun(tasks, bars(tasks), options(tasks, over));

/** Apply a run's patches and hand back the resulting bars. */
function after(tasks: readonly GanttTask[], result: ReturnType<typeof planLevellingRun>) {
  const moved = tasks.map((t) => {
    const patch = result.patches.find((p) => p.patch.path === t.path)?.patch;
    if (!patch) return t;
    return {
      ...t,
      scheduled: patch.scheduled ? parseTaskDate(patch.scheduled) : t.scheduled,
      due: patch.due ? parseTaskDate(patch.due) : t.due
    };
  });
  return { tasks: moved, bars: bars(moved) };
}

/** Days any real lane is over capacity. */
function overloadedDays(tasks: readonly GanttTask[], barMap: ReadonlyMap<TaskPath, Bar>) {
  const capacity = computeCapacity(tasks, barMap, options(tasks));
  let days = 0;
  for (const lane of capacity.resources.values()) {
    if (!lane.unlimited) days += lane.overloadedDays;
  }
  return days;
}

/** Dependency conflicts remaining, the thing a single levelling pass introduces. */
function conflicts(tasks: readonly GanttTask[], barMap: ReadonlyMap<TaskPath, Bar>) {
  const { edges } = buildEdges([...tasks]);
  return edges.filter((edge) => {
    const from = barMap.get(edge.from);
    const to = barMap.get(edge.to);
    if (!from || !to) return false;
    return (
      checkEdge(edge, from.startMs, from.endMs, to.startMs, to.endMs, cal, (p) => p) !== null
    );
  });
}

describe('planLevellingRun', () => {
  it('spreads a day that one person cannot fit', () => {
    // Three full days of work for one person, all on the same Monday.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13'),
      task('C', '2026-04-13', '2026-04-13')
    ];
    const result = run(tasks);
    expect(result.settled).toBe(true);
    expect(result.lanes).toBe(1);
    expect(overloadedDays(tasks, bars(tasks))).toBeGreaterThan(0);

    const state = after(tasks, result);
    expect(overloadedDays(state.tasks, state.bars)).toBe(0);
  });

  it('never pulls a task earlier', () => {
    // The problem being solved is a day that is too full. Closing a gap is a different
    // decision, and one made for reasons the capacity numbers cannot see.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13'),
      task('C', '2026-04-30', '2026-04-30')
    ];
    for (const patch of run(tasks).patches) {
      const original = tasks.find((t) => t.path === patch.patch.path)!;
      expect(patch.patch.scheduled! >= original.scheduled!.raw).toBe(true);
    }
  });

  it('leaves no dependency conflict behind', () => {
    // The reason this is a loop. A single levelling pass pushes a task past its own
    // successors and trades an overload for a set of contradictions.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13', { dependencies: [dep('A')] }),
      task('C', '2026-04-13', '2026-04-13', { dependencies: [dep('B')] }),
      task('D', '2026-04-13', '2026-04-13')
    ];
    const result = run(tasks);
    const state = after(tasks, result);
    expect(conflicts(state.tasks, state.bars)).toEqual([]);
    expect(overloadedDays(state.tasks, state.bars)).toBe(0);
  });

  it('leaves a conflict it did not cause to the button that owns it', () => {
    // X and Y contradict each other already and have nothing to do with the overload.
    // Fixing them here would mean a click labelled "level resources" rewrote dates
    // for a reason the user did not ask about — and the chart has a separate
    // "Reschedule them" for exactly that.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13'),
      task('X', '2026-04-20', '2026-04-20', { contexts: ['bob'] }),
      task('Y', '2026-04-15', '2026-04-15', { contexts: ['bob'], dependencies: [dep('X')] })
    ];

    const before = conflicts(tasks, bars(tasks));
    expect(before).toHaveLength(1);

    const result = run(tasks);
    expect(result.patches.map((p) => p.patch.path)).not.toContain('TaskNotes/Tasks/Y.md');

    const state = after(tasks, result);
    expect(conflicts(state.tasks, state.bars)).toHaveLength(1);
    expect(overloadedDays(state.tasks, state.bars)).toBe(0);
  });

  it('honours a relation type other than finish-to-start', () => {
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13', {
        dependencies: [dep('A', 'STARTTOSTART')]
      }),
      task('C', '2026-04-13', '2026-04-13')
    ];
    const state = after(tasks, run(tasks));
    expect(conflicts(state.tasks, state.bars)).toEqual([]);
  });

  it('produces one patch per task, from where it started', () => {
    // A task pushed in several rounds must still invert to its original date, or undo
    // lands somewhere the user has never seen.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13'),
      task('C', '2026-04-13', '2026-04-13'),
      task('D', '2026-04-13', '2026-04-13')
    ];
    const result = run(tasks);
    const paths = result.patches.map((p) => p.patch.path);
    expect(new Set(paths).size).toBe(paths.length);

    for (const patch of result.patches) {
      const original = tasks.find((t) => t.path === patch.patch.path)!;
      expect(patch.inverse.scheduled).toBe(original.scheduled!.raw);
      expect(patch.inverse.due).toBe(original.due!.raw);
    }
  });

  it('does nothing when no day is over capacity', () => {
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-14', '2026-04-14')
    ];
    const result = run(tasks);
    expect(result.patches).toEqual([]);
    expect(result.settled).toBe(true);
    expect(result.rounds).toBe(0);
  });

  it('reports an empty resource field instead of reporting success', () => {
    // Every task falls into the unassigned lane, which is deliberately unlimited, so
    // nothing is ever over capacity. "Levelled 0 tasks" would be a lie by omission.
    const tasks = [
      task('A', '2026-04-13', '2026-04-13', { contexts: [] }),
      task('B', '2026-04-13', '2026-04-13', { contexts: [] })
    ];
    const result = run(tasks, { resourceField: 'assignee' });
    expect(result.lanes).toBe(0);
    expect(result.patches).toEqual([]);
  });

  it('says it ran out of rounds rather than claiming to have settled', () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task(`T${i}`, '2026-04-13', '2026-04-13')
    );
    const result = run(tasks, { maxRounds: 1 });
    expect(result.settled).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.rounds).toBe(1);
  });

  it('leaves a task inside a cycle where it is', () => {
    const tasks = [
      task('A', '2026-04-13', '2026-04-13', { dependencies: [dep('B')] }),
      task('B', '2026-04-13', '2026-04-13', { dependencies: [dep('A')] }),
      task('C', '2026-04-13', '2026-04-13')
    ];
    const excluded = new Set<TaskPath>(['TaskNotes/Tasks/A.md', 'TaskNotes/Tasks/B.md']);
    const result = run(tasks, { excluded });
    // It may still be chosen as a levelling victim, but nothing tries to reason about
    // its dependencies, which have no earliest start to work from.
    expect(result.settled).toBe(true);
  });

  it('respects a per-resource capacity override', () => {
    const tasks = [
      task('A', '2026-04-13', '2026-04-13'),
      task('B', '2026-04-13', '2026-04-13')
    ];
    // Two full days fit when the lane is worth two days.
    const result = run(tasks, { capacityOverrides: { alice: 960 } });
    expect(result.patches).toEqual([]);
  });
});
