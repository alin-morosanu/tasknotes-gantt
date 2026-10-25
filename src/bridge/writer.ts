import { Notice } from 'obsidian';
import type { RelType, TaskPath } from '../types';
import type { TaskDatePatch, ReversiblePatch } from '../model/reschedule';
import type { TaskNotesBridge } from './tasknotes';
import type { MutationContext } from './tasknotes-api';

/**
 * Every write the plugin makes goes through here.
 *
 * A single choke point is what makes the guarantees possible: nothing is written in
 * safe mode, large changes are gated on confirmation, every change is reversible, and
 * our own writes can be told apart from the user's when they echo back as events.
 */

export const WRITE_SOURCE = 'tasknotes-gantt';

/** How long an echoed event is still attributed to a write we just made. */
const ECHO_WINDOW_MS = 2500;

/** Concurrent file writes. Enough to be quick, low enough not to stall Obsidian. */
const CONCURRENCY = 4;

export interface UndoEntry {
  label: string;
  patches: TaskDatePatch[];
}

export interface WriteOptions {
  /** Shown in the confirmation dialog and the undo notice. */
  label: string;
  /** Skip the confirmation gate — used when the caller has already confirmed. */
  preconfirmed?: boolean;
  reason?: string;
}

export interface WriteResult {
  written: number;
  failed: { path: TaskPath; error: string }[];
  cancelled: boolean;
}

export interface WriterHost {
  bridge: TaskNotesBridge;
  isSafeMode: () => boolean;
  confirmThreshold: () => number;
  /** Ask the user to approve a change touching many tasks. */
  confirm: (label: string, descriptions: string[]) => Promise<boolean>;
}

export class GanttWriter {
  private undoStack: UndoEntry[] = [];

  /**
   * Correlation ids of writes still in flight, plus the paths they touched.
   *
   * Without this, our own write emits a `task.updated` event, which triggers a
   * re-render, which can restart the interaction — a feedback loop. Paths are tracked
   * as well as ids because a payload is not guaranteed to carry our context back.
   */
  private inFlight = new Set<string>();
  private recentPaths = new Map<TaskPath, number>();

  constructor(private host: WriterHost) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  /** True when an incoming event looks like the echo of a write we just made. */
  isOwnEcho(correlationId: string | undefined, path: string | undefined): boolean {
    if (correlationId !== undefined && this.inFlight.has(correlationId)) return true;
    if (path === undefined) return false;
    const at = this.recentPaths.get(path);
    if (at === undefined) return false;
    if (Date.now() - at > ECHO_WINDOW_MS) {
      this.recentPaths.delete(path);
      return false;
    }
    return true;
  }

  /** Why writing is unavailable, or null when it is available. */
  blockedReason(): string | null {
    if (this.host.isSafeMode()) return 'Safe mode is on — the Gantt is read-only.';
    if (!this.host.bridge.isWritable) return this.host.bridge.status.reason;
    return null;
  }

  /**
   * Apply a set of reversible patches, recording them for undo.
   *
   * Anything touching more than the configured threshold asks first, listing exactly
   * what will change: these are the user's real notes, and a mis-drag that silently
   * rewrote thirty files would be hard to notice and harder to reverse.
   */
  async apply(patches: readonly ReversiblePatch[], options: WriteOptions): Promise<WriteResult> {
    const empty: WriteResult = { written: 0, failed: [], cancelled: false };
    if (patches.length === 0) return empty;

    const blocked = this.blockedReason();
    if (blocked !== null) {
      new Notice(`TaskNotes Gantt: ${blocked}`);
      return { ...empty, cancelled: true };
    }

    if (!options.preconfirmed && patches.length > this.host.confirmThreshold()) {
      const approved = await this.host.confirm(
        options.label,
        patches.map((p) => p.description)
      );
      if (!approved) return { ...empty, cancelled: true };
    }

    const result = await this.write(
      patches.map((p) => p.patch),
      options.reason ?? options.label
    );

    if (result.written > 0) {
      this.undoStack.push({ label: options.label, patches: patches.map((p) => p.inverse) });
      // Bound the journal so a long session cannot grow it without limit.
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    return result;
  }

  /** Revert the most recent change. */
  async undo(): Promise<WriteResult> {
    const entry = this.undoStack.pop();
    if (!entry) return { written: 0, failed: [], cancelled: true };

    const blocked = this.blockedReason();
    if (blocked !== null) {
      // Put it back: the change is still pending, just not undoable right now.
      this.undoStack.push(entry);
      new Notice(`TaskNotes Gantt: ${blocked}`);
      return { written: 0, failed: [], cancelled: true };
    }

    const result = await this.write(entry.patches, `undo ${entry.label}`);
    if (result.written > 0) new Notice(`Undid: ${entry.label}`);
    return result;
  }

  /**
   * Write date patches through the TaskNotes API.
   *
   * The API is used rather than direct frontmatter edits so TaskNotes maintains
   * `dateModified`, respects the user's field mapping, updates its own caches, and
   * emits the events its other views listen to.
   */
  private async write(patches: readonly TaskDatePatch[], reason: string): Promise<WriteResult> {
    const api = this.host.bridge.api;
    if (!api) return { written: 0, failed: [], cancelled: true };

    const correlationId = `${WRITE_SOURCE}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const context: MutationContext = { source: WRITE_SOURCE, correlationId, reason };

    this.inFlight.add(correlationId);
    for (const patch of patches) this.recentPaths.set(patch.path, Date.now());

    const failed: WriteResult['failed'] = [];
    let written = 0;

    const queue = [...patches];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const patch = queue.shift();
        if (!patch) return;
        const fields: Record<string, unknown> = {};
        if (patch.scheduled !== undefined) fields['scheduled'] = patch.scheduled;
        if (patch.due !== undefined) fields['due'] = patch.due;
        if (Object.keys(fields).length === 0) continue;
        try {
          await api.tasks.update(patch.path, fields, context);
          written += 1;
        } catch (error) {
          failed.push({
            path: patch.path,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      // Held briefly past the write so the events it produces are still recognised.
      setTimeout(() => this.inFlight.delete(correlationId), ECHO_WINDOW_MS);
    }

    if (failed.length > 0) {
      new Notice(
        `TaskNotes Gantt: ${failed.length} of ${patches.length} changes failed. ${failed[0]?.error ?? ''}`,
        8000
      );
    }

    return { written, failed, cancelled: false };
  }

  /**
   * Create a dependency edge.
   *
   * The link is written without a `.md` suffix, matching how links are authored
   * everywhere else in a vault and how TaskNotes stores its own.
   */
  async addDependency(
    successor: TaskPath,
    predecessor: TaskPath,
    reltype: RelType
  ): Promise<boolean> {
    const api = this.host.bridge.api;
    const blocked = this.blockedReason();
    if (!api || blocked !== null) {
      if (blocked !== null) new Notice(`TaskNotes Gantt: ${blocked}`);
      return false;
    }

    const correlationId = `${WRITE_SOURCE}-dep-${Date.now()}`;
    this.inFlight.add(correlationId);
    this.recentPaths.set(successor, Date.now());

    try {
      await api.tasks.addDependency(
        successor,
        { uid: predecessor.replace(/\.md$/, ''), reltype },
        { source: WRITE_SOURCE, correlationId, reason: 'link dependency' }
      );
      return true;
    } catch (error) {
      new Notice(
        `TaskNotes Gantt: could not link tasks. ${error instanceof Error ? error.message : String(error)}`,
        8000
      );
      return false;
    } finally {
      setTimeout(() => this.inFlight.delete(correlationId), ECHO_WINDOW_MS);
    }
  }

  /**
   * Remove a dependency.
   *
   * `uid` must be the string TaskNotes stored, not the path it resolves to: its
   * implementation filters `blockedBy` on an exact uid comparison, so a resolved path
   * matches nothing and the call succeeds while changing nothing.
   */
  async removeDependency(successor: TaskPath, uid: string): Promise<boolean> {
    const api = this.host.bridge.api;
    const blocked = this.blockedReason();
    if (!api || blocked !== null) {
      if (blocked !== null) new Notice(`TaskNotes Gantt: ${blocked}`);
      return false;
    }

    const correlationId = `${WRITE_SOURCE}-undep-${Date.now()}`;
    this.inFlight.add(correlationId);
    this.recentPaths.set(successor, Date.now());

    try {
      await api.tasks.removeDependency(
        successor,
        uid,
        { source: WRITE_SOURCE, correlationId, reason: 'unlink dependency' }
      );
      return true;
    } catch (error) {
      new Notice(
        `TaskNotes Gantt: could not unlink tasks. ${error instanceof Error ? error.message : String(error)}`,
        8000
      );
      return false;
    } finally {
      setTimeout(() => this.inFlight.delete(correlationId), ECHO_WINDOW_MS);
    }
  }
}
