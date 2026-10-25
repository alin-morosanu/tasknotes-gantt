import { describe, expect, it } from 'vitest';
import type { Bar, GanttTask, TaskPath } from '../src/types';
import {
  buildRows,
  DEFAULT_LAYOUT,
  makeComparator,
  visibleRows,
  type LayoutOptions
} from '../src/render/layout';
import { makeTask as task } from './fixtures/build';


const project = (target: string, path: string | null) => ({
  raw: `[[${target}]]`,
  target,
  path
});

const noBars = new Map<TaskPath, Bar>();

/** A planned bar whose drawn extent matches its logical one, for layout tests. */
const bar = (path: string, startMs: number, endMs: number): Bar => ({
  path,
  startMs,
  endMs,
  displayStartMs: startMs,
  displayEndMs: endMs,
  kind: 'planned'
});
const byTitle = (a: GanttTask, b: GanttTask) => a.title.localeCompare(b.title);
const opts = (over: Partial<LayoutOptions> = {}): LayoutOptions => ({ ...DEFAULT_LAYOUT, ...over });

describe('grouping by project', () => {
  it('puts a task under each project it lists', () => {
    const t = task({ title: 'A', projects: [project('P1', 'P1.md'), project('P2', 'P2.md')] });
    const { rows } = buildRows([t], noBars, opts(), byTitle);
    const groups = rows.filter((r) => r.kind === 'group');
    expect(groups.map((g) => g.label)).toEqual(['P1', 'P2']);
    expect(rows.filter((r) => r.kind === 'task')).toHaveLength(2);
  });

  it('keeps tasks whose project link dangles, in a group marked unresolved', () => {
    const t = task({ title: 'A', projects: [project('Side Project', null)] });
    const { rows } = buildRows([t], noBars, opts(), byTitle);
    const group = rows.find((r) => r.kind === 'group');
    expect(group?.label).toBe('Side Project');
    expect(group?.unresolved).toBe(true);
    expect(rows.some((r) => r.kind === 'task')).toBe(true);
  });

  it('separates a dangling link from a resolved one with the same name', () => {
    const rows = buildRows(
      [
        task({ title: 'A', projects: [project('PRJ-06', 'TaskNotes/Projects/PRJ-06.md')] }),
        task({ title: 'B', projects: [project('PRJ-06', null)] })
      ],
      noBars,
      opts(),
      byTitle
    ).rows;
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(2);
  });

  it('collects tasks with no project into a catch-all that sorts last', () => {
    const { rows } = buildRows(
      [task({ title: 'A' }), task({ title: 'B', projects: [project('P1', 'P1.md')] })],
      noBars,
      opts(),
      byTitle
    );
    const groups = rows.filter((r) => r.kind === 'group');
    expect(groups.map((g) => g.label)).toEqual(['P1', 'No project']);
  });

  it('uses the link alias as the group label when one is given', () => {
    const t = task({
      title: 'A',
      projects: [{ raw: '[[P1|Website Relaunch]]', target: 'P1', path: 'P1.md', alias: 'Website Relaunch' }]
    });
    const { rows } = buildRows([t], noBars, opts(), byTitle);
    expect(rows[0]?.label).toBe('Website Relaunch');
  });
});

describe('grouping by other axes', () => {
  it('groups by assignee, including an Unassigned lane', () => {
    const { rows } = buildRows(
      [
        task({ title: 'A', extra: { assignee: 'Avery' } }),
        task({ title: 'B', extra: { assignee: 'Blake' } }),
        task({ title: 'C' })
      ],
      noBars,
      opts({ groupBy: 'assignee' }),
      byTitle
    );
    expect(rows.filter((r) => r.kind === 'group').map((g) => g.label)).toEqual([
      'Avery',
      'Blake',
      'Unassigned'
    ]);
  });

  it('handles a list-valued assignee field', () => {
    const { rows } = buildRows(
      [task({ title: 'A', extra: { assignee: ['Avery', 'Alin'] } })],
      noBars,
      opts({ groupBy: 'assignee' }),
      byTitle
    );
    expect(rows.filter((r) => r.kind === 'group').map((g) => g.label)).toEqual(['Alin', 'Avery']);
  });

  it('respects a renamed assignee field', () => {
    const { rows } = buildRows(
      [task({ title: 'A', extra: { owner: 'Casey' } })],
      noBars,
      opts({ groupBy: 'assignee', resourceField: 'owner' }),
      byTitle
    );
    expect(rows[0]?.label).toBe('Casey');
  });

  it('groups by context, with a task in two contexts appearing twice', () => {
    const { rows } = buildRows(
      [task({ title: 'A', contexts: ['business', 'learning'] })],
      noBars,
      opts({ groupBy: 'context' }),
      byTitle
    );
    expect(rows.filter((r) => r.kind === 'group').map((g) => g.label)).toEqual([
      'business',
      'learning'
    ]);
  });

  it('emits a flat list with no group rows when grouping is off', () => {
    const { rows } = buildRows(
      [task({ title: 'A' }), task({ title: 'B' })],
      noBars,
      opts({ groupBy: 'none' }),
      byTitle
    );
    expect(rows.every((r) => r.kind === 'task')).toBe(true);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });
});

describe('filtering and collapsing', () => {
  it('hides completed tasks when asked', () => {
    const tasks = [task({ title: 'A', completed: true }), task({ title: 'B' })];
    const shown = buildRows(tasks, noBars, opts({ showCompleted: false }), byTitle);
    expect(shown.rows.filter((r) => r.kind === 'task')).toHaveLength(1);
  });

  it('hides archived tasks by default', () => {
    const tasks = [task({ title: 'A', archived: true }), task({ title: 'B' })];
    expect(buildRows(tasks, noBars, opts(), byTitle).rows.filter((r) => r.kind === 'task')).toHaveLength(1);
  });

  it('drops member rows of a collapsed group but keeps its header', () => {
    const t = task({ title: 'A', projects: [project('P1', 'P1.md')] });
    const { rows } = buildRows(
      [t],
      noBars,
      opts({ collapsed: new Set(['group:P1.md']) }),
      byTitle
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.collapsed).toBe(true);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('group rollup bars', () => {
  it('spans the full extent of its members', () => {
    const a = task({ title: 'A', projects: [project('P1', 'P1.md')] });
    const b = task({ title: 'B', projects: [project('P1', 'P1.md')] });
    const bars = new Map<TaskPath, Bar>([
      [a.path, bar(a.path, 100, 200)],
      [b.path, bar(b.path, 150, 500)]
    ]);
    const { rows } = buildRows([a, b], bars, opts(), byTitle);
    const group = rows.find((r) => r.kind === 'group');
    expect(group?.bar?.startMs).toBeLessThanOrEqual(100);
    expect(group?.bar?.endMs).toBeGreaterThanOrEqual(500);
  });

  it('omits the rollup when no member has a bar', () => {
    const a = task({ title: 'A', projects: [project('P1', 'P1.md')] });
    const { rows } = buildRows([a], noBars, opts(), byTitle);
    expect(rows.find((r) => r.kind === 'group')?.bar).toBeUndefined();
  });
});

describe('comparators', () => {
  const weight = (v: string) => ({ high: 3, normal: 2, low: 1 })[v] ?? 0;
  const order = (v: string) => ({ backlog: 0, 'in-progress': 2, done: 4 })[v] ?? 99;

  it('sorts by TaskNotes manual order, with unordered tasks last', () => {
    const cmp = makeComparator('manual', noBars, weight, order);
    const withKey = task({ title: 'A', sortOrder: '0|i00007:' });
    const earlier = task({ title: 'B', sortOrder: '0|hzzzzz:' });
    const none = task({ title: 'C' });
    expect([none, withKey, earlier].sort(cmp).map((t) => t.title)).toEqual(['B', 'A', 'C']);
  });

  it('sorts by priority weight, highest first', () => {
    const cmp = makeComparator('priority', noBars, weight, order);
    const tasks = [
      task({ title: 'low', priority: 'low' }),
      task({ title: 'high', priority: 'high' }),
      task({ title: 'normal', priority: 'normal' })
    ];
    expect(tasks.sort(cmp).map((t) => t.title)).toEqual(['high', 'normal', 'low']);
  });

  it('sorts undated tasks after dated ones when sorting by start', () => {
    const a = task({ title: 'A' });
    const b = task({ title: 'B' });
    const bars = new Map<TaskPath, Bar>([
      [b.path, bar(b.path, 100, 200)]
    ]);
    const cmp = makeComparator('start', bars, weight, order);
    expect([a, b].sort(cmp).map((t) => t.title)).toEqual(['B', 'A']);
  });
});

describe('visibleRows', () => {
  it('returns only the rows intersecting the viewport, plus overscan', () => {
    const slice = visibleRows(1000, { scrollTop: 0, height: 280, rowHeight: 28 });
    expect(slice.start).toBe(0);
    // 10 visible + 2 overscan each side, clamped at the top.
    expect(slice.end).toBeLessThanOrEqual(14);
    expect(slice.totalHeight).toBe(28_000);
  });

  it('scales to thousands of rows without growing the slice', () => {
    const slice = visibleRows(50_000, { scrollTop: 500_000, height: 280, rowHeight: 28 });
    expect(slice.end - slice.start).toBeLessThanOrEqual(15);
  });

  it('clamps at the end of the list', () => {
    const slice = visibleRows(5, { scrollTop: 0, height: 1000, rowHeight: 28 });
    expect(slice.end).toBe(5);
  });

  it('reports the offset of the first drawn row', () => {
    const slice = visibleRows(1000, { scrollTop: 1000, height: 280, rowHeight: 28 });
    expect(slice.offsetY).toBe(slice.start * 28);
  });

  it('survives a zero row height instead of dividing by zero', () => {
    const slice = visibleRows(10, { scrollTop: 0, height: 100, rowHeight: 0 });
    expect(Number.isFinite(slice.start)).toBe(true);
    expect(Number.isFinite(slice.end)).toBe(true);
  });
});
