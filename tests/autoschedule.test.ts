import { describe, expect, it } from 'vitest';
import type { GanttTask, RelType, ResolvedDependency } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { parseTaskDate } from '../src/model/dates';
import { buildIdMap } from '../src/agent/ids';
import { autoschedule, buildScheduleProposal } from '../src/agent/autoschedule';
import { parseProposal } from '../src/agent/proposal';
import { simulate } from '../src/agent/simulate';
import { buildSnapshot } from '../src/agent/snapshot';
import { buildReport } from '../src/agent/diff';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

const at = (s: string) => parseTaskDate(s)!.ms;
// A Monday, so the working week in the assertions below is easy to read.
const NOW = at('2026-05-04T09:00');
const MONDAY = at('2026-05-04');

const dep = (uid: string, reltype: RelType = 'FINISHTOSTART', gap?: string): ResolvedDependency => ({
  uid,
  path: `TaskNotes/Tasks/${uid}.md`,
  reltype,
  ...(gap === undefined ? {} : { gap })
});

const task = (id: string, over: Partial<GanttTask> = {}) =>
  makeTask({ path: `TaskNotes/Tasks/${id}.md`, title: id, ...over });

function run(tasks: GanttTask[], over: Partial<Parameters<typeof autoschedule>[0]> = {}) {
  return autoschedule({
    tasks,
    settings: DEFAULT_SETTINGS,
    catalog: CATALOG,
    now: NOW,
    startMs: MONDAY,
    ...over
  });
}

/** The scheduled span of one task, as the dates that would be written. */
function dates(tasks: GanttTask[], result: ReturnType<typeof autoschedule>, id: string) {
  const ops = buildScheduleProposal(tasks, result, buildIdMap(tasks), DEFAULT_SETTINGS);
  const op = ops.find((o) => o.id === id);
  return op !== undefined && op.op === 'set_dates' ? [op.scheduled, op.due] : null;
}

describe('autoschedule: forward', () => {
  it('starts unblocked work on the day it is given', () => {
    const tasks = [task('A', { timeEstimate: 480 })];
    expect(dates(tasks, run(tasks), 'A')).toEqual(['2026-05-04', '2026-05-04']);
  });

  it('puts a finish-to-start successor on the next working day', () => {
    const tasks = [
      task('A', { timeEstimate: 480 }),
      task('B', { timeEstimate: 480, dependencies: [dep('A')] })
    ];
    expect(dates(tasks, run(tasks), 'B')).toEqual(['2026-05-05', '2026-05-05']);
  });

  it('steps over the weekend', () => {
    // Five one-day tasks in a chain start Monday and end the following Monday.
    const tasks = ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) =>
      task(id, {
        timeEstimate: 480,
        dependencies: i === 0 ? [] : [dep(['A', 'B', 'C', 'D', 'E'][i - 1]!)]
      })
    );
    expect(dates(tasks, run(tasks), 'F')).toEqual(['2026-05-11', '2026-05-11']);
  });

  it('honours a start-to-start edge and its lag', () => {
    // Lag is working time: PT16H is two eight-hour days. Note that `P2D` would mean
    // 2880 minutes of WORKING time — six working days — which is how every other
    // pass in the project reads it too.
    const tasks = [
      task('A', { timeEstimate: 480 }),
      task('B', { timeEstimate: 480, dependencies: [dep('A', 'STARTTOSTART', 'PT16H')] })
    ];
    expect(dates(tasks, run(tasks), 'B')).toEqual(['2026-05-06', '2026-05-06']);
  });

  it('keeps a task the length its dates already give it', () => {
    // Three working days now; three working days after. Laying the plan out again is
    // not the same as re-estimating it.
    const tasks = [
      task('A', {
        scheduled: parseTaskDate('2026-06-01'),
        due: parseTaskDate('2026-06-03'),
        timeEstimate: 60
      })
    ];
    expect(dates(tasks, run(tasks), 'A')).toEqual(['2026-05-04', '2026-05-06']);
  });

  it('falls back to the estimate when the span covers no working time', () => {
    // A task scheduled Saturday to Sunday measures as zero working minutes. Taken
    // literally it would have no length, and its successor would start the same
    // morning — reproducing the conflict this pass exists to remove.
    const tasks = [
      task('A', {
        scheduled: parseTaskDate('2026-05-23'),
        due: parseTaskDate('2026-05-24'),
        timeEstimate: 480
      }),
      task('B', { timeEstimate: 480, dependencies: [dep('A')] })
    ];
    const result = run(tasks);
    expect(dates(tasks, result, 'A')).toEqual(['2026-05-04', '2026-05-04']);
    expect(dates(tasks, result, 'B')).toEqual(['2026-05-05', '2026-05-05']);
    expect(result.notes.join(' ')).toContain('non-working days');
  });

  it('keeps a milestone a point in time', () => {
    const tasks = [
      task('A', { timeEstimate: 480 }),
      task('M', { timeEstimate: 0, dependencies: [dep('A')] })
    ];
    expect(dates(tasks, run(tasks), 'M')).toEqual(['2026-05-05', '2026-05-05']);
  });

  it('gives a task with neither dates nor estimate the default length, and says so', () => {
    const tasks = [task('A')];
    const result = run(tasks);
    expect(dates(tasks, result, 'A')).toEqual(['2026-05-04', '2026-05-04']);
    expect(result.notes.join(' ')).toContain('neither an estimate nor a start and due date');
  });
});

describe('autoschedule: what it refuses to move', () => {
  it('leaves finished work where it is', () => {
    // Rescheduling history would rewrite the record of when the work happened.
    const tasks = [
      task('A', {
        completed: true,
        status: 'done',
        scheduled: parseTaskDate('2026-02-02'),
        due: parseTaskDate('2026-02-03')
      })
    ];
    const result = run(tasks);
    expect(dates(tasks, result, 'A')).toBeNull();
    expect(result.skipped[0]?.reason).toBe('already done');
  });

  it('still lets finished work constrain what follows it', () => {
    const tasks = [
      task('A', {
        completed: true,
        status: 'done',
        scheduled: parseTaskDate('2026-06-01'),
        due: parseTaskDate('2026-06-01')
      }),
      task('B', { timeEstimate: 480, dependencies: [dep('A')] })
    ];
    expect(dates(tasks, run(tasks), 'B')).toEqual(['2026-06-02', '2026-06-02']);
  });

  it('leaves tasks inside a cycle alone, and says why', () => {
    const tasks = [
      task('A', { timeEstimate: 480, dependencies: [dep('B')] }),
      task('B', { timeEstimate: 480, dependencies: [dep('A')] })
    ];
    const result = run(tasks);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'in a circular dependency, so it has no earliest start',
      'in a circular dependency, so it has no earliest start'
    ]);
    expect(buildScheduleProposal(tasks, result, buildIdMap(tasks), DEFAULT_SETTINGS)).toEqual([]);
  });

  it('emits nothing for a task already where it belongs', () => {
    const tasks = [
      task('A', {
        timeEstimate: 480,
        scheduled: parseTaskDate('2026-05-04'),
        due: parseTaskDate('2026-05-04')
      })
    ];
    expect(buildScheduleProposal(tasks, run(tasks), buildIdMap(tasks), DEFAULT_SETTINGS)).toEqual(
      []
    );
  });
});

describe('autoschedule: backward from a deadline', () => {
  const chain = () => [
    task('A', { timeEstimate: 480 }),
    task('B', { timeEstimate: 480, dependencies: [dep('A')] }),
    task('C', { timeEstimate: 480, dependencies: [dep('B')] })
  ];

  it('finishes the last task on the deadline', () => {
    const tasks = chain();
    const result = autoschedule({
      tasks,
      settings: DEFAULT_SETTINGS,
      catalog: CATALOG,
      now: NOW,
      deadlineMs: at('2026-05-08')
    });
    expect(dates(tasks, result, 'C')).toEqual(['2026-05-08', '2026-05-08']);
    expect(dates(tasks, result, 'B')).toEqual(['2026-05-07', '2026-05-07']);
    expect(dates(tasks, result, 'A')).toEqual(['2026-05-06', '2026-05-06']);
  });

  it('says plainly when the deadline needs work to have started already', () => {
    // Clamping to today would hide the only thing worth knowing about this deadline.
    const tasks = chain();
    const result = autoschedule({
      tasks,
      settings: DEFAULT_SETTINGS,
      catalog: CATALOG,
      // Three one-day tasks, and only two working days left before the deadline.
      now: at('2026-05-07T09:00'),
      deadlineMs: at('2026-05-08')
    });
    expect(result.notes.join(' ')).toContain('cannot be met');
    expect(result.notes.join(' ')).toContain('2026-05-06');
  });

  it('does not pretend to level a backward plan', () => {
    const tasks = chain();
    const result = autoschedule({
      tasks,
      settings: DEFAULT_SETTINGS,
      catalog: CATALOG,
      now: NOW,
      deadlineMs: at('2026-06-08'),
      level: true
    });
    expect(result.notes.join(' ')).toContain('forward-pass idea');
  });
});

describe('autoschedule: levelling', () => {
  const withContext = (id: string, over: Partial<GanttTask> = {}) =>
    task(id, { contexts: ['business'], timeEstimate: 480, ...over });

  const levelled = (tasks: GanttTask[], rounds = 50) =>
    run(tasks, { level: true, resourceField: 'contexts', levellingRounds: rounds });

  it('spreads work that would put one resource over capacity', () => {
    // Three independent full days for one person, who has eight hours a day.
    const tasks = [withContext('A'), withContext('B'), withContext('C')];
    const result = levelled(tasks);
    const starts = ['A', 'B', 'C'].map((id) => dates(tasks, result, id)?.[0]);
    expect(new Set(starts).size).toBe(3);
    expect(result.notes.join(' ')).toContain('settled after');
  });

  it('never pulls a task earlier than its dependencies allow', () => {
    const tasks = [
      withContext('A'),
      withContext('B'),
      withContext('C', { dependencies: [dep('A')] })
    ];
    const result = levelled(tasks);
    const a = dates(tasks, result, 'A')?.[1] ?? '';
    const c = dates(tasks, result, 'C')?.[0] ?? '';
    expect(c > a).toBe(true);
  });

  it('says when it ran out of rounds rather than reporting success', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => withContext(`T${i}`));
    expect(levelled(tasks, 2).notes.join(' ')).toContain('did not settle');
  });

  it('refuses to claim success when nothing carries the resource field', () => {
    // Every task falls in the unassigned pile, which is deliberately unlimited, so
    // nothing is ever over capacity — a no-op that would otherwise read as a clean run.
    const tasks = [task('A', { timeEstimate: 480 }), task('B', { timeEstimate: 480 })];
    const result = run(tasks, { level: true, resourceField: 'assignee' });
    expect(result.notes.join(' ')).toContain('Nothing to level');
    expect(result.notes.join(' ')).not.toContain('settled');
  });
});

describe('property: a generated schedule validates clean', () => {
  /**
   * The loop the whole phase exists to close. If a schedule this tool produced does
   * not survive its own validator, an agent has no reason to trust either one.
   */
  it('leaves no dependency conflict among the tasks it moved', () => {
    const tasks = [
      task('A', {
        timeEstimate: 480,
        scheduled: parseTaskDate('2026-06-10'),
        due: parseTaskDate('2026-06-12')
      }),
      // Deliberately contradictory to start with: B is due before A even begins.
      task('B', {
        timeEstimate: 480,
        scheduled: parseTaskDate('2026-06-01'),
        due: parseTaskDate('2026-06-02'),
        dependencies: [dep('A')]
      }),
      task('C', {
        timeEstimate: 960,
        scheduled: parseTaskDate('2026-06-01'),
        due: parseTaskDate('2026-06-03'),
        dependencies: [dep('B', 'STARTTOSTART', 'P1D')]
      }),
      task('D', { timeEstimate: 0, dependencies: [dep('C')] })
    ];

    const result = run(tasks);
    const ids = buildIdMap(tasks);
    const operations = buildScheduleProposal(tasks, result, ids, DEFAULT_SETTINGS);
    expect(operations.length).toBeGreaterThan(0);

    const parsed = parseProposal({ version: 1, operations }, ids, CATALOG);
    expect(parsed.errors).toEqual([]);
    const applied = simulate(tasks, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(applied.errors).toEqual([]);

    const snapshotOf = (list: GanttTask[]) =>
      buildSnapshot({
        vaultPath: '/vault',
        tasks: list,
        totalInVault: list.length,
        scopeDescription: 'test',
        catalog: CATALOG,
        settings: DEFAULT_SETTINGS,
        now: NOW
      });
    const report = buildReport(snapshotOf(tasks), snapshotOf(applied.tasks), parsed.errors);

    expect(report.ok).toBe(true);
    expect(report.summary.conflicts.before).toBeGreaterThan(0);
    expect(report.summary.conflicts.after).toBe(0);
  });
});
