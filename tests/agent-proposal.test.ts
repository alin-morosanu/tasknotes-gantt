import { describe, expect, it } from 'vitest';
import type { GanttTask } from '../src/types';
import { calendarFrom, DEFAULT_SETTINGS } from '../src/settings/defaults';
import { computeBars } from '../src/model/geometry';
import { buildAdjacency, buildEdges } from '../src/model/graph';
import { planConflictFixes } from '../src/model/autofix';
import { parseTaskDate } from '../src/model/dates';
import { buildIdMap } from '../src/agent/ids';
import { parseProposal, suggestIds } from '../src/agent/proposal';
import { simulate } from '../src/agent/simulate';
import { buildSnapshot } from '../src/agent/snapshot';
import { buildReport, renderReport } from '../src/agent/diff';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

const at = (s: string) => parseTaskDate(s)!.ms;
const NOW = at('2026-04-13T09:00');

const task = (id: string, scheduled: string, due: string, over: Partial<GanttTask> = {}) =>
  makeTask({
    path: `TaskNotes/Tasks/${id} Something.md`,
    title: `${id}: Something`,
    scheduled: parseTaskDate(scheduled),
    due: parseTaskDate(due),
    ...over
  });

const TASKS = [
  task('BEL-0001', '2026-04-13', '2026-04-14'),
  task('BEL-0002', '2026-04-15', '2026-04-16'),
  task('BEL-0003', '2026-04-17', '2026-04-17')
];

const ids = () => buildIdMap(TASKS);

function parse(operations: unknown[], rationale?: string) {
  return parseProposal({ version: 1, operations, rationale }, ids(), CATALOG);
}

/** Run a proposal end to end and return its report. */
function validate(operations: unknown[], tasks: GanttTask[] = TASKS) {
  const map = buildIdMap(tasks);
  const parsed = parseProposal({ version: 1, operations }, map, CATALOG);
  const applied = simulate(tasks, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
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
  return buildReport(snapshotOf(tasks), snapshotOf(applied.tasks), [
    ...parsed.errors,
    ...applied.errors
  ]);
}

describe('parseProposal: shape', () => {
  it('rejects anything that is not an object', () => {
    expect(parseProposal('nope', ids(), CATALOG).errors[0]?.message).toContain('JSON object');
    expect(parseProposal([], ids(), CATALOG).errors).toHaveLength(1);
  });

  it('rejects a missing operations array', () => {
    expect(parseProposal({ version: 1 }, ids(), CATALOG).errors[0]?.message).toContain(
      '`operations` must be an array'
    );
  });

  it('accepts an empty proposal as a no-op', () => {
    const parsed = parse([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.resolved).toEqual([]);
  });

  it('carries the rationale through', () => {
    expect(parse([], 'Because.').proposal.rationale).toBe('Because.');
  });

  it('collects every error rather than stopping at the first', () => {
    // An agent repairing one error per round trip converges far more slowly.
    const parsed = parse([
      { op: 'shift', id: 'NOPE-1', days: 1 },
      { op: 'frobnicate', id: 'BEL-0001' },
      { op: 'set_status', id: 'BEL-0001', status: 'invented' }
    ]);
    expect(parsed.errors).toHaveLength(3);
  });
});

describe('parseProposal: references', () => {
  it('resolves a short id, a path and a bare filename alike', () => {
    for (const ref of [
      'BEL-0001',
      'bel-0001',
      'TaskNotes/Tasks/BEL-0001 Something.md',
      'BEL-0001 Something'
    ]) {
      const parsed = parse([{ op: 'shift', id: ref, days: 1 }]);
      expect(parsed.errors).toEqual([]);
      expect(parsed.resolved[0]?.path).toBe('TaskNotes/Tasks/BEL-0001 Something.md');
    }
  });

  it('suggests near misses for an id that does not exist', () => {
    // A typo'd reference is the likeliest failure in a generated proposal, and an
    // error naming the near misses is repairable in one step.
    const parsed = parse([{ op: 'shift', id: 'BEL-0009', days: 1 }]);
    expect(parsed.errors[0]?.hint).toContain('BEL-000');
  });

  it('suggests from the same family before anything else', () => {
    expect(suggestIds('BEL-0009', ids())).toEqual(['BEL-0001', 'BEL-0002', 'BEL-0003']);
  });

  it('refuses a task depending on itself', () => {
    const parsed = parse([
      { op: 'add_dependency', id: 'BEL-0001', blockedBy: 'BEL-0001' }
    ]);
    expect(parsed.errors[0]?.message).toContain('cannot depend on itself');
  });
});

describe('parseProposal: per-operation validation', () => {
  it('rejects a date it cannot read, and says what it wants', () => {
    const parsed = parse([{ op: 'set_dates', id: 'BEL-0001', due: 'next tuesday' }]);
    expect(parsed.errors[0]?.message).toContain('not a date');
    expect(parsed.errors[0]?.hint).toContain('YYYY-MM-DD');
  });

  it('accepts null as an explicit clear', () => {
    expect(parse([{ op: 'set_dates', id: 'BEL-0001', due: null }]).errors).toEqual([]);
  });

  it('rejects set_dates that names neither date', () => {
    expect(parse([{ op: 'set_dates', id: 'BEL-0001' }]).errors[0]?.message).toContain(
      'changes nothing'
    );
  });

  it('rejects a fractional or zero shift', () => {
    expect(parse([{ op: 'shift', id: 'BEL-0001', days: 1.5 }]).errors).toHaveLength(1);
    expect(parse([{ op: 'shift', id: 'BEL-0001', days: 0 }]).errors).toHaveLength(1);
  });

  it('rejects a status this vault does not define, and lists the real ones', () => {
    const parsed = parse([{ op: 'set_status', id: 'BEL-0001', status: 'in progress' }]);
    expect(parsed.errors[0]?.hint).toContain('in-progress');
  });

  it('rejects an unknown dependency type', () => {
    const parsed = parse([
      { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001', type: 'AFTER' }
    ]);
    expect(parsed.errors[0]?.hint).toContain('FINISHTOSTART');
  });

  it('rejects a lag that is not a duration', () => {
    const parsed = parse([
      { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001', lag: '4 hours' }
    ]);
    expect(parsed.errors[0]?.hint).toContain('PT4H');
  });

  it('accepts a well-formed dependency with a type and a lag', () => {
    const parsed = parse([
      {
        op: 'add_dependency',
        id: 'BEL-0002',
        blockedBy: 'BEL-0001',
        type: 'STARTTOSTART',
        lag: 'PT4H'
      }
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it('refuses a set_field name that is not a plain property name', () => {
    // `x\nstatus` would reach the file as two keys, the second one `status: done`.
    for (const field of ['x\nstatus', 'a: b', '- x', 'has space', '']) {
      const parsed = parse([{ op: 'set_field', id: 'BEL-0001', field, value: 'v' }]);
      expect(parsed.errors).toHaveLength(1);
    }
  });

  it('refuses set_field on a field TaskNotes owns', () => {
    // Each has a dedicated operation that validates its value; set_field would skip it.
    for (const field of ['status', 'scheduled', 'due', 'blockedBy', 'tags', 'timeEstimate']) {
      const parsed = parse([{ op: 'set_field', id: 'BEL-0001', field, value: 'x' }]);
      expect(parsed.errors[0]?.message).toContain('managed by TaskNotes');
    }
  });

  it('refuses a set_field value spanning lines', () => {
    const parsed = parse([
      { op: 'set_field', id: 'BEL-0001', field: 'note', value: 'a\n---\nb' }
    ]);
    expect(parsed.errors[0]?.message).toContain('single line');
  });

  it('accepts a well-formed set_field', () => {
    const parsed = parse([
      { op: 'set_field', id: 'BEL-0001', field: 'initiative', value: 'Health' }
    ]);
    expect(parsed.errors).toEqual([]);
  });

  it('accepts a zero estimate, which marks a milestone', () => {
    expect(parse([{ op: 'set_estimate', id: 'BEL-0001', minutes: 0 }]).errors).toEqual([]);
    expect(parse([{ op: 'set_estimate', id: 'BEL-0001', minutes: -5 }]).errors).toHaveLength(1);
  });
});

describe('simulate', () => {
  it('applies dates without touching the originals', () => {
    const parsed = parse([
      { op: 'set_dates', id: 'BEL-0001', scheduled: '2026-05-01', due: '2026-05-04' }
    ]);
    const result = simulate(TASKS, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(result.tasks[0]?.scheduled?.raw).toBe('2026-05-01');
    // The caller's array is the live vault state; mutating it would be a disaster.
    expect(TASKS[0]?.scheduled?.raw).toBe('2026-04-13');
  });

  it('shifts by whole days, matching what a drag on the chart does', () => {
    const parsed = parse([{ op: 'shift', id: 'BEL-0001', days: 3 }]);
    const result = simulate(TASKS, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    const moved = result.tasks.find((t) => t.path.includes('BEL-0001'));
    expect(moved?.scheduled?.raw).toBe('2026-04-16');
    expect(moved?.due?.raw).toBe('2026-04-17');
  });

  it('materializes an inferred date when shifting a task that lacks one', () => {
    const dueOnly = [makeTask({
      path: 'TaskNotes/Tasks/BOA-0002 x.md',
      title: 'BOA-0002',
      due: parseTaskDate('2026-08-21'),
      timeEstimate: 120
    })];
    const map = buildIdMap(dueOnly);
    const parsed = parseProposal(
      { version: 1, operations: [{ op: 'shift', id: 'BOA-0002', days: 2 }] },
      map,
      CATALOG
    );
    const result = simulate(dueOnly, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(result.tasks[0]?.scheduled).not.toBeNull();
  });

  it('recomputes completion when the status changes', () => {
    // `completed` comes from the catalog's isCompleted flag, never the literal string;
    // leaving it stale would keep a finished task counting as outstanding work.
    const parsed = parse([{ op: 'set_status', id: 'BEL-0001', status: 'done' }]);
    const result = simulate(TASKS, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(result.tasks[0]?.completed).toBe(true);
  });

  it('rejects a set_dates that inverts the task', () => {
    const parsed = parse([
      { op: 'set_dates', id: 'BEL-0001', scheduled: '2026-05-01', due: '2026-04-01' }
    ]);
    const result = simulate(TASKS, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(result.errors[0]?.message).toContain('falls before the start');
    expect(result.touched.size).toBe(0);
  });

  it('says so when a dependency being removed is not there', () => {
    const parsed = parse([
      { op: 'remove_dependency', id: 'BEL-0001', blockedBy: 'BEL-0002' }
    ]);
    const result = simulate(TASKS, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    expect(result.errors[0]?.hint).toContain('no dependencies at all');
  });

  it('updates rather than duplicates a dependency that already exists', () => {
    const withDep = [
      TASKS[0]!,
      {
        ...TASKS[1]!,
        dependencies: [
          { uid: 'x', path: TASKS[0]!.path, reltype: 'FINISHTOSTART' as const }
        ]
      }
    ];
    const map = buildIdMap(withDep);
    const parsed = parseProposal(
      {
        version: 1,
        operations: [
          { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001', type: 'STARTTOSTART' }
        ]
      },
      map,
      CATALOG
    );
    const result = simulate(withDep, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
    const target = result.tasks.find((t) => t.path.includes('BEL-0002'));
    expect(target?.dependencies).toHaveLength(1);
    expect(target?.dependencies[0]?.reltype).toBe('STARTTOSTART');
  });
});

describe('validation report', () => {
  it('approves a change that breaks nothing', () => {
    const report = validate([{ op: 'shift', id: 'BEL-0003', days: 1 }]);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('blocks a change that would create a cycle', () => {
    // A cycle is an error rather than a trade-off: the plan could not be scheduled.
    const chain = [
      TASKS[0]!,
      {
        ...TASKS[1]!,
        dependencies: [
          { uid: 'x', path: TASKS[0]!.path, reltype: 'FINISHTOSTART' as const }
        ]
      }
    ];
    const report = validate(
      [{ op: 'add_dependency', id: 'BEL-0001', blockedBy: 'BEL-0002' }],
      chain
    );
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes('circular'))).toBe(true);
  });

  it('marks a cycle error as one, so a caller can single it out', () => {
    // `apply` lets a person accept exactly this error and no other: undoing a change
    // that broke a loop necessarily puts the loop back, so an undo file would
    // otherwise be permanently unapplicable.
    const chain = [
      TASKS[0]!,
      {
        ...TASKS[1]!,
        dependencies: [
          { uid: 'x', path: TASKS[0]!.path, reltype: 'FINISHTOSTART' as const }
        ]
      }
    ];
    const report = validate(
      [{ op: 'add_dependency', id: 'BEL-0001', blockedBy: 'BEL-0002' }],
      chain
    );
    expect(report.errors.every((e) => e.kind === 'cycle')).toBe(true);
  });

  it('leaves every other error unmarked', () => {
    const report = validate([{ op: 'shift', id: 'NOPE-1', days: 1 }]);
    expect(report.errors[0]?.kind).toBeUndefined();
  });

  it('reports a conflict it would introduce as a regression, not an error', () => {
    const chain = [
      TASKS[0]!,
      {
        ...TASKS[1]!,
        dependencies: [
          { uid: 'x', path: TASKS[0]!.path, reltype: 'FINISHTOSTART' as const }
        ]
      }
    ];
    // Pulling the successor back before its predecessor finishes is a real plan, just
    // a contradictory one — the agent should be able to weigh it.
    const report = validate([{ op: 'shift', id: 'BEL-0002', days: -3 }], chain);
    expect(report.ok).toBe(true);
    expect(report.regressions.join(' ')).toContain('conflict');
  });

  it('reports a conflict it would resolve as an improvement', () => {
    const conflicted = [
      task('BEL-0001', '2026-04-20', '2026-04-22'),
      {
        ...task('BEL-0002', '2026-04-13', '2026-04-14'),
        dependencies: [
          {
            uid: 'x',
            path: 'TaskNotes/Tasks/BEL-0001 Something.md',
            reltype: 'FINISHTOSTART' as const
          }
        ]
      }
    ];
    const report = validate([{ op: 'shift', id: 'BEL-0002', days: 10 }], conflicted);
    expect(report.improvements.join(' ')).toContain('Resolves 1 dependency conflict');
    expect(report.summary.conflicts).toEqual({ before: 1, after: 0 });
  });

  it('lists the fields each task would change', () => {
    const report = validate([{ op: 'shift', id: 'BEL-0001', days: 2 }]);
    const change = report.changes.find((c) => c.id === 'BEL-0001');
    expect(change?.fields.map((f) => f.field).sort()).toEqual(['end', 'start']);
    expect(change?.fields[0]?.before).not.toBe(change?.fields[0]?.after);
  });

  it('orders errors by operation, so the list reads like the proposal', () => {
    const report = validate([
      { op: 'shift', id: 'NOPE-1', days: 1 },
      { op: 'shift', id: 'BEL-0001', days: 1 },
      { op: 'set_status', id: 'BEL-0002', status: 'invented' }
    ]);
    expect(report.errors.map((e) => e.operation)).toEqual([0, 2]);
  });

  it('says plainly when nothing would change', () => {
    const report = validate([]);
    expect(report.changes).toEqual([]);
    expect(renderReport(report)).toContain('No task would change.');
  });

  it('renders errors under a heading that says nothing has changed', () => {
    const report = validate([{ op: 'shift', id: 'NOPE-1', days: 1 }]);
    const text = renderReport(report);
    expect(text).toContain('cannot be applied');
    expect(text).toContain('Nothing has changed.');
  });
});

describe('property: autofix output validates clean', () => {
  /**
   * The loop that has to close: the chart's own repair, fed through the agent's
   * validator, must leave nothing to repair. If these two disagree the plugin is
   * telling a human one thing and an agent another about the same vault.
   */
  it('turns every conflict into none', () => {
    const chain: GanttTask[] = [
      task('BEL-0001', '2026-04-20', '2026-04-24'),
      {
        ...task('BEL-0002', '2026-04-13', '2026-04-15'),
        dependencies: [
          {
            uid: 'x',
            path: 'TaskNotes/Tasks/BEL-0001 Something.md',
            reltype: 'FINISHTOSTART' as const
          }
        ]
      },
      {
        ...task('BEL-0003', '2026-04-14', '2026-04-16'),
        dependencies: [
          {
            uid: 'y',
            path: 'TaskNotes/Tasks/BEL-0002 Something.md',
            reltype: 'FINISHTOSTART' as const
          }
        ]
      }
    ];

    const cal = calendarFrom(DEFAULT_SETTINGS);
    const bars = computeBars(chain, {
      calendar: cal,
      dueDateInclusive: DEFAULT_SETTINGS.dueDateInclusive,
      defaultDurationMinutes: DEFAULT_SETTINGS.defaultDurationMinutes,
      todayMs: NOW
    });
    const { edges } = buildEdges(chain);
    const adjacency = buildAdjacency(
      chain.map((t) => t.path),
      edges
    );

    const patches = planConflictFixes({
      tasks: new Map(chain.map((t) => [t.path, t])),
      bars,
      adjacency,
      calendar: cal,
      excluded: new Set()
    });
    expect(patches.length).toBeGreaterThan(0);

    // The proposal an agent would have had to write by hand.
    const operations = patches.map(({ patch }) => ({
      op: 'set_dates',
      id: patch.path,
      ...(patch.scheduled === undefined ? {} : { scheduled: patch.scheduled }),
      ...(patch.due === undefined ? {} : { due: patch.due })
    }));

    const report = validate(operations, chain);
    expect(report.ok).toBe(true);
    expect(report.summary.conflicts.before).toBeGreaterThan(0);
    expect(report.summary.conflicts.after).toBe(0);
  });
});
