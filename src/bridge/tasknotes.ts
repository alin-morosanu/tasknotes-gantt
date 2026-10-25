import type { App } from 'obsidian';
import type { TaskNotesCatalog } from '../types';
import {
  buildCatalog,
  DEFAULT_FIELD_MAPPING,
  DEFAULT_IDENTIFICATION,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES
} from './catalog';
import {
  getTaskNotesPlugin,
  TASKNOTES_PLUGIN_ID,
  type Capability,
  type TaskNotesPlugin,
  type TaskNotesRuntimeApi
} from './tasknotes-api';

/**
 * How the Gantt is talking to TaskNotes.
 *
 * - `api`      the runtime API is present and usable; reads and writes both work.
 * - `fallback` TaskNotes' data is readable from the vault but the API is not usable;
 *              the view runs read-only.
 * - `unavailable` nothing usable was found.
 */
export type BridgeMode = 'api' | 'fallback' | 'unavailable';

/** The API version this plugin was written against. */
export const SUPPORTED_API_VERSION = 1;

/** Capabilities the Gantt needs before it will enable writing. */
const WRITE_CAPABILITIES: Capability[] = ['tasks.read', 'tasks.write', 'catalog.read'];

export interface BridgeStatus {
  mode: BridgeMode;
  /** Human-readable explanation, shown in the view banner when not `api`. */
  reason: string;
  taskNotesVersion: string | null;
  apiVersion: number | null;
  writable: boolean;
}

/** Relative to the vault's config folder, which users can rename from `.obsidian`. */
const TASKNOTES_DATA_FILE = `plugins/${TASKNOTES_PLUGIN_ID}/data.json`;

/**
 * Owns the connection to TaskNotes: discovery, capability negotiation, catalog
 * snapshotting, and graceful degradation when any of that fails.
 *
 * Nothing else in the plugin reaches into `app.plugins` — a single choke point keeps
 * the failure modes in one testable place and means a TaskNotes major version bump
 * degrades the Gantt to read-only rather than breaking it.
 */
export class TaskNotesBridge {
  private plugin: TaskNotesPlugin | null = null;
  private runtimeApi: TaskNotesRuntimeApi | null = null;
  private extensionHandle: { unregister(): void } | null = null;

  status: BridgeStatus = {
    mode: 'unavailable',
    reason: 'Not connected yet.',
    taskNotesVersion: null,
    apiVersion: null,
    writable: false
  };

  catalog: TaskNotesCatalog = {
    identification: DEFAULT_IDENTIFICATION,
    statuses: DEFAULT_STATUSES,
    priorities: DEFAULT_PRIORITIES,
    fieldMapping: { ...DEFAULT_FIELD_MAPPING },
    userFields: []
  };

  constructor(private app: App) {}

  /** The runtime API, or null when running in fallback mode. */
  get api(): TaskNotesRuntimeApi | null {
    return this.runtimeApi;
  }

  get isWritable(): boolean {
    return this.status.writable;
  }

  /**
   * Connect to TaskNotes, waiting for it to finish loading.
   *
   * `lifecycle.ready()` also resolves immediately when TaskNotes is already up, so this
   * is safe against either load order.
   */
  async connect(): Promise<BridgeStatus> {
    this.plugin = getTaskNotesPlugin(this.app);

    if (!this.plugin) {
      this.status = {
        mode: 'unavailable',
        reason: 'TaskNotes is not installed or not enabled.',
        taskNotesVersion: null,
        apiVersion: null,
        writable: false
      };
      await this.loadCatalogFromDisk();
      return this.status;
    }

    const version = this.plugin.manifest?.version ?? null;
    const api = this.plugin.api;

    if (!api) {
      this.status = {
        mode: 'fallback',
        reason: `TaskNotes ${version ?? 'installed'} does not expose a runtime API. Running read-only.`,
        taskNotesVersion: version,
        apiVersion: null,
        writable: false
      };
      await this.loadCatalogFromDisk();
      return this.status;
    }

    try {
      await api.lifecycle.ready();
    } catch {
      // A failed ready() means TaskNotes is present but unhealthy; fall back rather
      // than leaving the view stuck waiting on a promise that will not resolve.
      this.status = {
        mode: 'fallback',
        reason: 'TaskNotes did not finish initializing. Running read-only.',
        taskNotesVersion: version,
        apiVersion: api.apiVersion ?? null,
        writable: false
      };
      await this.loadCatalogFromDisk();
      return this.status;
    }

    if (api.apiVersion !== SUPPORTED_API_VERSION) {
      this.status = {
        mode: 'fallback',
        reason: `TaskNotes API v${api.apiVersion} is not supported (this plugin targets v${SUPPORTED_API_VERSION}). Running read-only.`,
        taskNotesVersion: version,
        apiVersion: api.apiVersion ?? null,
        writable: false
      };
      await this.loadCatalogFromDisk();
      return this.status;
    }

    const missing = WRITE_CAPABILITIES.filter((cap) => !api.hasCapability(cap));
    this.runtimeApi = api;
    this.loadCatalogFromApi(api);

    this.status = {
      mode: 'api',
      reason:
        missing.length === 0
          ? 'Connected to the TaskNotes runtime API.'
          : `Connected read-only; TaskNotes is missing: ${missing.join(', ')}.`,
      taskNotesVersion: version,
      apiVersion: api.apiVersion,
      writable: missing.length === 0
    };

    this.registerExtension(api);
    return this.status;
  }

  /**
   * Announce ourselves to TaskNotes so other integrations can see the Gantt is loaded.
   * Namespace `gantt` is not on TaskNotes' reserved list. Failure here is cosmetic.
   */
  private registerExtension(api: TaskNotesRuntimeApi): void {
    if (!api.extensions || !api.hasCapability('extensions.register')) return;
    try {
      this.extensionHandle = api.extensions.register({
        id: 'tasknotes-gantt',
        namespace: 'gantt',
        version: '0.1.0',
        api: {}
      });
    } catch {
      this.extensionHandle = null;
    }
  }

  private loadCatalogFromApi(api: TaskNotesRuntimeApi): void {
    try {
      const settings = api.hasCapability('settings.snapshot') ? api.settings.snapshot() : {};
      this.catalog = buildCatalog({
        statuses: api.catalog.statuses(),
        priorities: api.catalog.priorities(),
        userFields: api.catalog.userFields(),
        fieldMapping: api.model.config()?.fieldMapping,
        settings
      });
    } catch {
      // A catalog read failure is not fatal: the defaults still render a chart, they
      // just may not match the user's custom statuses.
      this.loadCatalogFromDisk();
    }
  }

  /**
   * Read the catalog straight out of TaskNotes' `data.json`.
   *
   * This is what keeps the fallback mode genuinely useful rather than a blank chart:
   * the user's real statuses, priorities and field mapping are all in that file even
   * when the plugin object is unreachable.
   */
  private async loadCatalogFromDisk(): Promise<void> {
    try {
      // The adapter, not the Vault API: the config folder is not part of the indexed
      // vault, so `getFileByPath` cannot see another plugin's data file.
      const path = `${this.app.vault.configDir}/${TASKNOTES_DATA_FILE}`;
      if (!(await this.app.vault.adapter.exists(path))) return;
      const raw = await this.app.vault.adapter.read(path);
      const data = JSON.parse(raw) as Record<string, unknown>;
      this.catalog = buildCatalog({
        statuses: data['customStatuses'],
        priorities: data['customPriorities'],
        userFields: data['userFields'],
        fieldMapping: data['fieldMapping'],
        settings: data
      });
    } catch {
      // Leave the defaults in place; the banner already tells the user we degraded.
    }
  }

  /** Resolve a link target to a vault path, or null when the link is dangling. */
  resolveLink = (target: string, sourcePath: string): string | null => {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    return file ? file.path : null;
  };

  unload(): void {
    this.extensionHandle?.unregister();
    this.extensionHandle = null;
    this.runtimeApi = null;
    this.plugin = null;
  }
}
