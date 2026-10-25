import { MarkdownRenderChild, TFile } from 'obsidian';
import type TaskNotesGanttPlugin from '../main';
import { GanttController } from './controller';
import { buildFacets } from '../model/filter';
import { parseBlockConfig, resolveSelectors } from '../settings/block-config';
import type { GanttSettings } from '../settings/defaults';

/**
 * A chart embedded in a note by a ```tngantt``` block.
 *
 * The point of this is the project notes it was built for: several of them carry
 * hand-drawn ASCII timelines, and this puts the real plan where the drawing was.
 *
 * Read-only unless the block asks otherwise. An embedded chart is read while
 * scrolling past it, and a stray drag that silently rewrote a date in a note the
 * reader was not even editing would be indefensible.
 */

/** Long enough that typing in a note does not redraw on every keystroke. */
const REFRESH_DEBOUNCE_MS = 400;

export class GanttEmbed extends MarkdownRenderChild {
  private controller: GanttController | null = null;
  private settings: GanttSettings;
  private timer: number | null = null;

  constructor(
    containerEl: HTMLElement,
    private plugin: TaskNotesGanttPlugin,
    private source: string
  ) {
    super(containerEl);
    // Its own object, never the plugin's. Sharing one was a real bug: opening a second
    // chart silently reconfigured the first.
    this.settings = { ...plugin.settings };
  }

  onload(): void {
    this.containerEl.addClass('tng-embed');
    this.render();

    const onChange = () => this.scheduleRefresh();
    this.registerEvent(this.plugin.app.metadataCache.on('changed', onChange));
    this.registerEvent(this.plugin.app.vault.on('delete', onChange));
    this.registerEvent(this.plugin.app.vault.on('rename', onChange));
    this.registerEvent(
      this.plugin.app.workspace.on('resize', () => this.controller?.requestRender())
    );
  }

  onunload(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.controller?.dispose();
    this.controller = null;
    this.containerEl.empty();
  }

  /**
   * Redraw after the vault settles.
   *
   * Every metadata change fires this, including changes to the very note the block
   * lives in. Debouncing is what keeps a block in a note being edited from rebuilding
   * the whole chart on each keystroke.
   */
  private scheduleRefresh(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  private render(): void {
    const catalog = this.plugin.bridge.catalog;
    const config = parseBlockConfig(this.source, catalog, this.plugin.settings.resourceField);

    const tasks = this.plugin.readTasks();
    const facets = buildFacets(catalog, this.plugin.settings.resourceField);
    const resolved = resolveSelectors(config.selectors, facets, tasks, config.text);

    const problems = [...config.errors, ...resolved.errors];
    if (problems.length > 0) {
      this.renderProblems(problems);
      return;
    }

    this.settings = { ...this.plugin.settings, ...config.settings, filter: resolved.filter };

    // Rebuilt rather than reused: the block body may have changed the grouping, the
    // filter or whether editing is allowed, and those are read at construction.
    this.controller?.dispose();
    this.controller = null;
    this.containerEl.empty();

    const chartEl = this.containerEl.createDiv({ cls: 'tng-embed-chart' });
    chartEl.style.height = `${config.height}px`;

    const editable = config.editable && this.plugin.writer.blockedReason() === null;
    this.controller = new GanttController(
      {
        app: this.plugin.app,
        settings: this.settings,
        catalog: () => this.plugin.bridge.catalog,
        onOpenTask: (path) => void this.openTask(path),
        // Absent means read-only: the controller disables every editing gesture.
        ...(editable ? { writer: this.plugin.writer } : {}),
        ...(editable ? { onChanged: () => this.scheduleRefresh() } : {})
      },
      chartEl
    );
    this.controller.setTasks(tasks);

    if (this.controller.taskCount === 0) {
      this.containerEl
        .createDiv({ cls: 'tng-embed-empty' })
        .setText('No tasks match this block.');
    }
  }

  /**
   * Show what is wrong instead of the chart.
   *
   * An empty box tells the author nothing, and a block that quietly renders the whole
   * vault because one line was misspelt is worse than one that refuses.
   */
  private renderProblems(problems: readonly string[]): void {
    this.controller?.dispose();
    this.controller = null;
    this.containerEl.empty();

    const box = this.containerEl.createDiv({ cls: 'tng-embed-error' });
    box.createDiv({ cls: 'tng-embed-error-title', text: 'Gantt block' });
    const list = box.createEl('ul');
    for (const problem of problems) list.createEl('li', { text: problem });
  }

  private async openTask(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.plugin.app.workspace.getLeaf('tab').openFile(file);
  }
}
