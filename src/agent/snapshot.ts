import type { Bar, GanttTask, TaskNotesCatalog, TaskPath } from '../types';
import { calendarFrom, type GanttSettings } from '../settings/defaults';
import { computeBars } from '../model/geometry';
import { buildEdges } from '../model/graph';
import { computeSchedule } from '../model/schedule';
import { computeCapacity, resourceValues, UNASSIGNED } from '../model/capacity';
import { withProgress } from '../model/progress';
import { formatTaskDate, startOfDay } from '../model/dates';
import {
  minutesPerDay,
  normalizeCalendar,
  workMinutesBetween,
  type WorkingCalendar
} from '../model/calendar';
import { buildIdMap, idFor, type IdMap } from './ids';

/**
 * The project state, in a form an agent can reason about.
 *
 * Two things separate this from a plain dump of the vault, and both exist because a
 * language model will otherwise reason confidently from a false premise:
 *
 *   - Every date says whether it was AUTHORED or INFERRED. Twenty-three tasks in the
 *     reference vault have a due date and no start; the chart works one out. A
 *     snapshot that presents that guess as a plan invites the model to protect a date
 *     nobody chose.
 *   - What is NOT known is stated. Tasks with no estimate contribute nothing to
 *     capacity, links dangle, cycles are excluded from scheduling. An agent told the
 *     totals are incomplete reasons differently from one handed a confident number.
 */

export type DateOrigin = 'authored' | 'inferred';

export interface SnapshotDate {
  date: string;
  origin: DateOrigin;
}

export interface SnapshotDependency {
  /** Short id of the blocking task, or the raw link when it does not resolve. */
  blockedBy: string;
  type: string;
  /** Lag in working minutes; negative is a lead. Omitted when zero. */
  lagMinutes?: number;
  /** True when the link points at nothing in this vault. */
  unresolved?: boolean;
}

export interface SnapshotTask {
  id: string;
  path: TaskPath;
  title: string;
  status: string;
  /** Whether this status counts as complete, so the agent need not guess. */
  done: boolean;
  priority: string;
  start: SnapshotDate;
  end: SnapshotDate;
  /** Working days the bar spans. */
  durationDays: number;
  estimateMinutes: number | null;
  milestone?: boolean;
  projects: string[];
  contexts: string[];
  assignee?: string;
  /** User-defined TaskNotes fields, e.g. `initiative`. */
  fields: Record<string, string>;
  /** Ratio in [0,1], or null when nothing recorded knows. */
  progress: number | null;
  dependencies: SnapshotDependency[];
  /** Working days of slack. Null for a task excluded from scheduling. */
  floatDays: number | null;
  critical: boolean;
}

export interface SnapshotConflict {
  task: string;
  blockedBy: string;
  type: string;
  /** Working days by which the task starts too early. */
  overlapDays: number;
  message: string;
}

export interface SnapshotResourceDay {
  date: string;
  hours: number;
  capacityHours: number;
}

export interface SnapshotResource {
  name: string;
  taskCount: number;
  totalHours: number;
  capacityHoursPerDay: number | null;
  overloadedDays: number;
  /** Only the days that exceed capacity, so the list stays short. */
  overloads: SnapshotResourceDay[];
  /** Tasks in this lane with no estimate, which contribute nothing to the totals. */
  unestimatedCount: number;
}

export interface SnapshotUnknowns {
  tasksWithoutEstimate: number;
  tasksWithoutDates: number;
  tasksWithInferredDates: number;
  danglingDependencies: { task: string; link: string }[];
  danglingProjects: { project: string; taskCount: number }[];
  /** Tasks in a cycle have no earliest start, so they carry no float or criticality. */
  excludedFromScheduling: string[];
}

export interface AgentSnapshot {
  generatedAt: string;
  vault: string;
  scope: { description: string; taskCount: number; totalInVault: number };
  calendar: {
    workdays: string[];
    dayStart: string;
    dayEnd: string;
    hoursPerDay: number;
    holidays: string[];
    dueDateInclusive: boolean;
  };
  vocabulary: {
    statuses: { value: string; label: string; done: boolean }[];
    priorities: { value: string; label: string; weight: number }[];
    userFields: string[];
  };
  timeline: { start: string | null; end: string | null };
  problems: {
    conflicts: SnapshotConflict[];
    cycles: string[][];
  };
  unknowns: SnapshotUnknowns;
  criticalPath: string[];
  resources: SnapshotResource[];
  tasks: SnapshotTask[];
}

export interface SnapshotInput {
  vaultPath: string;
  /** Tasks in scope. Filtering happens before this. */
  tasks: GanttTask[];
  /** Total in the vault, so the snapshot can say how much it is not showing. */
  totalInVault: number;
  scopeDescription: string;
  catalog: TaskNotesCatalog;
  settings: GanttSettings;
  now?: number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function timeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dateOf(ms: number): string {
  return formatTaskDate(startOfDay(ms), true);
}

function snapshotDate(authored: { ms: number } | null, fallbackMs: number): SnapshotDate {
  return authored === null
    ? { date: dateOf(fallbackMs), origin: 'inferred' }
    : { date: dateOf(authored.ms), origin: 'authored' };
}

/** Build the snapshot. Pure: every input is supplied, nothing is read from the app. */
export function buildSnapshot(input: SnapshotInput): AgentSnapshot {
  const { catalog, settings } = input;
  const now = input.now ?? Date.now();
  const cal = normalizeCalendar(calendarFrom(settings));
  const perDay = minutesPerDay(cal);

  const tasks = withProgress(input.tasks, catalog.statuses, settings.progressOrder);
  const ids = buildIdMap(tasks);
  const ref = (path: TaskPath) => idFor(path, ids);

  const bars = computeBars(tasks, {
    calendar: cal,
    dueDateInclusive: settings.dueDateInclusive,
    defaultDurationMinutes: settings.defaultDurationMinutes,
    todayMs: now
  });

  const { edges, dangling } = buildEdges(tasks);
  const schedule = computeSchedule({
    bars,
    edges,
    calendar: cal,
    labelFor: (path) => tasks.find((t) => t.path === path)?.title ?? path
  });

  const capacity = computeCapacity(tasks, bars, {
    calendar: cal,
    resourceField: settings.resourceField,
    defaultCapacityMinutes: settings.defaultCapacityMinutesPerDay,
    capacityOverrides: settings.capacityOverrides,
    includeCompleted: false
  });

  const excluded = new Set<TaskPath>();
  for (const cycle of schedule.cycles) for (const m of cycle.members) excluded.add(m);

  const snapshotTasks = buildTaskList(tasks, bars, schedule, ids, cal, perDay, settings, catalog);
  const timeline = timelineOf(bars);

  return {
    generatedAt: new Date(now).toISOString(),
    vault: input.vaultPath,
    scope: {
      description: input.scopeDescription,
      taskCount: tasks.length,
      totalInVault: input.totalInVault
    },
    calendar: {
      workdays: DAY_NAMES.filter((_, i) => cal.workdays[i] === true),
      dayStart: timeOfDay(cal.dayStartMinutes),
      dayEnd: timeOfDay(cal.dayEndMinutes),
      hoursPerDay: perDay / 60,
      holidays: [...cal.holidays],
      dueDateInclusive: settings.dueDateInclusive
    },
    vocabulary: {
      statuses: catalog.statuses.map((s) => ({
        value: s.value,
        label: s.label,
        done: s.isCompleted
      })),
      priorities: catalog.priorities.map((p) => ({
        value: p.value,
        label: p.label,
        weight: p.weight
      })),
      userFields: catalog.userFields.map((f) => f.key)
    },
    timeline,
    problems: {
      conflicts: schedule.violations.map((v) => ({
        task: ref(v.edge.to),
        blockedBy: ref(v.edge.from),
        type: v.edge.reltype,
        overlapDays: round(v.overlapMinutes / perDay),
        message: v.message
      })),
      cycles: schedule.cycles.map((c) => c.members.map(ref))
    },
    unknowns: {
      tasksWithoutEstimate: tasks.filter((t) => t.timeEstimate === null).length,
      tasksWithoutDates: tasks.filter((t) => t.scheduled === null && t.due === null).length,
      tasksWithInferredDates: tasks.filter((t) => t.scheduled === null || t.due === null).length,
      danglingDependencies: dangling.map((d) => ({ task: ref(d.from), link: d.uid })),
      danglingProjects: danglingProjects(tasks),
      excludedFromScheduling: [...excluded].map(ref)
    },
    criticalPath: criticalChain(snapshotTasks),
    resources: buildResources(capacity),
    tasks: snapshotTasks
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function timelineOf(bars: ReadonlyMap<TaskPath, Bar>): { start: string | null; end: string | null } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const bar of bars.values()) {
    if (bar.displayStartMs < min) min = bar.displayStartMs;
    if (bar.displayEndMs > max) max = bar.displayEndMs;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { start: null, end: null };
  // The drawn end is exclusive, so step back inside it for a date a person would say.
  return { start: dateOf(min), end: dateOf(max - 1) };
}

function danglingProjects(tasks: readonly GanttTask[]): { project: string; taskCount: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const ref of task.projects) {
      if (ref.path !== null) continue;
      counts.set(ref.target, (counts.get(ref.target) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([project, taskCount]) => ({ project, taskCount }));
}

function buildTaskList(
  tasks: readonly GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  schedule: ReturnType<typeof computeSchedule>,
  ids: IdMap,
  cal: WorkingCalendar,
  perDay: number,
  settings: GanttSettings,
  catalog: TaskNotesCatalog
): SnapshotTask[] {
  const ref = (path: TaskPath) => idFor(path, ids);
  const known = new Set(tasks.map((t) => t.path));
  const userFieldKeys = catalog.userFields.map((f) => f.key);

  return tasks
    .map((task): SnapshotTask => {
      const bar = bars.get(task.path);
      const node = schedule.nodes.get(task.path);

      const fields: Record<string, string> = {};
      for (const key of userFieldKeys) {
        const value = task.extra[key];
        if (typeof value === 'string' && value.trim() !== '') fields[key] = value.trim();
      }

      const assignee = resourceValues(task, settings.resourceField).filter(
        (v) => v !== UNASSIGNED
      );

      const entry: SnapshotTask = {
        id: ref(task.path),
        path: task.path,
        title: task.title,
        status: task.status,
        done: task.completed,
        priority: task.priority,
        start: snapshotDate(task.scheduled, bar?.startMs ?? 0),
        end: snapshotDate(task.due, bar?.endMs ?? 0),
        // Working days, which is what the field claims. Elapsed time divided by the
        // length of a working day says a Saturday-to-Monday task takes seven of them.
        durationDays: bar
          ? round(workMinutesBetween(cal, bar.startMs, bar.endMs) / perDay)
          : 0,
        estimateMinutes: task.timeEstimate,
        projects: task.projects.map((p) => p.alias ?? p.target),
        contexts: task.contexts,
        fields,
        progress: task.progress,
        dependencies: task.dependencies.map((dep): SnapshotDependency => {
          const entry: SnapshotDependency = {
            blockedBy: dep.path !== null && known.has(dep.path) ? ref(dep.path) : dep.uid,
            type: dep.reltype
          };
          if (dep.path === null || !known.has(dep.path)) entry.unresolved = true;
          return entry;
        }),
        floatDays: node ? round(node.totalFloat / perDay) : null,
        critical: node?.critical ?? false
      };

      if (bar?.kind === 'milestone') entry.milestone = true;
      if (assignee.length > 0) entry.assignee = assignee.join(', ');
      return entry;
    })
    .sort((a, b) => a.start.date.localeCompare(b.start.date) || a.id.localeCompare(b.id));
}

/**
 * The critical tasks, in date order.
 *
 * Presented as a chain rather than a set because that is how it is acted on: the
 * sequence is what determines the end date.
 */
function criticalChain(tasks: readonly SnapshotTask[]): string[] {
  return tasks.filter((t) => t.critical).map((t) => t.id);
}

function buildResources(
  capacity: ReturnType<typeof computeCapacity>
): SnapshotResource[] {
  const resources: SnapshotResource[] = [];

  for (const lane of capacity.resources.values()) {
    const overloads: SnapshotResourceDay[] = [];
    if (!lane.unlimited) {
      for (const day of lane.days.values()) {
        if (day.over <= 0.5) continue;
        overloads.push({
          date: dateOf(day.dayMs),
          hours: round(day.minutes / 60),
          capacityHours: round(day.capacity / 60)
        });
      }
      overloads.sort((a, b) => a.date.localeCompare(b.date));
    }

    resources.push({
      name: lane.label,
      taskCount: lane.taskCount,
      totalHours: round(lane.totalMinutes / 60),
      capacityHoursPerDay: lane.unlimited ? null : round(lane.capacity / 60),
      overloadedDays: lane.overloadedDays,
      overloads,
      unestimatedCount: lane.unestimatedCount
    });
  }

  return resources.sort((a, b) => b.totalHours - a.totalHours);
}
