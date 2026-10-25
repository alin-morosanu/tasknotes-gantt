import type { GanttWriter } from './writer';
import type { TaskNotesBridge } from './tasknotes';
import type { TaskNotesEventPayload, TaskNotesEventRef } from './tasknotes-api';

/**
 * Subscribes to TaskNotes' change events and forwards the ones that matter.
 *
 * The important behaviour here is what it does NOT forward: the echo of a write the
 * Gantt itself just made. Without that filter, a drag writes a file, the file emits
 * an event, the event triggers a re-render, and the bar the user is still holding
 * jumps out from under them.
 */

/** Events that change something the chart draws. */
const WATCHED = [
  'task.created',
  'task.deleted',
  'task.updated',
  'task.moved',
  'task.status.changed',
  'task.completed',
  'task.uncompleted',
  'task.scheduled.changed',
  'task.due.changed',
  'task.priority.changed',
  'task.projects.changed',
  'task.dependencies.changed',
  'task.archived',
  'task.unarchived'
];

export class TaskNotesEvents {
  private refs: TaskNotesEventRef[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private bridge: TaskNotesBridge,
    private writer: GanttWriter,
    private onChange: () => void,
    /** Coalesce bursts — a single API call can emit several events. */
    private debounceMs = 80
  ) {}

  start(): void {
    const api = this.bridge.api;
    if (!api) return;

    for (const name of WATCHED) {
      try {
        this.refs.push(api.events.on(name, (payload) => this.handle(payload)));
      } catch {
        // An event this version does not publish is not worth failing over.
      }
    }

    try {
      this.refs.push(api.lifecycle.on('cache.changed', () => this.schedule()));
    } catch {
      // Optional; the per-task events already cover the common cases.
    }
  }

  private handle(payload: TaskNotesEventPayload): void {
    if (this.writer.isOwnEcho(payload.context?.correlationId, payload.taskPath)) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    const api = this.bridge.api;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!api) {
      this.refs = [];
      return;
    }
    for (const ref of this.refs) {
      try {
        api.events.off(ref);
      } catch {
        // Already gone, or TaskNotes unloaded first.
      }
    }
    this.refs = [];
  }
}
