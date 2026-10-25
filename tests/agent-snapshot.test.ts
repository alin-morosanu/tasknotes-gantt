import { describe, expect, it } from 'vitest';
import type { GanttTask } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { parseTaskDate } from '../src/model/dates';
import { buildSnapshot, type SnapshotInput } from '../src/agent/snapshot';
import { renderBrief } from '../src/agent/brief';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

const at = (s: string) => parseTaskDate(s)!.ms;

function snapshotOf(tasks: GanttTask[], over: Partial<SnapshotInput> = {}) {
  return buildSnapshot({
    vaultPath: '/vault',
    tasks,
    totalInVault: tasks.length,
    scopeDescription: 'test',
    catalog: CATALOG,
    settings: { ...DEFAULT_SETTINGS },
    // 2026-04-13 is a Monday.
    now: at('2026-04-13T09:00'),
    ...over
  });
}

const dated = (title: string, scheduled: string | null, due: string | null, over = {}) =>
  makeTask({
    path: `TaskNotes/Tasks/${title}.md`,
    title,
    scheduled: scheduled === null ? null : parseTaskDate(scheduled),
    due: due === null ? null : parseTaskDate(due),
    ...over
  });

describe('durationDays', () => {
  it('counts working days, not elapsed ones', () => {
    // Wed to Fri inclusive is three working days. Dividing elapsed time by the length
    // of a working day made this ten, and every duration in every snapshot with it.
    const snapshot = snapshotOf([dated('A', '2026-04-15', '2026-04-17')]);
    expect(snapshot.tasks[0]?.durationDays).toBe(3);
  });

  it('does not count a closed weekend', () => {
    const snapshot = snapshotOf([dated('A', '2026-04-18', '2026-04-20')]);
    expect(snapshot.tasks[0]?.durationDays).toBe(1);
  });

  it('reports a conflict in working days too', () => {
    const blocked = dated('B', '2026-04-13', '2026-04-13', {
      dependencies: [
        { uid: 'A', path: 'TaskNotes/Tasks/A.md', reltype: 'FINISHTOSTART' as const }
      ]
    });
    const snapshot = snapshotOf([dated('A', '2026-04-15', '2026-04-17'), blocked]);
    expect(snapshot.problems.conflicts[0]?.overlapDays).toBe(5);
  });
});

describe('date origin', () => {
  it('marks an authored date as authored', () => {
    const snapshot = snapshotOf([dated('BEL-0001', '2026-04-14', '2026-04-16')]);
    expect(snapshot.tasks[0]?.start).toEqual({ date: '2026-04-14', origin: 'authored' });
    expect(snapshot.tasks[0]?.end).toEqual({ date: '2026-04-16', origin: 'authored' });
  });

  it('marks a start the chart worked out as inferred', () => {
    // The BOA-* shape: a due date and nothing else. Presenting the derived start as
    // authored would invite an agent to protect a date nobody chose.
    const snapshot = snapshotOf([
      dated('BOA-0002', null, '2026-08-21', { timeEstimate: 120 })
    ]);
    expect(snapshot.tasks[0]?.start.origin).toBe('inferred');
    expect(snapshot.tasks[0]?.end.origin).toBe('authored');
  });

  it('marks both ends inferred for a task with no dates', () => {
    const snapshot = snapshotOf([dated('TASK-0610', null, null, { timeEstimate: 480 })]);
    expect(snapshot.tasks[0]?.start.origin).toBe('inferred');
    expect(snapshot.tasks[0]?.end.origin).toBe('inferred');
  });
});

describe('vocabulary', () => {
  it('states which statuses mean done, rather than leaving it to be guessed', () => {
    const snapshot = snapshotOf([dated('A', '2026-04-14', '2026-04-16')]);
    const done = snapshot.vocabulary.statuses.filter((s) => s.done).map((s) => s.value);
    expect(done).toEqual(['done']);
  });

  it('reports the working calendar the agent must reason with', () => {
    const snapshot = snapshotOf([dated('A', '2026-04-14', '2026-04-16')]);
    expect(snapshot.calendar.workdays).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday'
    ]);
    expect(snapshot.calendar.hoursPerDay).toBe(8);
  });
});

describe('problems', () => {
  const blocked = (title: string, scheduled: string, due: string, blockedByPath: string) =>
    makeTask({
      path: `TaskNotes/Tasks/${title}.md`,
      title,
      scheduled: parseTaskDate(scheduled),
      due: parseTaskDate(due),
      dependencies: [{ uid: blockedByPath, path: blockedByPath, reltype: 'FINISHTOSTART' }]
    });

  it('reports a task scheduled before its dependency, in short ids', () => {
    const a = dated('BEL-0001', '2026-04-20', '2026-04-22');
    const b = blocked('BEL-0002', '2026-04-13', '2026-04-14', a.path);
    const snapshot = snapshotOf([a, b]);
    expect(snapshot.problems.conflicts).toHaveLength(1);
    expect(snapshot.problems.conflicts[0]?.task).toBe('BEL-0002');
    expect(snapshot.problems.conflicts[0]?.blockedBy).toBe('BEL-0001');
    expect(snapshot.problems.conflicts[0]?.overlapDays).toBeGreaterThan(0);
  });

  it('reports a cycle and excludes its members from scheduling', () => {
    const aPath = 'TaskNotes/Tasks/BEL-0003.md';
    const bPath = 'TaskNotes/Tasks/BEL-0004.md';
    const a = blocked('BEL-0003', '2026-04-15', '2026-04-15', bPath);
    const b = blocked('BEL-0004', '2026-04-16', '2026-04-16', aPath);
    const snapshot = snapshotOf([{ ...a, path: aPath }, { ...b, path: bPath }]);

    expect(snapshot.problems.cycles).toHaveLength(1);
    expect(snapshot.unknowns.excludedFromScheduling.sort()).toEqual(['BEL-0003', 'BEL-0004']);
    // A task with no earliest start has no float, and must not report zero.
    for (const task of snapshot.tasks) expect(task.floatDays).toBeNull();
  });
});

describe('unknowns', () => {
  it('counts what it cannot see rather than presenting a confident total', () => {
    const snapshot = snapshotOf([
      dated('A', '2026-04-14', '2026-04-16', { timeEstimate: 480 }),
      dated('B', null, '2026-04-16'),
      dated('C', null, null)
    ]);
    expect(snapshot.unknowns.tasksWithoutEstimate).toBe(2);
    expect(snapshot.unknowns.tasksWithoutDates).toBe(1);
    expect(snapshot.unknowns.tasksWithInferredDates).toBe(2);
  });

  it('reports a dependency pointing at nothing', () => {
    const task = makeTask({
      path: 'TaskNotes/Tasks/SAL-0002.md',
      title: 'SAL-0002',
      scheduled: parseTaskDate('2026-04-14'),
      due: parseTaskDate('2026-04-16'),
      dependencies: [{ uid: 'TaskNotes/Tasks/SAL-0001 missing', path: null, reltype: 'FINISHTOSTART' }]
    });
    const snapshot = snapshotOf([task]);
    expect(snapshot.unknowns.danglingDependencies).toEqual([
      { task: 'SAL-0002', link: 'TaskNotes/Tasks/SAL-0001 missing' }
    ]);
    expect(snapshot.tasks[0]?.dependencies[0]?.unresolved).toBe(true);
  });

  it('reports a project link pointing at nothing', () => {
    const task = dated('A', '2026-04-14', '2026-04-16', {
      projects: [{ raw: '[[Side Project]]', target: 'Side Project', path: null }]
    });
    expect(snapshotOf([task]).unknowns.danglingProjects).toEqual([
      { project: 'Side Project', taskCount: 1 }
    ]);
  });
});

describe('renderBrief', () => {
  const tasks = [
    dated('BEL-0001', '2026-04-14', '2026-04-16', { timeEstimate: 480 }),
    dated('BOA-0002', null, '2026-08-21', { timeEstimate: 120 })
  ];

  it('leads with scope and problems, so a truncated read still carries them', () => {
    const brief = renderBrief(snapshotOf(tasks));
    const problemsAt = brief.indexOf('## Problems');
    const tasksAt = brief.indexOf('## Tasks');
    expect(problemsAt).toBeGreaterThan(-1);
    expect(problemsAt).toBeLessThan(tasksAt);
  });

  it('marks an inferred date with a tilde and explains it in the legend', () => {
    const brief = renderBrief(snapshotOf(tasks));
    expect(brief).toContain('~2026-08-21');
    expect(brief).toContain('the chart inferred this date');
  });

  it('says so plainly when there is nothing wrong', () => {
    expect(renderBrief(snapshotOf([tasks[0]!]))).toContain('None.');
  });

  it('omits the table on request, for a problems-only view', () => {
    const brief = renderBrief(snapshotOf(tasks), { summaryOnly: true });
    expect(brief).not.toContain('## Tasks');
    expect(brief).toContain('## Problems');
  });

  it('expands only the ids asked for', () => {
    const brief = renderBrief(snapshotOf(tasks), { detail: ['BOA-0002'] });
    expect(brief).toContain('### BOA-0002');
    expect(brief).not.toContain('### BEL-0001');
  });

  it('stays far smaller than the notes it summarises', () => {
    // The point of the brief is that it fits in a context window; a regression here
    // would be a regression in usefulness.
    const brief = renderBrief(snapshotOf(tasks));
    expect(brief.split(/\s+/).length).toBeLessThan(400);
  });
});
