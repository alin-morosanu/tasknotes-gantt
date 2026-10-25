import { BasesView, type BasesViewConfig, type QueryController } from 'obsidian';
import type TaskNotesGanttPlugin from '../main';
import { GanttController } from './controller';
import { tasksFromEntries } from '../data/adapter-bases';
import { buildBanner } from './toolbar';
import { TFile } from 'obsidian';
import type { GanttSettings } from '../settings/defaults';

export const GANTT_BASES_VIEW_TYPE = 'tasknotesGanttChart';

/**
 * The Gantt as a Bases view type.
 *
 * TaskNotes 4.x renders its own Task List, Kanban and Calendar this way, so registering
 * here puts the chart in the same view switcher and lets an existing `.base` file be
 * viewed as a Gantt with no new configuration at all.
 */
export class GanttBasesView extends BasesView {
  type = GANTT_BASES_VIEW_TYPE;

  private controller: GanttController | null = null;
  private bannersEl: HTMLElement;
  private chartEl: HTMLElement;

  /**
   * This view's own settings, seeded from the plugin defaults.
   *
   * Kept separate rather than mutating `plugin.settings`: several Gantts can be open
   * at once, each with different per-view options stored in its own `.base` file, and
   * writing through to the shared object would make the last one rendered silently
   * reconfigure all the others.
   */
  private viewSettings: GanttSettings;

  constructor(
    controller: QueryController,
    private containerEl: HTMLElement,
    private plugin: TaskNotesGanttPlugin
  ) {
    super(controller);
    this.viewSettings = { ...plugin.settings };
    this.containerEl.empty();
    this.containerEl.addClass('tng-view', 'tng-view-bases');
    this.bannersEl = this.containerEl.createDiv({ cls: 'tng-banners' });
    this.chartEl = this.containerEl.createDiv({ cls: 'tng-chart-host' });
  }

  onload(): void {
    this.controller = new GanttController(
      {
        app: this.app,
        settings: this.viewSettings,
        catalog: () => this.plugin.bridge.catalog,
        onOpenTask: (path) => void this.openTask(path),
        writer: this.plugin.writer,
        onChanged: () => this.onDataUpdated()
      },
      this.chartEl
    );
  }

  onunload(): void {
    this.controller?.dispose();
    this.controller = null;
  }

  private async openTask(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  /**
   * Read a per-view option, falling back to the plugin-wide setting.
   *
   * Bases stores these in the `.base` file, so a user can have a Gantt of one project
   * grouped by assignee and another grouped by status without either overriding their
   * global preference.
   */
  private option<T>(key: string, fallback: T): T {
    const value = this.config?.get(key);
    return value === undefined || value === null ? fallback : (value as T);
  }

  onDataUpdated(): void {
    const controller = this.controller;
    if (!controller) return;

    // Per-view options override the plugin defaults for this view only.
    const defaults = this.plugin.settings;
    this.viewSettings.groupBy = this.option('groupBy', defaults.groupBy);
    this.viewSettings.sortKey = this.option('sortKey', defaults.sortKey);
    this.viewSettings.zoom = this.option('zoom', defaults.zoom);
    this.viewSettings.showDependencies = this.option('showDependencies', defaults.showDependencies);
    this.viewSettings.showArrowheads = this.option('showArrowheads', defaults.showArrowheads);
    this.viewSettings.rowHeight = defaults.rowHeight;
    this.viewSettings.gridWidth = defaults.gridWidth;
    this.viewSettings.showCompleted = defaults.showCompleted;
    this.viewSettings.showArchived = defaults.showArchived;
    controller.refresh();

    const tasks = tasksFromEntries(this.data?.data ?? [], {
      catalog: this.plugin.bridge.catalog,
      resolveLink: this.plugin.bridge.resolveLink,
      getFrontmatter: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        return this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
      },
      getChecklist: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return undefined;
        return this.plugin.checklistFor(file);
      }
    });

    controller.setTasks(tasks);
    this.renderBanners(tasks.length);
  }

  private renderBanners(taskCount: number): void {
    for (const el of Array.from(this.bannersEl.querySelectorAll('.tng-banner'))) el.remove();

    const status = this.plugin.bridge.status;
    if (status.mode !== 'api') buildBanner(this.bannersEl, status.reason, 'warn');

    const blocked = this.plugin.writer.blockedReason();
    if (blocked !== null && status.mode === 'api') buildBanner(this.bannersEl, blocked, 'warn');

    const capacity = this.controller?.capacityResult ?? null;
    if (capacity && capacity.unestimatedTotal > 0) {
      buildBanner(
        this.bannersEl,
        `Load chart: ${capacity.unestimatedTotal} of ${capacity.consideredTasks} tasks have no time estimate and contribute nothing to it.`,
        'warn'
      );
    }

    const violations = this.controller?.scheduleResult?.violations ?? [];
    if (violations.length > 0) {
      const first = violations.slice(0, 3).map((v) => v.message).join('; ');
      buildBanner(
        this.bannersEl,
        `${violations.length} task${violations.length === 1 ? '' : 's'} scheduled before a dependency allows: ${first}${
          violations.length > 3 ? ', …' : ''
        }`,
        'warn'
      );
    }

    const cycles = this.controller?.cycleReport ?? [];
    if (cycles.length > 0) {
      buildBanner(
        this.bannersEl,
        `${cycles.length} circular dependency chain${cycles.length === 1 ? '' : 's'} excluded from scheduling.`,
        'error'
      );
    }

    if (taskCount === 0) {
      buildBanner(
        this.bannersEl,
        'This Base returned no tasks. Check its filters, or that the notes carry the TaskNotes task tag.',
        'warn'
      );
    }
  }
}

/** Option schema shown in the Bases view-options menu. */
export function ganttViewOptions(_config: BasesViewConfig): unknown[] {
  return [
    {
      displayName: 'Gantt',
      type: 'group',
      items: [
        {
          key: 'groupBy',
          displayName: 'Group by',
          type: 'dropdown',
          default: 'project',
          options: {
            project: 'Project',
            status: 'Status',
            priority: 'Priority',
            context: 'Context',
            assignee: 'Assignee',
            none: 'No grouping'
          }
        },
        {
          key: 'sortKey',
          displayName: 'Sort tasks by',
          type: 'dropdown',
          default: 'start',
          options: {
            manual: 'Manual order',
            start: 'Start date',
            due: 'Due date',
            title: 'Title',
            priority: 'Priority',
            status: 'Status'
          }
        },
        {
          key: 'zoom',
          displayName: 'Timescale',
          type: 'dropdown',
          default: 'week',
          options: { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter' }
        },
        {
          key: 'showDependencies',
          displayName: 'Show dependency lines',
          type: 'toggle',
          default: true
        },
        {
          key: 'showArrowheads',
          displayName: 'Show arrowheads',
          type: 'toggle',
          default: true
        }
      ]
    }
  ];
}
