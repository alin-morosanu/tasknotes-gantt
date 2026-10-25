import type { GanttTask } from '../../src/types';

/**
 * A task with every field at its empty value, for tests to override selectively.
 *
 * Shared deliberately: each test file used to carry its own copy of this shape, so
 * every addition to `GanttTask` broke five files identically.
 */
export function makeTask(over: Partial<GanttTask> = {}): GanttTask {
  const title = over.title ?? 'T';
  return {
    path: `TaskNotes/Tasks/${title}.md`,
    title,
    status: 'backlog',
    priority: 'normal',
    completed: false,
    archived: false,
    scheduled: null,
    due: null,
    completedDate: null,
    timeEstimate: null,
    trackedMinutes: null,
    projects: [],
    contexts: [],
    tags: [],
    dependencies: [],
    checklist: null,
    progress: null,
    extra: {},
    sortOrder: null,
    ...over
  };
}
