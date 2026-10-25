import type { GanttTask, StatusDef } from '../types';

/**
 * How far along a task is, as a ratio in [0, 1].
 *
 * There is no single right answer, so the sources are tried in a configurable order
 * and the first one that can answer wins. What matters is that a source only speaks
 * when it actually knows: a task with no checklist and no tracked time returns null
 * rather than 0, because "nothing recorded" is not the same as "no work done".
 */

export type ProgressSource = 'status' | 'checklist' | 'tracked' | 'statusOrder';

export const PROGRESS_SOURCES: readonly ProgressSource[] = [
  'status',
  'checklist',
  'tracked',
  'statusOrder'
];

/**
 * Default order, chosen for the reference vault: `timeEntries` is unused there and
 * only 3 of 12 completed tasks carry a `completedDate`, but 122 of 167 tasks have
 * body checkboxes. Checklists are the signal that actually exists.
 */
export const DEFAULT_PROGRESS_ORDER: ProgressSource[] = [
  'status',
  'checklist',
  'tracked',
  'statusOrder'
];

export interface ProgressResult {
  ratio: number;
  source: ProgressSource;
}

function fromStatus(task: GanttTask): ProgressResult | null {
  return task.completed ? { ratio: 1, source: 'status' } : null;
}

function fromChecklist(task: GanttTask): ProgressResult | null {
  const checklist = task.checklist;
  if (!checklist || checklist.total === 0) return null;
  return { ratio: checklist.done / checklist.total, source: 'checklist' };
}

function fromTracked(task: GanttTask): ProgressResult | null {
  const tracked = task.trackedMinutes;
  const estimate = task.timeEstimate;
  if (tracked === null || estimate === null || estimate <= 0) return null;
  // Tracking past the estimate means the task overran, not that it is more than done.
  return { ratio: Math.min(1, tracked / estimate), source: 'tracked' };
}

/**
 * Position within the status list, as a coarse last resort.
 *
 * Deliberately last and deliberately crude: it infers progress from where a status
 * sits in an ordering the user chose for other reasons. Useful as a rough shading,
 * misleading if trusted.
 */
function fromStatusOrder(task: GanttTask, statuses: readonly StatusDef[]): ProgressResult | null {
  if (statuses.length < 2) return null;
  const index = statuses.findIndex((s) => s.value === task.status);
  if (index < 0) return null;
  const completedIndex = statuses.findIndex((s) => s.isCompleted);
  const span = completedIndex > 0 ? completedIndex : statuses.length - 1;
  if (span <= 0) return null;
  return { ratio: Math.min(1, Math.max(0, index / span)), source: 'statusOrder' };
}

export function resolveProgress(
  task: GanttTask,
  statuses: readonly StatusDef[],
  order: readonly ProgressSource[] = DEFAULT_PROGRESS_ORDER
): ProgressResult | null {
  for (const source of order) {
    let result: ProgressResult | null = null;
    switch (source) {
      case 'status':
        result = fromStatus(task);
        break;
      case 'checklist':
        result = fromChecklist(task);
        break;
      case 'tracked':
        result = fromTracked(task);
        break;
      case 'statusOrder':
        result = fromStatusOrder(task, statuses);
        break;
    }
    if (result !== null) return result;
  }
  return null;
}

/** Apply progress to a list of tasks, returning new objects rather than mutating. */
export function withProgress(
  tasks: readonly GanttTask[],
  statuses: readonly StatusDef[],
  order: readonly ProgressSource[] = DEFAULT_PROGRESS_ORDER
): GanttTask[] {
  return tasks.map((task) => {
    const result = resolveProgress(task, statuses, order);
    return { ...task, progress: result?.ratio ?? null };
  });
}

/** Human label for the source a ratio came from, for tooltips. */
export const PROGRESS_LABELS: Record<ProgressSource, string> = {
  status: 'status is complete',
  checklist: 'checklist items',
  tracked: 'time tracked against the estimate',
  statusOrder: 'position in the status list'
};
