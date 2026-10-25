import type { Bar, GanttTask, TaskPath } from '../types';
import { boundsOf } from '../model/geometry';
import { resourceValuesOf } from '../model/resource';

/**
 * Turns tasks into an ordered list of rows, then answers which of those rows a given
 * scroll position needs. Pure: no DOM, no canvas, no Obsidian.
 */

export type RowKind = 'group' | 'task' | 'capacity';

export interface Row {
  kind: RowKind;
  /** Stable identity: a task path, or `group:<key>`. */
  id: string;
  label: string;
  /** Indentation depth, 0 for top-level. */
  depth: number;
  /** Present on task rows. */
  task?: GanttTask;
  /** Present on task rows that have a bar, and on group rows with a rollup span. */
  bar?: Bar;
  /** Group rows only: how many task rows they contain. */
  count?: number;
  /** Capacity rows only: the tasks whose load the histogram shows. */
  members?: GanttTask[];
  /** Group rows only: true when the group's project link resolved to nothing. */
  unresolved?: boolean;
  /** Group rows only: false when the group has been switched off. */
  visible?: boolean;
  /**
   * Task rows only: this task also appears under another group, because it lists
   * several projects or contexts. Marked so the repetition reads as one task shown
   * twice rather than as two tasks.
   */
  alsoElsewhere?: boolean;
  collapsed?: boolean;
}

export type GroupBy = 'project' | 'status' | 'priority' | 'context' | 'assignee' | 'none';

export interface LayoutOptions {
  groupBy: GroupBy;
  /** Frontmatter property backing the resource grouping. */
  resourceField: string;
  collapsed: ReadonlySet<string>;
  /**
   * Groups switched off by their checkbox.
   *
   * Their header row stays, greyed and unchecked, so the group can be switched back
   * on from the chart. A group that vanished entirely would be unreachable.
   */
  hidden: ReadonlySet<string>;
  /** Tasks whose status is flagged completed are hidden when false. */
  showCompleted: boolean;
  showArchived: boolean;
  /** Add a load histogram row beneath each group header. */
  showCapacity: boolean;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  groupBy: 'project',
  resourceField: 'assignee',
  collapsed: new Set(),
  hidden: new Set(),
  showCompleted: true,
  showArchived: false,
  showCapacity: false
};

/** Sentinel for the catch-all group. Leading space, for the reason in `NO_VALUE`. */
const UNGROUPED = ' ungrouped';

/** Human label for the catch-all bucket in each grouping mode. */
function ungroupedLabel(groupBy: GroupBy): string {
  switch (groupBy) {
    case 'project':
      return 'No project';
    case 'context':
      return 'No context';
    case 'assignee':
      return 'Unassigned';
    case 'status':
      return 'No status';
    case 'priority':
      return 'No priority';
    case 'none':
      return 'All tasks';
  }
}

interface GroupKey {
  key: string;
  label: string;
  unresolved: boolean;
}

/**
 * The groups a task belongs to.
 *
 * A task can appear in several: it may list two projects, or carry two contexts. It
 * is deliberately shown under each rather than arbitrarily assigned to the first,
 * because a task that serves two projects is genuinely part of both plans.
 */
function groupsFor(task: GanttTask, options: LayoutOptions): GroupKey[] {
  const single = (value: string | undefined, label?: string): GroupKey[] =>
    value === undefined || value === ''
      ? [{ key: UNGROUPED, label: ungroupedLabel(options.groupBy), unresolved: false }]
      : [{ key: value, label: label ?? value, unresolved: false }];

  switch (options.groupBy) {
    case 'none':
      return [{ key: UNGROUPED, label: ungroupedLabel('none'), unresolved: false }];

    case 'project': {
      if (task.projects.length === 0) {
        return [{ key: UNGROUPED, label: ungroupedLabel('project'), unresolved: false }];
      }
      // A dangling link still forms a group: 23 tasks in the reference vault point at
      // project notes that do not exist, and dropping them would hide real work.
      return task.projects.map((ref) => ({
        key: ref.path ?? `unresolved:${ref.target}`,
        label: ref.alias ?? displayName(ref.path ?? ref.target),
        unresolved: ref.path === null
      }));
    }

    case 'context': {
      if (task.contexts.length === 0) {
        return [{ key: UNGROUPED, label: ungroupedLabel('context'), unresolved: false }];
      }
      return task.contexts.map((c) => ({ key: c, label: c, unresolved: false }));
    }

    case 'assignee': {
      // The same reader capacity and the filter use, so picking `contexts` groups by
      // context instead of dropping every task into one ungrouped lump.
      const values = resourceValuesOf(task, options.resourceField);
      if (values.length === 0) {
        return [{ key: UNGROUPED, label: ungroupedLabel('assignee'), unresolved: false }];
      }
      return values.map((v) => ({ key: v, label: v, unresolved: false }));
    }

    case 'status':
      return single(task.status || undefined);

    case 'priority':
      return single(task.priority || undefined);
  }
}

function displayName(pathOrTarget: string): string {
  const file = pathOrTarget.slice(pathOrTarget.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}

export interface BuildRowsResult {
  rows: Row[];
  /** Tasks with no bar at all, shown in the unscheduled rail rather than the chart. */
  unscheduled: GanttTask[];
}

/**
 * Build the ordered row list.
 *
 * Group rows carry a rollup bar spanning their members, which is what gives project
 * notes the summary timeline they currently only have as hand-drawn ASCII.
 */
export function buildRows(
  tasks: GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: LayoutOptions,
  compare: (a: GanttTask, b: GanttTask) => number
): BuildRowsResult {
  const visible = tasks.filter(
    (t) => (options.showCompleted || !t.completed) && (options.showArchived || !t.archived)
  );

  const buckets = new Map<string, { label: string; unresolved: boolean; tasks: GanttTask[] }>();
  const groupCounts = new Map<TaskPath, number>();
  for (const task of visible) {
    const groups = groupsFor(task, options);
    groupCounts.set(task.path, groups.length);
    for (const group of groups) {
      let bucket = buckets.get(group.key);
      if (!bucket) {
        bucket = { label: group.label, unresolved: group.unresolved, tasks: [] };
        buckets.set(group.key, bucket);
      }
      bucket.tasks.push(task);
    }
  }

  // Ungrouped sorts last so the catch-all does not lead the chart.
  const ordered = [...buckets.entries()].sort(([a, ba], [b, bb]) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return ba.label.localeCompare(bb.label);
  });

  const rows: Row[] = [];
  const flat = options.groupBy === 'none';

  for (const [key, bucket] of ordered) {
    const groupId = `group:${key}`;
    const collapsed = options.collapsed.has(groupId);
    const members = [...bucket.tasks].sort(compare);
    const memberBars = members
      .map((t) => bars.get(t.path))
      .filter((b): b is Bar => b !== undefined);

    const hidden = options.hidden.has(groupId);

    if (!flat) {
      const span = boundsOf(memberBars, 0);
      const row: Row = {
        kind: 'group',
        id: groupId,
        label: bucket.label,
        depth: 0,
        count: members.length,
        collapsed,
        unresolved: bucket.unresolved,
        visible: !hidden
      };
      if (span && !hidden) {
        row.bar = {
          path: groupId,
          startMs: span.startMs,
          endMs: span.endMs,
          displayStartMs: span.startMs,
          displayEndMs: span.endMs,
          kind: 'planned'
        };
      }
      rows.push(row);
      if (collapsed || hidden) continue;

      // A load histogram for this group's members. Under an assignee grouping this is
      // resource capacity; under a project grouping it is the project's own load. Both
      // are the same question asked of a different slice.
      if (options.showCapacity) {
        rows.push({
          kind: 'capacity',
          id: `capacity:${key}`,
          label: `${bucket.label} load`,
          depth: 1,
          members
        });
      }
    }

    if (flat && hidden) continue;

    for (const task of members) {
      const row: Row = {
        kind: 'task',
        id: task.path,
        label: task.title,
        depth: flat ? 0 : 1,
        task
      };
      if ((groupCounts.get(task.path) ?? 0) > 1) row.alsoElsewhere = true;
      const bar = bars.get(task.path);
      if (bar) row.bar = bar;
      rows.push(row);
    }
  }

  return { rows, unscheduled: [] };
}

export interface Viewport {
  scrollTop: number;
  height: number;
  rowHeight: number;
}

export interface VisibleRows {
  /** Index of the first row to draw. */
  start: number;
  /** Index one past the last row to draw. */
  end: number;
  /** Pixel offset of row `start` from the top of the content. */
  offsetY: number;
  totalHeight: number;
}

/**
 * Which rows intersect the viewport.
 *
 * Two rows of overscan on each side keep a fast scroll from showing gaps, and mean
 * only ~40 rows are ever painted regardless of how many thousands exist.
 */
export function visibleRows(rowCount: number, viewport: Viewport, overscan = 2): VisibleRows {
  const { scrollTop, height, rowHeight } = viewport;
  const safeRowHeight = rowHeight > 0 ? rowHeight : 1;
  const first = Math.max(0, Math.floor(scrollTop / safeRowHeight) - overscan);
  const visibleCount = Math.ceil(height / safeRowHeight) + overscan * 2;
  const last = Math.min(rowCount, first + visibleCount);
  return {
    start: first,
    end: last,
    offsetY: first * safeRowHeight,
    totalHeight: rowCount * safeRowHeight
  };
}

/** Sort comparators for the task rows inside a group. */
export type SortKey = 'manual' | 'start' | 'due' | 'title' | 'priority' | 'status';

export function makeComparator(
  key: SortKey,
  bars: ReadonlyMap<TaskPath, Bar>,
  priorityWeight: (value: string) => number,
  statusOrder: (value: string) => number
): (a: GanttTask, b: GanttTask) => number {
  const byTitle = (a: GanttTask, b: GanttTask) => a.title.localeCompare(b.title);

  switch (key) {
    case 'manual':
      // TaskNotes' LexoRank keys sort as plain strings; tasks without one fall to the
      // end so the user's explicit ordering always leads.
      return (a, b) => {
        const av = a.sortOrder;
        const bv = b.sortOrder;
        if (av !== null && bv !== null) return av.localeCompare(bv) || byTitle(a, b);
        if (av !== null) return -1;
        if (bv !== null) return 1;
        return byTitle(a, b);
      };
    case 'start':
      return (a, b) =>
        (bars.get(a.path)?.startMs ?? Infinity) - (bars.get(b.path)?.startMs ?? Infinity) ||
        byTitle(a, b);
    case 'due':
      return (a, b) => (a.due?.ms ?? Infinity) - (b.due?.ms ?? Infinity) || byTitle(a, b);
    case 'priority':
      return (a, b) => priorityWeight(b.priority) - priorityWeight(a.priority) || byTitle(a, b);
    case 'status':
      return (a, b) => statusOrder(a.status) - statusOrder(b.status) || byTitle(a, b);
    case 'title':
      return byTitle;
  }
}
