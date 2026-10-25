import { Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { TaskNotesBridge } from './bridge/tasknotes';
import { VaultAdapter, countChecklist } from './data/adapter-vault';
import { buildDiagnosticsReport } from './diagnostics';
import { DEFAULT_SETTINGS, mergeSettings, type GanttSettings } from './settings/defaults';
import { GANTT_VIEW_TYPE, GanttStandaloneView } from './ui/view-standalone';
import { GanttEmbed } from './ui/view-embed';
import { GANTT_BASES_VIEW_TYPE, GanttBasesView, ganttViewOptions } from './ui/view-bases';
import type { GanttTask } from './types';
import { GanttWriter } from './bridge/writer';
import { TaskNotesEvents } from './bridge/events';
import { confirmChanges } from './ui/confirm-modal';
import { GanttSettingTab } from './settings/settings-tab';
import { BaselineWriter } from './bridge/frontmatter';
import { planBaseline, planClearBaseline, summariseSlippage } from './model/baseline';
import { computeBars } from './model/geometry';
import { calendarFrom } from './settings/defaults';

const REPORT_PATH = 'TaskNotes Gantt report.md';

/** Obsidian's Bases plugin may not be loaded when we are; retry rather than give up. */
const BASES_RETRY_MS = 2000;
const BASES_MAX_ATTEMPTS = 15;

export default class TaskNotesGanttPlugin extends Plugin {
  bridge!: TaskNotesBridge;
  vaultAdapter!: VaultAdapter;
  writer!: GanttWriter;
  baselineWriter!: BaselineWriter;
  settings: GanttSettings = { ...DEFAULT_SETTINGS };

  private events: TaskNotesEvents | null = null;

  /**
   * Resolves once the bridge has connected and the catalog is loaded.
   *
   * Connecting cannot block `onload`, but reading a half-initialized catalog would
   * silently produce a chart built on TaskNotes' shipped defaults instead of the
   * user's real statuses — so every entry point awaits this rather than assuming.
   */
  private ready: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());

    this.bridge = new TaskNotesBridge(this.app);
    this.vaultAdapter = new VaultAdapter(this.app, this.bridge.catalog, this.bridge.resolveLink);
    this.writer = new GanttWriter({
      bridge: this.bridge,
      isSafeMode: () => this.settings.safeMode,
      confirmThreshold: () => this.settings.confirmThreshold,
      confirm: (label, descriptions) => confirmChanges(this.app, label, descriptions)
    });

    this.baselineWriter = new BaselineWriter({
      app: this.app,
      isSafeMode: () => this.settings.safeMode,
      confirmThreshold: () => this.settings.confirmThreshold,
      confirm: (label, descriptions) => confirmChanges(this.app, label, descriptions)
    });

    this.addSettingTab(new GanttSettingTab(this.app, this));

    this.registerView(GANTT_VIEW_TYPE, (leaf) => new GanttStandaloneView(leaf, this));

    // A chart inside a note. Awaits the same `ready` every other entry point does, or
    // a block rendered during startup would draw against TaskNotes' shipped defaults
    // instead of the user's real statuses.
    this.registerMarkdownCodeBlockProcessor('tngantt', async (source, el, ctx) => {
      await this.ready;
      ctx.addChild(new GanttEmbed(el, this, source));
    });

    this.addRibbonIcon('chart-gantt', 'Open Gantt', () => void this.activateView());

    this.addCommand({
      id: 'open-gantt-view',
      name: 'Open chart',
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: 'export-chart',
      name: 'Export chart',
      checkCallback: (checking) => {
        const view = this.activeGanttView();
        if (!view) return false;
        if (!checking) void view.exportChart();
        return true;
      }
    });

    this.addCommand({
      id: 'set-baseline',
      name: 'Set baseline for all tasks',
      callback: () => void this.setBaseline()
    });

    this.addCommand({
      id: 'clear-baseline',
      name: 'Clear baseline from all tasks',
      callback: () => void this.clearBaseline()
    });

    this.addCommand({
      id: 'undo-last-change',
      name: 'Undo last change',
      callback: () => void this.undoLastChange()
    });

    this.addCommand({
      id: 'toggle-safe-mode',
      name: 'Toggle safe mode (read-only)',
      callback: () => void this.toggleSafeMode()
    });

    this.addCommand({
      id: 'write-data-report',
      name: 'Write data report',
      callback: () => void this.writeReport()
    });

    this.ready = new Promise<void>((resolve) => {
      this.app.workspace.onLayoutReady(() => {
        void this.connect().finally(resolve);
      });
    });

    this.registerBasesViewWithRetry();
    this.registerVaultListeners();
  }

  /** Await bridge readiness. Views call this before their first read. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async connect(): Promise<void> {
    const status = await this.bridge.connect();
    this.vaultAdapter.setCatalog(this.bridge.catalog);
    if (status.mode !== 'api') new Notice(`TaskNotes Gantt: ${status.reason}`, 8000);

    // Listen for changes made anywhere else in Obsidian. The writer filters out the
    // echo of our own writes, so a drag does not re-render on top of itself.
    this.events = new TaskNotesEvents(this.bridge, this.writer, () => this.refreshViews());
    this.events.start();

    this.refreshViews();
  }

  /** The Gantt view the user is looking at, if any. */
  private activeGanttView(): GanttStandaloneView | null {
    const active = this.app.workspace.getActiveViewOfType(GanttStandaloneView);
    if (active) return active;
    const leaf = this.app.workspace.getLeavesOfType(GANTT_VIEW_TYPE)[0];
    return leaf?.view instanceof GanttStandaloneView ? leaf.view : null;
  }

  /** The fields this plugin owns for baselines. */
  private get baselineFields(): { start: string; end: string } {
    return { start: this.settings.baselineStartField, end: this.settings.baselineEndField };
  }

  /**
   * Snapshot every task's current dates as its baseline.
   *
   * Explicit and never automatic: a baseline is a claim about what was agreed, and
   * silently re-taking one on every edit would destroy the thing it exists to measure.
   */
  private async setBaseline(): Promise<void> {
    await this.ready;
    const tasks = this.readTasks().filter((t) => !t.archived);
    const bars = computeBars(tasks, {
      calendar: calendarFrom(this.settings),
      dueDateInclusive: this.settings.dueDateInclusive,
      defaultDurationMinutes: this.settings.defaultDurationMinutes,
      todayMs: Date.now()
    });

    const patches = tasks
      .map((task) => {
        const bar = bars.get(task.path);
        return bar ? planBaseline(task, bar, this.baselineFields) : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const result = await this.baselineWriter.apply(
      patches,
      this.baselineFields,
      `Set baseline for ${patches.length} tasks`
    );
    if (result.written > 0) {
      new Notice(`TaskNotes Gantt: baseline set for ${result.written} tasks.`);
      this.refreshViews();
    }
  }

  private async clearBaseline(): Promise<void> {
    await this.ready;
    const patches = this.readTasks()
      .map((task) => planClearBaseline(task, this.baselineFields))
      .filter((p): p is NonNullable<typeof p> => p !== null);

    if (patches.length === 0) {
      new Notice('TaskNotes Gantt: no task has a baseline.');
      return;
    }

    const result = await this.baselineWriter.apply(
      patches,
      this.baselineFields,
      `Clear baseline from ${patches.length} tasks`
    );
    if (result.written > 0) {
      new Notice(`TaskNotes Gantt: baseline cleared from ${result.written} tasks.`);
      this.refreshViews();
    }
  }

  private async undoLastChange(): Promise<void> {
    // Both writers keep their own journal; undo the one that acted most recently is
    // ambiguous, so date changes take precedence and baselines fall through.
    if (this.writer.canUndo) {
      const result = await this.writer.undo();
      if (result.written > 0) this.refreshViews();
      return;
    }
    if (this.baselineWriter.canUndo) {
      const result = await this.baselineWriter.undo(this.baselineFields);
      if (result.written > 0) this.refreshViews();
      return;
    }
    new Notice('TaskNotes Gantt: nothing to undo.');
  }

  private async toggleSafeMode(): Promise<void> {
    this.settings.safeMode = !this.settings.safeMode;
    await this.saveSettings();
    new Notice(
      this.settings.safeMode
        ? 'TaskNotes Gantt: safe mode ON — the chart is read-only.'
        : 'TaskNotes Gantt: safe mode OFF — dragging will edit your notes.'
    );
    this.refreshViews();
  }

  /**
   * Register the Bases view type, retrying while the core Bases plugin loads.
   *
   * `registerBasesView` returns false when Bases is not ready yet, and TaskNotes solves
   * the same race the same way. Giving up silently would leave the user with a view
   * type that never appears in the switcher.
   */
  private registerBasesViewWithRetry(attempt = 0): void {
    const registered = this.registerBasesView(GANTT_BASES_VIEW_TYPE, {
      name: 'Gantt',
      icon: 'chart-gantt',
      factory: (controller, containerEl) => new GanttBasesView(controller, containerEl, this),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: ganttViewOptions as any
    });

    if (registered || attempt >= BASES_MAX_ATTEMPTS) return;
    this.registerInterval(
      window.setTimeout(() => this.registerBasesViewWithRetry(attempt + 1), BASES_RETRY_MS)
    );
  }

  /** Redraw open views when the vault changes underneath them. */
  private registerVaultListeners(): void {
    const onChange = () => this.refreshViews();
    this.registerEvent(this.app.metadataCache.on('changed', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(GANTT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof GanttStandaloneView) void view.reload();
    }
    // A Bases view redraws from its own query; nudging Bases re-runs it, which also
    // picks up whatever we just wrote.
    this.app.workspace.trigger('bases:refresh-views');
  }

  /** Public entry point for the settings tab. */
  refreshAllViews(): void {
    this.refreshViews();
  }

  /** Read every task in the vault, normalized. */
  readTasks(): GanttTask[] {
    return this.vaultAdapter.readAll();
  }

  /** Body checkbox counts for a file, used as the progress signal. */
  checklistFor(file: TFile): { done: number; total: number } {
    return countChecklist(this.app.metadataCache.getFileCache(file));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(GANTT_VIEW_TYPE);
    const leaf: WorkspaceLeaf | null =
      existing[0] ?? this.app.workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.setViewState({ type: GANTT_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Write a report of everything the plugin can see, into a note in the vault.
   *
   * Deliberately a note rather than a console dump: it is the artifact a user can send
   * back when a task does not appear where they expect.
   */
  private async writeReport(): Promise<void> {
    await this.ready;
    const tasks = this.readTasks();
    const bars = computeBars(tasks, {
      calendar: calendarFrom(this.settings),
      dueDateInclusive: this.settings.dueDateInclusive,
      defaultDurationMinutes: this.settings.defaultDurationMinutes,
      todayMs: Date.now()
    });
    const slippage = summariseSlippage(
      tasks,
      bars,
      calendarFrom(this.settings),
      this.baselineFields,
      this.settings.dueDateInclusive
    );
    const report = buildDiagnosticsReport(
      tasks,
      this.bridge.catalog,
      this.bridge.status,
      slippage,
      this.settings.resourceField
    );

    const existing = this.app.vault.getAbstractFileByPath(REPORT_PATH);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => report);
    } else {
      await this.app.vault.create(REPORT_PATH, report);
    }

    new Notice(`TaskNotes Gantt: report written for ${tasks.length} tasks.`);
    const file = this.app.vault.getAbstractFileByPath(REPORT_PATH);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  onunload(): void {
    this.events?.stop();
    this.events = null;
    this.bridge.unload();
  }
}
