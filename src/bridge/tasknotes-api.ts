import type { App } from 'obsidian';

/**
 * Structural types for the TaskNotes runtime API (apiVersion 1).
 *
 * TaskNotes does not publish typings we can depend on, so this file declares only the
 * surface the Gantt actually calls. Everything is optional or narrowly typed on purpose:
 * the bridge validates capabilities at runtime before using any of it.
 *
 * Source of truth: the in-process API documented at
 * https://callumalpass.github.io/tasknotes/javascript-api/ and verified against the
 * installed 4.12.5 bundle.
 */

export type Capability =
  | 'model.read'
  | 'catalog.read'
  | 'tasks.read'
  | 'tasks.write'
  | 'tasks.delete'
  | 'tasks.move'
  | 'tasks.events'
  | 'relationships.read'
  | 'query.tasks'
  | 'settings.snapshot'
  | 'lifecycle.events'
  | 'extensions.register';

/** Attached to every mutation so our own writes can be told apart from the user's. */
export interface MutationContext {
  source: string;
  correlationId?: string;
  reason?: string;
}

export interface TaskNotesEventPayload {
  event: string;
  timestamp?: number;
  taskPath?: string;
  task?: unknown;
  before?: unknown;
  after?: unknown;
  changes?: Record<string, unknown>;
  context?: MutationContext;
}

/** Obsidian `EventRef`, opaque to us; held only to pass back to `off`. */
export type TaskNotesEventRef = unknown;

export interface TaskNotesQuery {
  where?: unknown;
  sort?: { field: string; direction?: 'asc' | 'desc' }[];
  group?: { field: string }[];
  limit?: number;
  offset?: number;
  scope?: { includeArchived?: boolean; folders?: string[]; excludeFolders?: string[] };
}

export interface TaskNotesQueryResult {
  tasks: Record<string, unknown>[];
  total: number;
  matched: number;
  returned: number;
  warnings?: string[];
}

export interface TaskNotesRuntimeApi {
  apiVersion: number;
  capabilities: string[];
  hasCapability(name: string): boolean;

  lifecycle: {
    ready(): Promise<void>;
    isReady(): boolean;
    on(name: string, cb: (payload: unknown) => void): TaskNotesEventRef;
    off(ref: TaskNotesEventRef): void;
  };

  catalog: {
    statuses(): unknown[];
    priorities(): unknown[];
    userFields(): unknown[];
  };

  model: {
    config(): { fieldMapping?: Record<string, string> } & Record<string, unknown>;
  };

  settings: { snapshot(): Record<string, unknown> };

  tasks: {
    get(path: string): unknown;
    list(options?: unknown): Promise<unknown[]>;
    update(path: string, patch: Record<string, unknown>, ctx?: MutationContext): Promise<unknown>;
    setScheduled(path: string, date: string | null, ctx?: MutationContext): Promise<unknown>;
    setDue(path: string, date: string | null, ctx?: MutationContext): Promise<unknown>;
    addDependency(path: string, dep: unknown, ctx?: MutationContext): Promise<unknown>;
    /** The uid is a plain string, matched exactly against the stored `blockedBy`. */
    removeDependency(path: string, uid: string, ctx?: MutationContext): Promise<unknown>;
  };

  query: {
    tasks(query: TaskNotesQuery): Promise<TaskNotesQueryResult>;
    filterOptions?(): Promise<unknown>;
  };

  events: {
    on(name: string, cb: (payload: TaskNotesEventPayload) => void): TaskNotesEventRef;
    off(ref: TaskNotesEventRef): void;
    list(): string[];
  };

  extensions?: {
    register(ext: {
      id: string;
      namespace: string;
      api: unknown;
      version?: string;
      capabilities?: string[];
    }): { unregister(): void };
  };

  errors: {
    isApiError(e: unknown): boolean;
    toResult<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
  };
}

export interface TaskNotesPlugin {
  api?: TaskNotesRuntimeApi;
  manifest?: { version?: string };
  /** Internal services, used only by the fallback adapter when the API is absent. */
  fieldMapper?: { getMapping(): Record<string, string> };
}

/** Obsidian's plugin registry is internal API, so it is reached through a narrow cast. */
interface AppWithPlugins extends App {
  plugins?: { plugins?: Record<string, unknown>; enabledPlugins?: Set<string> };
}

export const TASKNOTES_PLUGIN_ID = 'tasknotes';

export function getTaskNotesPlugin(app: App): TaskNotesPlugin | null {
  const registry = (app as AppWithPlugins).plugins?.plugins;
  const plugin = registry?.[TASKNOTES_PLUGIN_ID];
  return plugin ? (plugin as TaskNotesPlugin) : null;
}
