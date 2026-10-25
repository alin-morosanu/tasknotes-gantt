import type { GanttTask, TaskDate, TaskNotesCatalog, TaskPath } from '../types';
import { calendarFrom, type GanttSettings } from '../settings/defaults';
import { computeBars } from '../model/geometry';
import { parseTaskDate } from '../model/dates';
import { planDrag } from '../model/reschedule';
import type { ProposalIssue, ResolvedOperation } from './proposal';

/**
 * Apply a proposal to an in-memory copy of the tasks.
 *
 * Nothing here touches a file. The result feeds the validator, so an agent can be told
 * what a change would do before anything is written — which is the whole point of the
 * loop: a model that can check its own answer converges, one that cannot only guesses.
 */

export interface SimulationResult {
  tasks: GanttTask[];
  /** Operations that could not be applied, with the reason. */
  errors: ProposalIssue[];
  /** Paths the proposal actually changed. */
  touched: Set<TaskPath>;
}

function dateFrom(value: string): TaskDate | null {
  return parseTaskDate(value);
}

export function simulate(
  tasks: readonly GanttTask[],
  operations: readonly ResolvedOperation[],
  settings: GanttSettings,
  catalog: TaskNotesCatalog,
  now = Date.now()
): SimulationResult {
  const cal = calendarFrom(settings);
  const byPath = new Map<TaskPath, GanttTask>(tasks.map((t) => [t.path, { ...t }]));
  const errors: ProposalIssue[] = [];
  const touched = new Set<TaskPath>();

  // Bars from the ORIGINAL state, so a shift measures from where the chart shows the
  // task now rather than from a position an earlier operation moved it to.
  const bars = computeBars([...byPath.values()], {
    calendar: cal,
    dueDateInclusive: settings.dueDateInclusive,
    defaultDurationMinutes: settings.defaultDurationMinutes,
    todayMs: now
  });

  for (const entry of operations) {
    const task = byPath.get(entry.path);
    if (!task) {
      errors.push({ operation: entry.index, message: `Task is no longer in scope.` });
      continue;
    }

    switch (entry.op.op) {
      case 'set_dates': {
        const next = { ...task };
        if (entry.op.scheduled !== undefined) {
          next.scheduled = entry.op.scheduled === null ? null : dateFrom(entry.op.scheduled);
        }
        if (entry.op.due !== undefined) {
          next.due = entry.op.due === null ? null : dateFrom(entry.op.due);
        }
        if (
          next.scheduled !== null &&
          next.due !== null &&
          next.due.ms < next.scheduled.ms
        ) {
          errors.push({
            operation: entry.index,
            message: `Due date ${next.due.raw} falls before the start ${next.scheduled.raw}.`,
            hint: 'Swap them, or set only the one you meant to move.'
          });
          continue;
        }
        byPath.set(entry.path, next);
        touched.add(entry.path);
        break;
      }

      case 'shift': {
        const bar = bars.get(entry.path);
        if (!bar) {
          errors.push({ operation: entry.index, message: 'This task has no position to shift.' });
          continue;
        }
        // The same code a drag on the chart runs, so a shift here and a drag there
        // land in the same place — including materializing an inferred date.
        const planned = planDrag(task, bar, 'move', entry.op.days);
        if (planned === null) {
          errors.push({ operation: entry.index, message: 'Shift would change nothing.' });
          continue;
        }
        const next = { ...task };
        if (planned.patch.scheduled !== undefined) {
          next.scheduled =
            planned.patch.scheduled === null ? null : dateFrom(planned.patch.scheduled);
        }
        if (planned.patch.due !== undefined) {
          next.due = planned.patch.due === null ? null : dateFrom(planned.patch.due);
        }
        byPath.set(entry.path, next);
        touched.add(entry.path);
        break;
      }

      case 'set_estimate': {
        byPath.set(entry.path, { ...task, timeEstimate: entry.op.minutes });
        touched.add(entry.path);
        break;
      }

      case 'add_dependency': {
        if (entry.targetPath === undefined) continue;
        const target = entry.targetPath;
        const already = task.dependencies.some((d) => d.path === target);
        const uid = target.replace(/\.md$/, '');
        const dependency = {
          uid,
          path: target,
          reltype: entry.op.type ?? ('FINISHTOSTART' as const),
          ...(entry.op.lag === undefined ? {} : { gap: entry.op.lag })
        };
        // Replacing rather than appending, so re-stating a dependency with a different
        // type or lag updates it instead of producing two conflicting edges.
        const dependencies = already
          ? task.dependencies.map((d) => (d.path === target ? dependency : d))
          : [...task.dependencies, dependency];
        byPath.set(entry.path, { ...task, dependencies });
        touched.add(entry.path);
        break;
      }

      case 'remove_dependency': {
        if (entry.targetPath === undefined) continue;
        const target = entry.targetPath;
        const dependencies = task.dependencies.filter((d) => d.path !== target);
        if (dependencies.length === task.dependencies.length) {
          errors.push({
            operation: entry.index,
            message: 'That dependency is not on this task.',
            hint:
              task.dependencies.length === 0
                ? 'It has no dependencies at all.'
                : `It waits for: ${task.dependencies.map((d) => d.uid).join(', ')}.`
          });
          continue;
        }
        byPath.set(entry.path, { ...task, dependencies });
        touched.add(entry.path);
        break;
      }

      case 'set_status': {
        // Bound locally: TypeScript drops the narrowing of `entry.op` inside a closure.
        const status = entry.op.status;
        // `completed` is derived from the catalog's isCompleted flag, never from the
        // literal string, so it has to be recomputed here — otherwise a task moved to
        // a done status would still count as outstanding work in every later pass.
        const definition = catalog.statuses.find((s) => s.value === status);
        byPath.set(entry.path, {
          ...task,
          status,
          completed: definition?.isCompleted ?? false
        });
        touched.add(entry.path);
        break;
      }

      case 'set_field': {
        const extra = { ...task.extra };
        if (entry.op.value === null) delete extra[entry.op.field];
        else extra[entry.op.field] = entry.op.value;
        byPath.set(entry.path, { ...task, extra });
        touched.add(entry.path);
        break;
      }
    }
  }

  return { tasks: [...byPath.values()], errors, touched };
}
