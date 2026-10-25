import { describe, expect, it } from 'vitest';
import type { Bar, Edge, GanttTask, RelType, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { buildAdjacency } from '../src/model/graph';
import { planCascade, planDrag } from '../src/model/reschedule';
import { makeTask } from './fixtures/build';

const task = (path: string, scheduled: string, due: string) =>
  makeTask({ path, title: path, scheduled: parseTaskDate(scheduled), due: parseTaskDate(due) });

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;

const options: GeometryOptions = {
  calendar: cal,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};


function edge(from: string, to: string, reltype: RelType = 'FINISHTOSTART', gapMinutes = 0): Edge {
  return { from, uid: from, to, reltype, gapMinutes };
}

interface Fixture {
  tasks: Map<TaskPath, GanttTask>;
  bars: Map<TaskPath, Bar>;
  adjacency: ReturnType<typeof buildAdjacency>;
}

function fixture(defs: [string, string, string][], edges: Edge[]): Fixture {
  const tasks = new Map<TaskPath, GanttTask>();
  const bars = new Map<TaskPath, Bar>();
  for (const [path, scheduled, due] of defs) {
    const t = task(path, scheduled, due);
    tasks.set(path, t);
    bars.set(path, computeBar(t, options));
  }
  return { tasks, bars, adjacency: buildAdjacency([...tasks.keys()], edges) };
}

function cascade(f: Fixture, path: string, dayDelta: number, excluded: string[] = []) {
  const t = f.tasks.get(path)!;
  const bar = f.bars.get(path)!;
  const primary = planDrag(t, bar, 'move', dayDelta)!;
  return planCascade(primary, {
    tasks: f.tasks,
    bars: f.bars,
    adjacency: f.adjacency,
    calendar: cal,
    excluded: new Set(excluded)
  });
}

// 2026-04-13 is a Monday.
describe('planCascade', () => {
  it('pushes a successor that the move would otherwise overrun', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-14'],
        ['b', '2026-04-15', '2026-04-16']
      ],
      [edge('a', 'b')]
    );
    const patches = cascade(f, 'a', 3);
    expect(patches).toHaveLength(2);
    expect(patches[0]?.patch.path).toBe('a');
    expect(patches[1]?.patch.path).toBe('b');
    // A now finishes on the 17th, so B cannot still start on the 15th.
    expect(patches[1]?.patch.scheduled).not.toBe('2026-04-15');
  });

  it('leaves a successor alone when there is enough slack to absorb the move', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-14'],
        ['b', '2026-04-27', '2026-04-28']
      ],
      [edge('a', 'b')]
    );
    // Two weeks of slack easily absorbs a one-day shift.
    expect(cascade(f, 'a', 1)).toHaveLength(1);
  });

  it('never pulls a successor earlier', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-14'],
        ['b', '2026-04-15', '2026-04-16']
      ],
      [edge('a', 'b')]
    );
    // Moving A earlier leaves B's constraint satisfied, so B must not move: the gap
    // may be deliberate, and the dependency graph cannot know.
    expect(cascade(f, 'a', -5)).toHaveLength(1);
  });

  it('propagates along a chain', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14'],
        ['c', '2026-04-15', '2026-04-15']
      ],
      [edge('a', 'b'), edge('b', 'c')]
    );
    const patches = cascade(f, 'a', 5);
    expect(patches.map((p) => p.patch.path).sort()).toEqual(['a', 'b', 'c']);
  });

  it('patches each task once, taking the larger push when two paths reach it', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14'],
        ['c', '2026-04-14', '2026-04-14'],
        ['d', '2026-04-15', '2026-04-15']
      ],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    );
    const patches = cascade(f, 'a', 4);
    const paths = patches.map((p) => p.patch.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('d');
  });

  it('respects a lag when deciding how far to push', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14']
      ],
      // Two working days of required gap between A finishing and B starting.
      [edge('a', 'b', 'FINISHTOSTART', 960)]
    );
    const patches = cascade(f, 'a', 1);
    expect(patches).toHaveLength(2);
  });

  it('skips tasks inside a dependency cycle', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14']
      ],
      [edge('a', 'b')]
    );
    expect(cascade(f, 'a', 5, ['b'])).toHaveLength(1);
  });

  it('keeps every patch reversible', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14']
      ],
      [edge('a', 'b')]
    );
    const patches = cascade(f, 'a', 5);
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(patch.inverse.path).toBe(patch.patch.path);
      expect(patch.inverse.scheduled).toBeDefined();
      expect(patch.description).toBeTruthy();
    }
    // The inverse restores exactly what the note held before.
    expect(patches[1]?.inverse.scheduled).toBe('2026-04-14');
  });

  it('terminates on a wide fan-out', () => {
    const defs: [string, string, string][] = [['root', '2026-04-13', '2026-04-13']];
    const edges: Edge[] = [];
    for (let i = 0; i < 500; i += 1) {
      defs.push([`n${i}`, '2026-04-14', '2026-04-14']);
      edges.push(edge('root', `n${i}`));
    }
    const f = fixture(defs, edges);
    const patches = cascade(f, 'root', 10);
    expect(patches).toHaveLength(501);
  });
});
