import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type TaskNotesGanttPlugin from '../main';
import { GanttController } from './controller';
import { buildBanner, buildToolbar } from './toolbar';
import { chooseExport } from './export-modal';
import { confirmChanges } from './confirm-modal';
import { FilterBar } from './filter-bar';
import {
  exportPath,
  saveBinaryExport,
  saveTextExport,
  svgToPng,
  type ExportFormat
} from '../export';
import { exportSvg } from '../export/svg';
import { exportCsv } from '../export/csv';
import { exportMermaid, mermaidCodeBlock } from '../export/mermaid';
import { calendarFrom } from '../settings/defaults';
import { Notice } from 'obsidian';
import type { GanttSettings } from '../settings/defaults';

export const GANTT_VIEW_TYPE = 'tasknotes-gantt-view';

/**
 * The full-tab Gantt.
 *
 * Where the Bases view is scoped to one `.base` query, this one sees the whole vault,
 * which is what makes cross-project portfolio planning possible.
 */
export class GanttStandaloneView extends ItemView {
  private controller: GanttController | null = null;
  private chartEl: HTMLElement | null = null;
  private bannersEl: HTMLElement | null = null;
  private filterBar: FilterBar | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TaskNotesGanttPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GANTT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Gantt';
  }

  getIcon(): string {
    return 'chart-gantt';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('tng-view');

    this.bannersEl = root.createDiv({ cls: 'tng-banners' });
    this.chartEl = root.createDiv({ cls: 'tng-chart-host' });

    this.controller = new GanttController(
      {
        app: this.app,
        settings: this.plugin.settings,
        catalog: () => this.plugin.bridge.catalog,
        onOpenTask: (path) => void this.openTask(path),
        writer: this.plugin.writer,
        onChanged: () => void this.reload(),
        onHiddenGroupsChanged: (ids) => void this.applySettings({ hiddenGroups: ids })
      },
      this.chartEl
    );

    buildToolbar(this.bannersEl, {
      settings: this.plugin.settings,
      controller: this.controller,
      onChange: (patch) => void this.applySettings(patch)
    });

    this.filterBar = new FilterBar(this.bannersEl, {
      facets: () => this.controller?.facets ?? [],
      allTasks: () => this.controller?.allTasks ?? [],
      filter: () => this.plugin.settings.filter,
      onChange: (next) => void this.applyFilter(next)
    });

    // The chart sizes itself to its container, which has no size until layout runs.
    this.registerEvent(
      this.app.workspace.on('resize', () => this.controller?.requestRender())
    );

    await this.reload();
  }

  private async applySettings(patch: Partial<GanttSettings>): Promise<void> {
    Object.assign(this.plugin.settings, patch);
    await this.plugin.saveSettings();
    this.controller?.refresh();
    // Grouping and the assignee field both change which facets exist.
    this.filterBar?.render();
  }

  private async applyFilter(next: GanttSettings['filter']): Promise<void> {
    this.plugin.settings.filter = next;
    await this.plugin.saveSettings();
    // Re-filter what is already loaded rather than re-reading the vault.
    this.controller?.applyCurrentFilter();
    this.filterBar?.setFilter(next);
  }

  private async openTask(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  /**
   * Export the chart as it currently stands.
   *
   * Public so the plugin's command can reach the view that is actually on screen,
   * rather than rebuilding a chart the user is not looking at.
   */
  async exportChart(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;

    const choice = await chooseExport(this.app, this.plugin.settings.exportFolder);
    if (!choice) return;
    if (choice.folder !== this.plugin.settings.exportFolder) {
      this.plugin.settings.exportFolder = choice.folder;
      await this.plugin.saveSettings();
    }

    const snapshot = controller.exportSnapshot();
    const path = exportPath(choice.folder, 'Gantt export', choice.format);
    const settings = this.plugin.settings;

    const buildSvg = (): string =>
      exportSvg({
        rows: snapshot.rows,
        bars: snapshot.bars,
        edges: snapshot.edges,
        scale: snapshot.scale,
        metrics: snapshot.metrics,
        palette: snapshot.palette,
        statuses: this.plugin.bridge.catalog.statuses,
        critical: snapshot.critical,
        startX: snapshot.bounds.startX,
        endX: snapshot.bounds.endX,
        labelWidth: 260,
        todayMs: Date.now(),
        title: 'TaskNotes Gantt',
        showArrowheads: settings.showArrowheads
      });

    let file: import('obsidian').TFile | null = null;

    switch (choice.format as ExportFormat) {
      case 'svg':
        file = await saveTextExport(this.app, path, buildSvg());
        break;
      case 'png': {
        const png = await svgToPng(buildSvg());
        if (!png) {
          new Notice('TaskNotes Gantt: the chart was too large to rasterise.');
          return;
        }
        file = await saveBinaryExport(this.app, path, png);
        break;
      }
      case 'csv':
        file = await saveTextExport(
          this.app,
          path,
          exportCsv(snapshot.rows, snapshot.bars, {
            calendar: calendarFrom(settings),
            scheduleFor: snapshot.scheduleFor,
            varianceFor: snapshot.varianceFor,
            minutesPerDay: settings.dayEndMinutes - settings.dayStartMinutes
          })
        );
        break;
      case 'mermaid':
        file = await saveTextExport(
          this.app,
          path,
          mermaidCodeBlock(
            exportMermaid(snapshot.rows, snapshot.bars, {
              title: 'TaskNotes Gantt',
              critical: snapshot.critical
            })
          )
        );
        break;
    }

    if (file) {
      new Notice(`TaskNotes Gantt: exported to ${file.path}`);
      await this.app.workspace.getLeaf('tab').openFile(file);
    }
  }

  /** Refetch tasks and redraw. */
  async reload(): Promise<void> {
    await this.plugin.whenReady();
    const controller = this.controller;
    if (!controller) return;

    controller.setTasks(this.plugin.readTasks());
    this.filterBar?.render();
    this.renderBanners();
  }

  private renderBanners(): void {
    const host = this.bannersEl;
    const controller = this.controller;
    if (!host || !controller) return;

    for (const el of Array.from(host.querySelectorAll('.tng-banner'))) el.remove();

    const status = this.plugin.bridge.status;
    if (status.mode !== 'api') buildBanner(host, status.reason, 'warn');

    const blocked = this.plugin.writer.blockedReason();
    if (blocked !== null && status.mode === 'api') buildBanner(host, blocked, 'warn');

    // Say what the load chart is measuring, and how much of the data it actually
    // covers. Without this, "no resource is over capacity" and "the property you are
    // measuring against is empty" look identical: both are simply no banner at all.
    const capacity = controller.capacityResult ?? null;
    if (capacity) {
      const field = this.plugin.settings.resourceField;
      if (capacity.assignedTasks === 0) {
        buildBanner(
          host,
          `Load chart: no visible task has a value for "${field}", so there is nothing ` +
            'to measure capacity against. Change the resource property in settings — ' +
            '"contexts" or "projects" work if you do not assign tasks to people.',
          'warn'
        );
      } else {
        const missing =
          capacity.unestimatedTotal > 0
            ? ` ${capacity.unestimatedTotal} have no time estimate and contribute nothing to it.`
            : '';
        buildBanner(
          host,
          `Load chart: measuring "${field}" — ${capacity.assignedTasks} of ` +
            `${capacity.consideredTasks} tasks carry one.${missing}`,
          capacity.unestimatedTotal > 0 ? 'warn' : 'info'
        );
      }
    }

    // Only offered when the load chart is on: without it there are no capacity numbers
    // on screen, and a button to fix a problem the user cannot see is a trap.
    const overloaded = controller.overloadedDays;
    if (overloaded > 0) {
      buildBanner(
        host,
        `${overloaded} day${overloaded === 1 ? '' : 's'} above capacity for at least one resource.`,
        'warn',
        this.plugin.writer.blockedReason() === null
          ? {
              label: 'Level them',
              tooltip:
                'Push the least important task with the most slack off each overloaded day, ' +
                'until nothing is over capacity. Nothing moves earlier, dependencies are ' +
                'kept, and you can undo it.',
              onClick: () => void controller.levelResources()
            }
          : undefined
      );
    }

    const violations = controller.scheduleResult?.violations ?? [];
    if (violations.length > 0) {
      const first = violations.slice(0, 3).map((v) => v.message).join('; ');
      buildBanner(
        host,
        `${violations.length} task${violations.length === 1 ? '' : 's'} scheduled before a dependency allows: ${first}${
          violations.length > 3 ? ', …' : ''
        }`,
        'warn',
        this.plugin.writer.blockedReason() === null
          ? {
              label: 'Reschedule them',
              tooltip:
                'Push each task forward to the earliest date its dependencies allow. Nothing moves earlier, and you can undo it.',
              onClick: () => void controller.fixConflicts()
            }
          : undefined
      );
    }

    const cycles = controller.cycleReport;
    if (cycles.length > 0) {
      const names = cycles
        .map((members) => members.map((m) => m.split('/').pop()?.replace(/\.md$/, '') ?? m).join(' -> '))
        .join('; ');
      buildBanner(
        host,
        `${cycles.length} circular dependency chain${cycles.length === 1 ? '' : 's'} found and excluded from scheduling: ${names}`,
        'error',
        this.plugin.writer.blockedReason() === null
          ? {
              label: 'Break the loop',
              tooltip:
                'Remove one dependency from each circular chain. You will see exactly which before anything changes.',
              onClick: () =>
                void controller.breakCycles((label, lines) =>
                  confirmChanges(this.app, label, lines)
                )
            }
          : undefined
      );
    }

    const total = controller.allTasks.length;
    const shown = controller.taskCount;
    if (total === 0) {
      buildBanner(host, 'No TaskNotes tasks found in this vault.', 'warn');
    } else if (shown === 0) {
      buildBanner(host, `No tasks match the current filter. ${total} are hidden.`, 'warn');
    } else if (shown < total) {
      buildBanner(host, `Showing ${shown} of ${total} tasks. Filters are active.`, 'warn');
    }
  }

  async onClose(): Promise<void> {
    this.filterBar?.dispose();
    this.filterBar = null;
    this.controller?.dispose();
    this.controller = null;
  }
}
