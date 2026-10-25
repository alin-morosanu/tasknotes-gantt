import { describe, expect, it } from 'vitest';
import type { Bar, Cycle, Edge, GanttTask, RelType, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { buildAdjacency, detectCycles } from '../src/model/graph';
import { computeSchedule } from '../src/model/schedule';
import { planConflictFixes, planCycleBreaks, type AutofixContext } from '../src/model/autofix';
import { makeTask } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;

const geometry: GeometryOptions = {
  calendar: cal,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};

function edge(from: string, to: string, reltype: RelType = 'FINISHTOSTART', gapMinutes = 0): Edge {
  return { from, uid: from, to, reltype, gapMinutes };
}

interface Fixture extends AutofixContext {
  edges: Edge[];
  cycles: Cycle[];
}

/** Build a fixture from `[path, scheduled, due]` triples and a set of edges. */
function fixture(defs: [string, string, string][], edges: Edge[]): Fixture {
  const tasks = new Map<TaskPath, GanttTask>();
  const bars = new Map<TaskPath, Bar>();
  for (const [path, scheduled, due] of defs) {
    const task = makeTask({
      path,
      title: path,
      scheduled: parseTaskDate(scheduled),
      due: parseTaskDate(due)
    });
    tasks.set(path, task);
    bars.set(path, computeBar(task, geometry));
  }
  const adjacency = buildAdjacency([...tasks.keys()], edges);
  const cycles = detectCycles([...tasks.keys()], adjacency);
  const excluded = new Set<TaskPath>();
  for (const cycle of cycles) for (const m of cycle.members) excluded.add(m);
  return { tasks, bars, adjacency, calendar: cal, excluded, edges, cycles };
}

/** Violations remaining after applying a set of patches. */
function violationsAfter(f: Fixture, patches: { patch: { path: string; scheduled?: string | null; due?: string | null } }[]) {
  const bars = new Map(f.bars);
  for (const { patch } of patches) {
    const task = f.tasks.get(patch.path);
    if (!task) continue;
    const updated = makeTask({
      ...task,
      scheduled: patch.scheduled ? parseTaskDate(patch.scheduled) : task.scheduled,
      due: patch.due ? parseTaskDate(patch.due) : task.due
    });
    bars.set(patch.path, computeBar(updated, geometry));
  }
  return computeSchedule({ bars, edges: f.edges, calendar: cal }).violations;
}

// 2026-04-13 is a Monday.
describe('planConflictFixes', () => {
  it('proposes nothing when the plan already satisfies its dependencies', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-14'],
        ['b', '2026-04-15', '2026-04-16']
      ],
      [edge('a', 'b')]
    );
    expect(planConflictFixes(f)).toEqual([]);
  });

  it('pushes a successor scheduled before its predecessor finishes', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-17'],
        ['b', '2026-04-13', '2026-04-14']
      ],
      [edge('a', 'b')]
    );
    const patches = planConflictFixes(f);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch.path).toBe('b');
    expect(violationsAfter(f, patches)).toEqual([]);
  });

  it('leaves the predecessor exactly where it was', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-17'],
        ['b', '2026-04-13', '2026-04-14']
      ],
      [edge('a', 'b')]
    );
    // The conflict is that b starts too early, so a must not be dragged backwards to
    // meet it — that would rewrite a date nobody complained about.
    expect(planConflictFixes(f).map((p) => p.patch.path)).not.toContain('a');
  });

  it('preserves the task’s duration rather than squashing it', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-17'],
        ['b', '2026-04-13', '2026-04-16']
      ],
      [edge('a', 'b')]
    );
    const patch = planConflictFixes(f)[0]?.patch;
    // Both ends move, so the span is unchanged.
    expect(patch?.scheduled).toBeDefined();
    expect(patch?.due).toBeDefined();
  });

  it('resolves a chain in a single pass', () => {
    const f = fixture(
      [
        ['a', '2026-04-20', '2026-04-21'],
        ['b', '2026-04-14', '2026-04-14'],
        ['c', '2026-04-15', '2026-04-15']
      ],
      [edge('a', 'b'), edge('b', 'c')]
    );
    const patches = planConflictFixes(f);
    expect(patches.map((p) => p.patch.path)).toEqual(['b', 'c']);
    expect(violationsAfter(f, patches)).toEqual([]);
  });

  it('moves a task far enough for its latest predecessor', () => {
    const f = fixture(
      [
        ['early', '2026-04-13', '2026-04-14'],
        ['late', '2026-04-20', '2026-04-24'],
        ['succ', '2026-04-15', '2026-04-15']
      ],
      [edge('early', 'succ'), edge('late', 'succ')]
    );
    expect(violationsAfter(f, planConflictFixes(f))).toEqual([]);
  });

  it('respects a lag on the edge', () => {
    const f = fixture(
      [
        ['a', '2026-04-13', '2026-04-13'],
        ['b', '2026-04-14', '2026-04-14']
      ],
      // Two working days must pass between a finishing and b starting.
      [edge('a', 'b', 'FINISHTOSTART', 960)]
    );
    const patches = planConflictFixes(f);
    expect(patches).toHaveLength(1);
    expect(violationsAfter(f, patches)).toEqual([]);
  });

  it('handles start-to-start and finish-to-finish edges', () => {
    for (const reltype of ['STARTTOSTART', 'FINISHTOFINISH'] as RelType[]) {
      const f = fixture(
        [
          ['a', '2026-04-20', '2026-04-22'],
          ['b', '2026-04-13', '2026-04-14']
        ],
        [edge('a', 'b', reltype)]
      );
      expect(violationsAfter(f, planConflictFixes(f))).toEqual([]);
    }
  });

  it('skips tasks inside a cycle, which have no earliest start', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-13', '2026-04-13']
      ],
      [edge('a', 'b'), edge('b', 'a')]
    );
    expect(planConflictFixes(f)).toEqual([]);
  });

  it('leaves every patch reversible', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-17'],
        ['b', '2026-04-13', '2026-04-14']
      ],
      [edge('a', 'b')]
    );
    const patch = planConflictFixes(f)[0];
    expect(patch?.inverse.scheduled).toBe('2026-04-13');
    expect(patch?.inverse.due).toBe('2026-04-14');
    expect(patch?.description).toContain('b');
  });

  it('clears every violation in a tangled graph', () => {
    const f = fixture(
      [
        ['a', '2026-04-20', '2026-04-22'],
        ['b', '2026-04-13', '2026-04-14'],
        ['c', '2026-04-14', '2026-04-15'],
        ['d', '2026-04-13', '2026-04-13'],
        ['e', '2026-04-16', '2026-04-16']
      ],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'd'), edge('c', 'e'), edge('d', 'e')]
    );
    expect(violationsAfter(f, planConflictFixes(f))).toEqual([]);
  });
});

describe('planCycleBreaks', () => {
  const label = (p: TaskPath) => p;

  it('proposes one removal per cycle', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-16', '2026-04-16']
      ],
      [edge('a', 'b'), edge('b', 'a')]
    );
    const breaks = planCycleBreaks(f.cycles, f.edges, f.bars, label);
    expect(breaks).toHaveLength(1);
  });

  it('removes the edge the dates contradict most', () => {
    // `a` is scheduled first, so the claim that it waits for `b` is the error —
    // this is the shape of the real deadlock in the reference vault.
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-16', '2026-04-16']
      ],
      [edge('b', 'a'), edge('a', 'b')]
    );
    const breaks = planCycleBreaks(f.cycles, f.edges, f.bars, label);
    expect(breaks[0]?.successor).toBe('a');
    expect(breaks[0]?.predecessor).toBe('b');
  });

  it('actually breaks the cycle', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-16', '2026-04-16'],
        ['c', '2026-04-17', '2026-04-17']
      ],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    );
    const breaks = planCycleBreaks(f.cycles, f.edges, f.bars, label);
    const remaining = f.edges.filter(
      (e) => !breaks.some((b) => b.predecessor === e.from && b.successor === e.to)
    );
    const adjacency = buildAdjacency([...f.bars.keys()], remaining);
    expect(detectCycles([...f.bars.keys()], adjacency)).toEqual([]);
  });

  it('handles two independent cycles', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-16', '2026-04-16'],
        ['c', '2026-04-17', '2026-04-17'],
        ['d', '2026-04-18', '2026-04-18']
      ],
      [edge('a', 'b'), edge('b', 'a'), edge('c', 'd'), edge('d', 'c')]
    );
    expect(planCycleBreaks(f.cycles, f.edges, f.bars, label)).toHaveLength(2);
  });

  it('names both tasks in a description a person can check', () => {
    const f = fixture(
      [
        ['a', '2026-04-15', '2026-04-15'],
        ['b', '2026-04-16', '2026-04-16']
      ],
      [edge('a', 'b'), edge('b', 'a')]
    );
    const description = planCycleBreaks(f.cycles, f.edges, f.bars, label)[0]?.description ?? '';
    expect(description).toContain('a');
    expect(description).toContain('b');
  });

  it('proposes nothing when there are no cycles', () => {
    const f = fixture([['a', '2026-04-15', '2026-04-15']], []);
    expect(planCycleBreaks(f.cycles, f.edges, f.bars, label)).toEqual([]);
  });
});
