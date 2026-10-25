import type { App } from 'obsidian';
import type { Bar, Edge, GanttTask, ScheduleNode, TaskNotesCatalog, TaskPath } from '../types';
import { buildAdjacency, buildEdges, detectCycles } from '../model/graph';
import { computeBars, type GeometryOptions } from '../model/geometry';
import { boundsOf } from '../model/geometry';
import { calendarFrom, type GanttSettings } from '../settings/defaults';
import {
  buildRows,
  makeComparator,
  visibleRows,
  type Row
} from '../render/layout';
import {
  DEFAULT_METRICS,
  barRect,
  hitZone,
  offscreenSide,
  OFFSCREEN_ZONE,
  prepareCanvas,
  renderChart,
  type ChartMetrics,
  type HitZone
} from '../render/canvas';
import { readPalette } from '../render/theme';
import {
  createTimescale,
  msOf,
  xOf,
  zoomIn,
  zoomOut,
  type Timescale,
  type ZoomLevel
} from '../render/timescale';
import { addDays, DAY_MS, startOfDay } from '../model/dates';
import { TaskGrid } from './grid';
import { Notice } from 'obsidian';
import {
  planCascade,
  planDrag,
  relTypeFor,
  type DragMode,
  type ReversiblePatch
} from '../model/reschedule';
import { computeSchedule, criticalEdges, violationsByTask } from '../model/schedule';
import { planConflictFixes, planCycleBreaks, type CycleBreak } from '../model/autofix';
import { computeCapacity, type CapacityResult } from '../model/capacity';
import { planLevellingRun } from '../model/levelling';
import { withProgress } from '../model/progress';
import {
  applyFilter,
  buildFacets,
  pruneFilter,
  type FacetDefinition
} from '../model/filter';
import {
  computeVariance,
  readBaseline,
  type Baseline,
  type BaselineFields,
  type Variance
} from '../model/baseline';
import type { CapacityRowData } from '../render/canvas';
import type { FullScheduleResult } from '../model/schedule';
import { wouldCreateCycle } from '../model/graph';
import type { GanttWriter } from '../bridge/writer';

/**
 * Owns chart state and drives the render loop.
 *
 * View-agnostic on purpose: both the Bases view and the standalone tab construct one
 * of these, so the chart behaves identically in each and there is a single place
 * where model output becomes pixels.
 */

export interface ControllerHost {
  app: App;
  settings: GanttSettings;
  /**
   * Read live, never captured.
   *
   * A view is constructed before the TaskNotes bridge has connected, so a catalog
   * snapshot taken here is the shipped defaults: no user fields, and every custom
   * status falling back to its raw value. The chart reloaded correctly afterwards and
   * the facet list did not, because it was still reading the object captured at
   * construction — a filter for the user's own field simply never appeared.
   */
  catalog: () => TaskNotesCatalog;
  /** Called when the user activates a row, to open the underlying note. */
  onOpenTask: (path: TaskPath) => void;
  /** Absent in a read-only context; editing gestures are then disabled. */
  writer?: GanttWriter;
  /** Called after a successful write so the view can refetch. */
  onChanged?: () => void;
  /** Called when a group is switched on or off, so the view can persist it. */
  onHiddenGroupsChanged?: (ids: string[]) => void;
}

/** An in-progress bar drag. */
interface DragState {
  path: TaskPath;
  rowIndex: number;
  mode: DragMode;
  originBar: Bar;
  startClientX: number;
  dayDelta: number;
  moved: boolean;
}

/** An in-progress dependency link. */
interface LinkState {
  fromPath: TaskPath;
  fromEnd: 'start' | 'finish';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  targetPath: TaskPath | null;
  targetEnd: 'start' | 'finish';
  valid: boolean;
}

export interface ChartData {
  tasks: GanttTask[];
  cycles: string[][];
}

export class GanttController {
  private rootEl: HTMLElement;
  private timelineEl: HTMLElement;
  private grid: TaskGrid;
  private canvas: HTMLCanvasElement;
  private scrollEl: HTMLElement;
  private spacerEl: HTMLElement;
  private liveRegion: HTMLElement;

  private tasks: GanttTask[] = [];
  private bars: Map<TaskPath, Bar> = new Map();
  private edges: Edge[] = [];
  private rows: Row[] = [];
  private cycles: string[][] = [];
  private collapsed = new Set<string>();
  private hiddenGroups = new Set<string>();
  /** Every task before filtering, so facet counts reflect the whole data set. */
  private unfiltered: GanttTask[] = [];
  private schedule: FullScheduleResult | null = null;
  private criticalEdgeSet: ReadonlySet<Edge> = new Set();
  private violationCounts: ReadonlyMap<TaskPath, number> = new Map();
  private loads: Map<string, CapacityRowData> = new Map();
  private capacity: CapacityResult | null = null;
  private baselines: Map<TaskPath, Baseline> = new Map();
  private variances: Map<TaskPath, Variance> = new Map();

  private scale: Timescale;
  private metrics: ChartMetrics;
  private hoveredId: string | null = null;
  private selectedIds = new Set<string>();
  private drag: DragState | null = null;
  private suppressClick = false;
  private link: LinkState | null = null;
  private adjacency = buildAdjacency([], []);
  private frame = 0;
  private disposed = false;

  constructor(
    private host: ControllerHost,
    private containerEl: HTMLElement
  ) {
    this.metrics = { ...DEFAULT_METRICS, rowHeight: host.settings.rowHeight };
    this.scale = createTimescale(startOfDay(Date.now()), host.settings.zoom);
    this.hiddenGroups = new Set(host.settings.hiddenGroups);

    // The chart gets its own absolutely-positioned wrapper rather than restyling the
    // host, which the host's own flex layout would fight.
    this.rootEl = containerEl.createDiv({ cls: 'tng-chart' });

    // Task names on the left, timeline on the right. The grid is what makes a bar
    // mean something, so it is part of the chart rather than an optional extra.
    this.grid = new TaskGrid(
      this.rootEl,
      {
        rowHeight: this.metrics.rowHeight,
        headerHeight: this.metrics.headerHeight,
        statuses: () => host.catalog().statuses,
        calendar: calendarFrom(host.settings),
        onToggleGroup: (id) => this.toggleGroup(id),
        onToggleGroupVisible: (id) => this.toggleGroupVisible(id),
        onSelect: (id) => this.select(id),
        onOpen: (id) => host.onOpenTask(id),
        onWheel: (event) => this.forwardWheel(event),
        onResize: () => this.requestRender(),
        floatDaysFor: (path) => this.floatDaysFor(path),
        loadFor: (id) => {
          const data = this.loads.get(id);
          if (!data) return null;
          return {
            peakMinutes: data.peakMinutes,
            capacity: data.capacity,
            overDays: [...data.days.values()].filter((m) => m > data.capacity).length
          };
        },
        showFloat: () => this.host.settings.showCriticalPath,
        varianceDaysFor: (path) => this.variances.get(path)?.endDays ?? null,
        showVariance: () => this.host.settings.showBaseline && this.baselines.size > 0
      },
      host.settings.gridWidth
    );

    this.timelineEl = this.rootEl.createDiv({ cls: 'tng-timeline' });
    this.canvas = this.timelineEl.createEl('canvas', { cls: 'tng-canvas' });

    // The scroll layer sits ON TOP of the canvas and owns both scrolling and pointer
    // input, so every interaction listener belongs here — a listener on the canvas
    // beneath it would never fire.
    this.scrollEl = this.timelineEl.createDiv({ cls: 'tng-scroll' });
    this.scrollEl.style.top = `${this.metrics.headerHeight}px`;
    this.spacerEl = this.scrollEl.createDiv({ cls: 'tng-spacer' });

    // An off-screen mirror of the visible rows. Canvas is invisible to screen readers,
    // so without this the chart would be entirely unusable with one.
    this.liveRegion = this.timelineEl.createDiv({ cls: 'tng-a11y' });
    this.liveRegion.setAttribute('role', 'grid');
    this.liveRegion.setAttribute('aria-label', 'Gantt chart rows');

    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
    this.scrollEl.addEventListener('pointerdown', this.onPointerDown);
    this.scrollEl.addEventListener('pointermove', this.onPointerMove);
    this.scrollEl.addEventListener('pointerup', this.onPointerUp);
    this.scrollEl.addEventListener('pointercancel', this.onPointerUp);
    this.scrollEl.addEventListener('pointerleave', this.onPointerLeave);
    this.scrollEl.addEventListener('dblclick', this.onDoubleClick);
    this.scrollEl.addEventListener('click', this.onClick);
    this.scrollEl.addEventListener('wheel', this.onWheel, { passive: false });
    this.scrollEl.addEventListener('keydown', this.onKeyDown);

    // Focusable so the chart can be reached and driven from the keyboard alone.
    this.scrollEl.tabIndex = 0;
    this.scrollEl.setAttribute('role', 'application');
    this.scrollEl.setAttribute('aria-label', 'Gantt chart. Use arrow keys to move between tasks.');

    // Vertical panning is the browser's; horizontal and pinch are ours, and without
    // this the page scrolls instead of the chart on a touch screen.
    this.scrollEl.style.touchAction = 'pan-y';
    this.scrollEl.addEventListener('touchstart', this.onTouchStart, { passive: true });
    this.scrollEl.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.scrollEl.addEventListener('touchend', this.onTouchEnd, { passive: true });
  }

  /** Index of the row the keyboard is on, or -1. */
  private focusedRow = -1;
  private pinchStartDistance = 0;
  private pinchStartPxPerDay = 0;

  /** Move keyboard focus, keeping it on screen. */
  private moveFocus(delta: number): void {
    if (this.rows.length === 0) return;
    const next = Math.min(
      this.rows.length - 1,
      Math.max(0, (this.focusedRow < 0 ? 0 : this.focusedRow + delta))
    );
    this.focusedRow = next;
    const row = this.rows[next];
    if (row) {
      this.select(row.id);
      if (row.bar) this.ensureRowVisible(next, row.bar);
    }
  }

  private ensureRowVisible(index: number, bar: Bar): void {
    const top = index * this.metrics.rowHeight;
    const viewTop = this.scrollEl.scrollTop;
    const viewBottom = viewTop + this.scrollEl.clientHeight;
    if (top < viewTop) this.scrollEl.scrollTop = top;
    else if (top + this.metrics.rowHeight > viewBottom) {
      this.scrollEl.scrollTop = top + this.metrics.rowHeight - this.scrollEl.clientHeight;
    }
    if (offscreenSide(bar, this.scale, this.scrollEl.scrollLeft, this.scrollEl.clientWidth)) {
      this.scrollToBar(bar);
    }
    this.requestRender();
  }

  /**
   * Keyboard equivalents for every pointer gesture.
   *
   * Canvas content cannot be reached with a pointer alone by everyone, and a chart that
   * can only be edited by dragging is a chart some people cannot edit at all.
   */
  private onKeyDown = (event: KeyboardEvent): void => {
    const row = this.focusedRow >= 0 ? this.rows[this.focusedRow] : null;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveFocus(this.focusedRow < 0 ? 0 : 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.moveFocus(-1);
        return;
      case 'Home':
        event.preventDefault();
        this.focusedRow = -1;
        this.moveFocus(0);
        return;
      case 'End':
        event.preventDefault();
        this.focusedRow = this.rows.length;
        this.moveFocus(-1);
        return;
      case 'Enter':
        if (row?.kind === 'task') {
          event.preventDefault();
          this.host.onOpenTask(row.id);
        } else if (row?.kind === 'group') {
          event.preventDefault();
          this.toggleGroup(row.id);
        }
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        // Plain arrows pan; with a modifier they move the focused task by a day.
        if (!event.shiftKey && !event.altKey) {
          event.preventDefault();
          this.scrollEl.scrollLeft += direction * this.scale.pxPerDay * 7;
          this.requestRender();
          return;
        }
        if (row?.kind !== 'task' || !row.bar || !this.canEdit) return;
        event.preventDefault();
        const mode: DragMode = event.altKey ? 'resize-end' : 'move';
        void this.commitDrag({
          path: row.id,
          rowIndex: this.focusedRow,
          mode,
          originBar: row.bar,
          startClientX: 0,
          dayDelta: direction,
          moved: true
        });
        return;
      }
      default:
        return;
    }
  };

  private onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    if (!a || !b) return;
    this.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchStartPxPerDay = this.scale.pxPerDay;
  };

  /** Pinch to zoom the timescale, which is the only natural gesture for it on touch. */
  private onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length !== 2 || this.pinchStartDistance === 0) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    if (!a || !b) return;
    event.preventDefault();
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const ratio = distance / this.pinchStartDistance;
    const pxPerDay = Math.min(120, Math.max(0.5, this.pinchStartPxPerDay * ratio));
    this.scale = { ...this.scale, pxPerDay };
    this.updateSpacer();
    this.requestRender();
  };

  private onTouchEnd = (): void => {
    this.pinchStartDistance = 0;
  };

  get zoom(): ZoomLevel {
    return this.scale.zoom;
  }

  get cycleReport(): string[][] {
    return this.cycles;
  }

  get taskCount(): number {
    return this.tasks.length;
  }

  private get geometry(): GeometryOptions {
    return {
      calendar: calendarFrom(this.host.settings),
      dueDateInclusive: this.host.settings.dueDateInclusive,
      defaultDurationMinutes: this.host.settings.defaultDurationMinutes,
      todayMs: Date.now()
    };
  }

  get baselineFields(): BaselineFields {
    return {
      start: this.host.settings.baselineStartField,
      end: this.host.settings.baselineEndField
    };
  }

  /** Variance against baseline for one task, or null when it has no baseline. */
  varianceFor(path: TaskPath): Variance | null {
    return this.variances.get(path) ?? null;
  }

  /** Every task currently loaded, for commands that act on the visible set. */
  get visibleTasks(): readonly GanttTask[] {
    return this.tasks;
  }

  get barsByPath(): ReadonlyMap<TaskPath, Bar> {
    return this.bars;
  }

  /**
   * A snapshot of everything an export needs.
   *
   * Exports draw from the same rows, bars and scale the canvas does, so what lands in
   * the file is what was on screen rather than a second, subtly different chart.
   */
  exportSnapshot(): {
    rows: readonly Row[];
    bars: ReadonlyMap<TaskPath, Bar>;
    edges: readonly Edge[];
    scale: Timescale;
    metrics: ChartMetrics;
    palette: ReturnType<typeof readPalette>;
    critical: ReadonlySet<TaskPath>;
    bounds: { startX: number; endX: number };
    scheduleFor: (path: TaskPath) => ScheduleNode | null;
    varianceFor: (path: TaskPath) => Variance | null;
  } {
    const span = boundsOf(this.bars.values(), 2);
    return {
      rows: this.rows,
      bars: this.bars,
      edges: this.edges,
      scale: this.scale,
      metrics: this.metrics,
      palette: readPalette(this.containerEl),
      critical: this.schedule?.critical ?? new Set(),
      bounds: span
        ? { startX: xOf(this.scale, span.startMs), endX: xOf(this.scale, span.endMs) }
        : { startX: 0, endX: this.timelineEl.clientWidth },
      scheduleFor: (path) => this.schedule?.nodes.get(path) ?? null,
      varianceFor: (path) => this.variances.get(path) ?? null
    };
  }

  /**
   * Read each task's baseline and compare it with where the task sits now.
   *
   * Kept out of the normalizer because baseline fields are this plugin's own: the
   * normalizer's job is to speak TaskNotes' vocabulary, not ours.
   */
  private rebuildBaselines(): void {
    const fields = this.baselineFields;
    const cal = calendarFrom(this.host.settings);
    this.baselines = new Map();
    this.variances = new Map();
    for (const task of this.tasks) {
      const baseline = readBaseline(task, fields);
      if (!baseline) continue;
      this.baselines.set(task.path, baseline);
      const bar = this.bars.get(task.path);
      if (bar) {
        this.variances.set(
          task.path,
          computeVariance(bar, baseline, cal, this.host.settings.dueDateInclusive)
        );
      }
    }
  }

  /** The facets available for the current vault and settings. */
  get facets(): FacetDefinition[] {
    return buildFacets(this.host.catalog(), this.host.settings.resourceField);
  }

  /** Every task before filtering, for facet counts. */
  get allTasks(): readonly GanttTask[] {
    return this.unfiltered;
  }

  /** Groups currently switched off. */
  get hidden(): ReadonlySet<string> {
    return this.hiddenGroups;
  }

  toggleGroupVisible(id: string): void {
    if (this.hiddenGroups.has(id)) this.hiddenGroups.delete(id);
    else this.hiddenGroups.add(id);
    this.host.onHiddenGroupsChanged?.([...this.hiddenGroups]);
    this.rebuildRows();
    this.updateSpacer();
    this.requestRender();
  }

  /**
   * Collapse every group, or expand every one.
   *
   * A single button rather than two: with two dozen projects the useful action is
   * always "the opposite of what I mostly have", and it is one click either way.
   */
  toggleAllGroups(): void {
    const groups = this.rows.filter((r) => r.kind === 'group').map((r) => r.id);
    const anyExpanded = groups.some((id) => !this.collapsed.has(id));
    this.collapsed = anyExpanded ? new Set(groups) : new Set();
    this.rebuildRows();
    this.updateSpacer();
    this.requestRender();
  }

  get allGroupsCollapsed(): boolean {
    const groups = this.rows.filter((r) => r.kind === 'group');
    return groups.length > 0 && groups.every((r) => this.collapsed.has(r.id));
  }

  /** Re-apply the filter to the data already loaded. */
  applyCurrentFilter(): void {
    this.setTasks([...this.unfiltered]);
  }

  /** Replace the data set and rebuild everything derived from it. */
  setTasks(tasks: GanttTask[]): void {
    this.unfiltered = tasks;
    // Filtering happens before progress and geometry so everything downstream — the
    // critical path, the load histogram, the exports — describes the visible set
    // rather than quietly including work the user has filtered away.
    const filter = pruneFilter(this.host.settings.filter, this.facets);
    const filtered = applyFilter(tasks, filter, this.facets);

    // Progress is resolved here rather than in the adapter so a change to the source
    // order takes effect without refetching the vault.
    this.tasks = withProgress(
      filtered,
      this.host.catalog().statuses,
      this.host.settings.progressOrder
    );
    tasks = this.tasks;
    this.bars = computeBars(tasks, this.geometry);
    this.rebuildBaselines();

    const built = buildEdges(tasks);
    this.edges = built.edges;

    const paths = tasks.map((t) => t.path);
    this.adjacency = buildAdjacency(paths, this.edges);
    this.cycles = detectCycles(paths, this.adjacency).map((c) => c.members);

    this.runSchedule();
    this.rebuildRows();
    this.fitScaleToData();
    this.requestRender();
  }

  /**
   * Re-read settings that affect layout without refetching data.
   *
   * The zoom is reconciled here too. Anything that changes `settings.zoom` without
   * going through `setZoom` would otherwise leave the toolbar and the ruler showing
   * different timescales.
   */
  refresh(): void {
    this.metrics = { ...this.metrics, rowHeight: this.host.settings.rowHeight };
    if (this.host.settings.zoom !== this.scale.zoom) {
      this.scale = createTimescale(this.scale.originMs, this.host.settings.zoom);
    }
    this.tasks = withProgress(
      this.tasks,
      this.host.catalog().statuses,
      this.host.settings.progressOrder
    );
    this.bars = computeBars(this.tasks, this.geometry);
    this.rebuildBaselines();
    this.runSchedule();
    this.rebuildRows();
    this.updateSpacer();
    this.requestRender();
  }

  private rebuildRows(): void {
    const settings = this.host.settings;
    const catalog = this.host.catalog();
    const priorityWeight = (value: string) =>
      catalog.priorities.find((p) => p.value === value)?.weight ?? 0;
    const statusOrder = (value: string) =>
      catalog.statuses.find((s) => s.value === value)?.order ?? Number.MAX_SAFE_INTEGER;

    const compare = makeComparator(settings.sortKey, this.bars, priorityWeight, statusOrder);
    const result = buildRows(
      this.tasks,
      this.bars,
      {
        groupBy: settings.groupBy,
        resourceField: settings.resourceField,
        collapsed: this.collapsed,
        hidden: this.hiddenGroups,
        showCompleted: settings.showCompleted,
        showArchived: settings.showArchived,
        showCapacity: settings.showCapacity
      },
      compare
    );
    this.rows = result.rows;
    this.rebuildLoads();
    this.grid.setRows(this.rows);
    this.updateAccessibleRows();
  }

  /**
   * Run the critical path analysis.
   *
   * Recomputed in full on every data change: it is O(V+E), which at these sizes is
   * microseconds, and an incremental version would be a source of subtle staleness
   * for no measurable gain.
   */
  private runSchedule(): void {
    const result = computeSchedule({
      bars: this.bars,
      edges: this.edges,
      calendar: calendarFrom(this.host.settings),
      labelFor: (path) => this.tasks.find((t) => t.path === path)?.title ?? path
    });
    this.schedule = result;
    this.criticalEdgeSet = criticalEdges(this.edges, result.critical);

    const byTask = violationsByTask(result.violations);
    const counts = new Map<TaskPath, number>();
    for (const [path, list] of byTask) {
      counts.set(path, list.reduce((max, v) => Math.max(max, v.overlapMinutes), 0));
    }
    this.violationCounts = counts;
  }

  get scheduleResult(): FullScheduleResult | null {
    return this.schedule;
  }

  get capacityResult(): CapacityResult | null {
    return this.capacity;
  }

  private get excludedByCycle(): Set<TaskPath> {
    const excluded = new Set<TaskPath>();
    for (const cycle of this.cycles) for (const member of cycle) excluded.add(member);
    return excluded;
  }

  private label(path: TaskPath): string {
    return this.tasks.find((t) => t.path === path)?.title ?? path;
  }

  /**
   * Push every task that starts before a dependency allows.
   *
   * Offered rather than applied automatically. It moves real dates in real notes, so
   * it goes through the ordinary write gates: safe mode blocks it, anything above the
   * confirmation threshold lists every edit first, and one undo reverses the lot.
   */
  async fixConflicts(): Promise<void> {
    const writer = this.host.writer;
    if (!writer) return;

    const patches = planConflictFixes({
      tasks: new Map(this.tasks.map((t) => [t.path, t])),
      bars: this.bars,
      adjacency: this.adjacency,
      calendar: calendarFrom(this.host.settings),
      excluded: this.excludedByCycle
    });

    if (patches.length === 0) {
      new Notice('TaskNotes Gantt: nothing to reschedule.');
      return;
    }

    const result = await writer.apply(patches, {
      label: `Reschedule ${patches.length} task${patches.length === 1 ? '' : 's'} to respect dependencies`
    });
    if (result.written > 0) {
      new Notice(`TaskNotes Gantt: rescheduled ${result.written} tasks.`);
      this.host.onChanged?.();
    }
  }

  /**
   * Push work off the days a resource cannot absorb.
   *
   * Push-only, and dependency-safe: it keeps the plan as authored and resolves only
   * the overload, restoring dependency order after every levelling round. Like
   * `fixConflicts`, it is offered rather than applied automatically, and goes through
   * the ordinary write gates — safe mode, the confirmation threshold, one undo.
   */
  async levelResources(): Promise<void> {
    const writer = this.host.writer;
    if (!writer) return;

    const settings = this.host.settings;
    const field = settings.resourceField;
    const run = planLevellingRun(this.tasks, this.bars, {
      calendar: calendarFrom(settings),
      resourceField: field,
      defaultCapacityMinutes: settings.defaultCapacityMinutesPerDay,
      capacityOverrides: settings.capacityOverrides,
      includeCompleted: false,
      priorityWeight: (task) =>
        this.host.catalog().priorities.find((p) => p.value === task.priority)?.weight ?? 0,
      floatMinutes: (path) => this.schedule?.nodes.get(path)?.totalFloat ?? null,
      maxPushDays: 60,
      adjacency: this.adjacency,
      excluded: this.excludedByCycle
    });

    // Levelling against a field nobody fills in silently does nothing: every task
    // lands in the unassigned lane, which is deliberately unlimited. Saying so names
    // the setting that would fix it.
    if (run.lanes === 0) {
      new Notice(
        `TaskNotes Gantt: nothing to level. No visible task has a value for "${field}", ` +
          'so there is no resource to be over capacity. Change the resource field in settings.'
      );
      return;
    }

    if (run.patches.length === 0) {
      new Notice('TaskNotes Gantt: no resource is over capacity.');
      return;
    }

    const result = await writer.apply(run.patches, {
      label: `Level ${run.patches.length} task${run.patches.length === 1 ? '' : 's'} across ${run.lanes} resource${run.lanes === 1 ? '' : 's'}`
    });
    if (result.written === 0) return;

    const settled = run.settled
      ? ''
      : ` ${run.remaining} still sit on an over-capacity day after ${run.rounds} rounds.`;
    new Notice(`TaskNotes Gantt: levelled ${result.written} tasks.${settled}`);
    this.host.onChanged?.();
  }

  /** Whether any resource is over capacity, so a view can offer to level. */
  get overloadedDays(): number {
    let days = 0;
    for (const lane of this.capacity?.resources.values() ?? []) {
      if (!lane.unlimited) days += lane.overloadedDays;
    }
    return days;
  }

  /** The dependency removals that would break every cycle, for preview. */
  proposedCycleBreaks(): CycleBreak[] {
    const cycles = (this.schedule?.cycles ?? []).map((c) => c);
    return planCycleBreaks(cycles, this.edges, this.bars, (path) => this.label(path));
  }

  /**
   * Remove one dependency from each cycle.
   *
   * Deleting a dependency destroys a statement about the work, which no heuristic
   * should do unasked — so this always confirms, whatever the threshold, and names
   * exactly which entry goes.
   */
  async breakCycles(confirm: (label: string, lines: string[]) => Promise<boolean>): Promise<void> {
    const writer = this.host.writer;
    if (!writer) return;

    const breaks = this.proposedCycleBreaks();
    if (breaks.length === 0) {
      new Notice('TaskNotes Gantt: no circular dependencies to break.');
      return;
    }

    const blocked = writer.blockedReason();
    if (blocked !== null) {
      new Notice(`TaskNotes Gantt: ${blocked}`);
      return;
    }

    const approved = await confirm(
      `Remove ${breaks.length} dependenc${breaks.length === 1 ? 'y' : 'ies'} to break ${
        breaks.length === 1 ? 'a circular chain' : 'circular chains'
      }`,
      breaks.map((b) => b.description)
    );
    if (!approved) return;

    let removed = 0;
    for (const item of breaks) {
      if (await writer.removeDependency(item.successor, item.uid)) removed += 1;
    }

    if (removed === 0) {
      // Silence here would look like success while the banner stayed put.
      new Notice('TaskNotes Gantt: no dependency could be removed.', 8000);
      return;
    }
    new Notice(
      `TaskNotes Gantt: removed ${removed} dependenc${removed === 1 ? 'y' : 'ies'}.`
    );
    this.host.onChanged?.();
  }

  /**
   * Build one histogram per capacity row, from that row's own members.
   *
   * Computed per group rather than globally so the numbers match the rows above them:
   * a task in two projects contributes to both, which is what each project's plan
   * actually needs from it.
   */
  private rebuildLoads(): void {
    const settings = this.host.settings;
    this.loads = new Map();
    if (!settings.showCapacity) {
      this.capacity = null;
      return;
    }

    const shared = {
      calendar: calendarFrom(settings),
      resourceField: settings.resourceField,
      defaultCapacityMinutes: settings.defaultCapacityMinutesPerDay,
      capacityOverrides: settings.capacityOverrides,
      includeCompleted: false
    };

    // A whole-data-set pass, for the coverage banner.
    this.capacity = computeCapacity(this.tasks, this.bars, shared);

    for (const row of this.rows) {
      if (row.kind !== 'capacity' || !row.members) continue;
      const groupKey = row.id.slice('capacity:'.length);
      const override = settings.capacityOverrides[groupKey];
      const result = computeCapacity(row.members, this.bars, {
        ...shared,
        // The group itself is the lane here, so every member counts toward one total.
        resourceField: '\u0000none',
        capacityOverrides: override === undefined ? {} : { '': override }
      });
      const lane = result.resources.values().next().value;
      if (!lane) continue;

      const days = new Map<number, number>();
      for (const [dayMs, load] of lane.days) days.set(dayMs, load.minutes);
      this.loads.set(row.id, {
        days,
        capacity: override ?? settings.defaultCapacityMinutesPerDay,
        peakMinutes: lane.peakMinutes
      });
    }
  }

  /** Total float in working days, for the grid column. */
  floatDaysFor(path: TaskPath): number | null {
    const node = this.schedule?.nodes.get(path);
    if (!node) return null;
    const perDay = this.host.settings.dayEndMinutes - this.host.settings.dayStartMinutes;
    return perDay > 0 ? node.totalFloat / perDay : null;
  }

  /** Choose an origin and width that put the whole plan on screen. */
  private fitScaleToData(): void {
    const bounds = boundsOf(this.bars.values(), 3);
    if (!bounds) return;
    this.scale = createTimescale(bounds.startMs, this.scale.zoom, this.scale.pxPerDay);
    this.updateSpacer();
  }

  private updateSpacer(): void {
    const bounds = boundsOf(this.bars.values(), 3);
    const width = bounds ? xOf(this.scale, bounds.endMs) : this.containerEl.clientWidth;
    this.spacerEl.style.width = `${Math.max(width, this.timelineEl.clientWidth)}px`;
    this.spacerEl.style.height = `${this.rows.length * this.metrics.rowHeight}px`;
  }

  setZoom(zoom: ZoomLevel): void {
    // Keep the instant at the viewport's left edge fixed, so zooming does not throw
    // the user to an unrelated part of the timeline.
    const anchorMs = msOf(this.scale, this.scrollEl.scrollLeft);
    this.scale = createTimescale(this.scale.originMs, zoom);
    this.host.settings.zoom = zoom;
    this.updateSpacer();
    this.scrollEl.scrollLeft = Math.max(0, xOf(this.scale, anchorMs));
    this.requestRender();
  }

  zoomIn(): void {
    this.setZoom(zoomIn(this.scale.zoom));
  }

  zoomOut(): void {
    this.setZoom(zoomOut(this.scale.zoom));
  }

  /** Scroll so that today is visible. */
  scrollToToday(): void {
    const x = xOf(this.scale, Date.now());
    this.scrollEl.scrollLeft = Math.max(0, x - this.scrollEl.clientWidth / 3);
    this.requestRender();
  }

  toggleGroup(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.rebuildRows();
    this.updateSpacer();
    this.requestRender();
  }

  private rowAt(clientY: number): { row: Row; index: number } | null {
    const rect = this.scrollEl.getBoundingClientRect();
    const y = clientY - rect.top + this.scrollEl.scrollTop;
    if (y < 0) return null;
    const index = Math.floor(y / this.metrics.rowHeight);
    const row = this.rows[index];
    return row ? { row, index } : null;
  }

  private onScroll = (): void => {
    this.grid.setScrollTop(this.scrollEl.scrollTop);
    this.requestRender();
  };

  /** A wheel gesture over the grid scrolls the chart, keeping the panes locked. */
  private forwardWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      if (event.deltaY < 0) this.zoomIn();
      else this.zoomOut();
      return;
    }
    event.preventDefault();
    this.scrollEl.scrollTop += event.deltaY;
    this.scrollEl.scrollLeft += event.deltaX;
  }

  private select(id: string): void {
    this.selectedIds.clear();
    this.selectedIds.add(id);
    this.grid.setSelected(id);
    this.requestRender();
  }

  /** Timeline x coordinate for a pointer event, in chart space. */
  private timelineX(clientX: number): number {
    const rect = this.scrollEl.getBoundingClientRect();
    return clientX - rect.left + this.scrollEl.scrollLeft;
  }

  /** Which row and which part of its bar the pointer is over. */
  private hitTest(
    clientX: number,
    clientY: number
  ): { row: Row; index: number; zone: HitZone | null } | null {
    const hit = this.rowAt(clientY);
    if (!hit) return null;
    const bar = hit.row.bar;
    const zone = bar ? hitZone(bar, this.scale, this.timelineX(clientX)) : null;
    return { ...hit, zone };
  }

  /**
   * The off-screen marker under the pointer, if any.
   *
   * Only the edge strips respond, so a click in the body of the row still selects the
   * task rather than jumping the viewport.
   */
  private offscreenHit(
    clientX: number,
    clientY: number
  ): { row: Row; side: 'left' | 'right' } | null {
    const hit = this.rowAt(clientY);
    const bar = hit?.row.bar;
    if (!hit || !bar || hit.row.kind === 'capacity') return null;

    const rect = this.scrollEl.getBoundingClientRect();
    const width = this.scrollEl.clientWidth;
    const side = offscreenSide(bar, this.scale, this.scrollEl.scrollLeft, width);
    if (side === null) return null;

    const x = clientX - rect.left;
    const inZone = side === 'left' ? x <= OFFSCREEN_ZONE : x >= width - OFFSCREEN_ZONE;
    return inZone ? { row: hit.row, side } : null;
  }

  /** Scroll horizontally until a bar is comfortably in view. */
  private scrollToBar(bar: Bar): void {
    const width = this.scrollEl.clientWidth;
    const barWidth = xOf(this.scale, bar.displayEndMs) - xOf(this.scale, bar.displayStartMs);
    // Centre it when it fits, otherwise show its start with a margin.
    const target =
      barWidth < width * 0.8
        ? xOf(this.scale, bar.displayStartMs) - (width - barWidth) / 2
        : xOf(this.scale, bar.displayStartMs) - width * 0.1;
    this.scrollEl.scrollLeft = Math.max(0, target);
    this.requestRender();
  }

  private get canEdit(): boolean {
    return this.host.writer !== undefined && this.host.writer.blockedReason() === null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    // The marker strips take precedence over dragging, so a bar that happens to end
    // under one cannot be grabbed by accident.
    if (this.offscreenHit(event.clientX, event.clientY)) return;
    const hit = this.hitTest(event.clientX, event.clientY);
    if (!hit || hit.row.kind !== 'task' || !hit.row.bar || hit.zone === null) return;
    if (!this.canEdit) return;

    this.scrollEl.setPointerCapture(event.pointerId);

    // Shift turns a drag into a dependency link rather than a reschedule. The end you
    // start from picks the first half of the relation type.
    if (event.shiftKey) {
      const rect = barRect(hit.row.bar, hit.index, this.scale, this.metrics);
      const fromEnd = hit.zone === 'start' ? 'start' : 'finish';
      const fromX = fromEnd === 'start' ? rect.x : rect.x + rect.width;
      this.link = {
        fromPath: hit.row.id,
        fromEnd,
        fromX,
        fromY: rect.y + rect.height / 2,
        toX: fromX,
        toY: rect.y + rect.height / 2,
        targetPath: null,
        targetEnd: 'start',
        valid: false
      };
      event.preventDefault();
      return;
    }

    const mode: DragMode =
      hit.zone === 'start' ? 'resize-start' : hit.zone === 'end' ? 'resize-end' : 'move';
    this.drag = {
      path: hit.row.id,
      rowIndex: hit.index,
      mode,
      originBar: hit.row.bar,
      startClientX: event.clientX,
      dayDelta: 0,
      moved: false
    };
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      const deltaPx = event.clientX - this.drag.startClientX;
      // Snap to whole days: every date in the vault is all-day, so a sub-day drag has
      // nothing to express.
      const dayDelta = Math.round(deltaPx / this.scale.pxPerDay);
      if (dayDelta !== this.drag.dayDelta) {
        this.drag.dayDelta = dayDelta;
        this.drag.moved = this.drag.moved || dayDelta !== 0;
        this.requestRender();
      }
      return;
    }

    if (this.link) {
      const rect = this.scrollEl.getBoundingClientRect();
      this.link.toX = this.timelineX(event.clientX);
      this.link.toY = event.clientY - rect.top + this.scrollEl.scrollTop;

      const hit = this.hitTest(event.clientX, event.clientY);
      const targetPath =
        hit && hit.row.kind === 'task' && hit.zone !== null ? hit.row.id : null;
      this.link.targetPath = targetPath;
      this.link.targetEnd = hit?.zone === 'end' ? 'finish' : 'start';
      this.link.valid =
        targetPath !== null &&
        targetPath !== this.link.fromPath &&
        !wouldCreateCycle(this.link.fromPath, targetPath, this.adjacency);
      this.requestRender();
      return;
    }

    const marker = this.offscreenHit(event.clientX, event.clientY);
    if (marker) {
      this.scrollEl.style.cursor = 'pointer';
      this.scrollEl.title = `${marker.row.label} — off screen to the ${marker.side}. Click to scroll to it.`;
      if (marker.row.id !== this.hoveredId) {
        this.hoveredId = marker.row.id;
        this.grid.setHovered(marker.row.id);
        this.requestRender();
      }
      return;
    }

    const hit = this.hitTest(event.clientX, event.clientY);
    const id = hit?.row.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.grid.setHovered(id);
      this.requestRender();
    }
    this.scrollEl.style.cursor = this.cursorFor(hit, event.shiftKey);
    this.scrollEl.title = hit ? this.describeRow(hit.row) : '';
  };

  private cursorFor(
    hit: { row: Row; zone: HitZone | null } | null,
    shift: boolean
  ): string {
    if (!hit) return 'default';
    if (hit.row.kind === 'group') return 'pointer';
    if (hit.zone === null || !this.canEdit) return 'pointer';
    if (shift) return 'crosshair';
    if (hit.zone === 'start' || hit.zone === 'end') return 'ew-resize';
    return 'grab';
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.scrollEl.hasPointerCapture(event.pointerId)) {
      this.scrollEl.releasePointerCapture(event.pointerId);
    }

    const drag = this.drag;
    const link = this.link;
    this.drag = null;
    this.link = null;

    if (drag) {
      this.suppressClick = drag.moved;
      if (drag.moved) void this.commitDrag(drag);
      else this.select(drag.path);
      this.requestRender();
      return;
    }

    if (link) {
      this.suppressClick = true;
      if (link.valid && link.targetPath !== null) void this.commitLink(link);
      this.requestRender();
    }
  };

  private async commitDrag(drag: DragState): Promise<void> {
    const writer = this.host.writer;
    const task = this.tasks.find((t) => t.path === drag.path);
    if (!writer || !task) return;

    const planned = planDrag(task, drag.originBar, drag.mode, drag.dayDelta);
    if (!planned) return;

    const label =
      drag.mode === 'move' ? `Reschedule ${task.title}` : `Resize ${task.title}`;

    // Cascade pushes successors that the move would otherwise contradict. It is opt-in
    // because it can rewrite many notes from one gesture; the writer's threshold then
    // shows exactly which.
    let patches: ReversiblePatch[] = [planned];
    if (this.host.settings.cascadeDependents) {
      const taskMap = new Map(this.tasks.map((t) => [t.path, t]));
      const excluded = new Set<TaskPath>();
      for (const cycle of this.cycles) for (const member of cycle) excluded.add(member);
      patches = planCascade(planned, {
        tasks: taskMap,
        bars: this.bars,
        adjacency: this.adjacency,
        calendar: calendarFrom(this.host.settings),
        excluded
      });
    }

    const result = await writer.apply(patches, {
      label: patches.length > 1 ? `${label} and ${patches.length - 1} dependent` : label
    });
    if (result.written > 0) this.host.onChanged?.();
  }

  private async commitLink(link: LinkState): Promise<void> {
    const writer = this.host.writer;
    if (!writer || link.targetPath === null) return;
    // The bar you drag FROM is the predecessor; the one you drop ON is blocked by it.
    const reltype = relTypeFor(link.fromEnd, link.targetEnd);
    const ok = await writer.addDependency(link.targetPath, link.fromPath, reltype);
    if (ok) this.host.onChanged?.();
  }

  private onPointerLeave = (): void => {
    if (this.hoveredId === null) return;
    this.hoveredId = null;
    this.grid.setHovered(null);
    this.requestRender();
  };

  private onClick = (event: MouseEvent): void => {
    // The pointer handlers already resolved a drag or link; a synthesized click on
    // top of that would re-select or toggle a group the user never aimed at.
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const marker = this.offscreenHit(event.clientX, event.clientY);
    if (marker?.row.bar) {
      this.scrollToBar(marker.row.bar);
      this.select(marker.row.id);
      return;
    }

    const hit = this.rowAt(event.clientY);
    if (!hit) return;
    if (hit.row.kind === 'capacity') return;
    if (hit.row.kind === 'group') {
      this.toggleGroup(hit.row.id);
      return;
    }
    this.select(hit.row.id);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const hit = this.rowAt(event.clientY);
    if (hit?.row.kind === 'task') this.host.onOpenTask(hit.row.id);
  };

  private onWheel = (event: WheelEvent): void => {
    // Only hijack the wheel when a modifier is held, so ordinary scrolling still works.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY < 0) this.zoomIn();
    else this.zoomOut();
  };

  private describeRow(row: Row): string {
    if (row.kind === 'capacity') {
      const data = this.loads.get(row.id);
      if (!data) return row.label;
      const hours = (m: number) => `${(m / 60).toFixed(1)}h`;
      const over = [...data.days.values()].filter((m) => m > data.capacity).length;
      return `${row.label} — peak ${hours(data.peakMinutes)}/day, capacity ${hours(
        data.capacity
      )}/day${over > 0 ? `, over on ${over} day${over === 1 ? '' : 's'}` : ''}`;
    }
    if (row.kind === 'group') {
      const suffix = row.unresolved ? ' (unresolved project)' : '';
      return `${row.label} — ${row.count ?? 0} tasks${suffix}`;
    }
    const bar = row.bar;
    if (!bar) return row.label;
    const fmt = (ms: number) => new Date(ms).toLocaleDateString();
    const kind =
      bar.kind === 'planned'
        ? ''
        : bar.kind === 'milestone'
          ? ' (milestone)'
          : bar.kind === 'invalid'
            ? ` (${bar.problem ?? 'invalid dates'})`
            : ' (inferred)';
    const base =
      bar.kind === 'milestone'
        ? `${row.label} — ${fmt(bar.startMs)}${kind}`
        : `${row.label} — ${fmt(bar.startMs)} to ${fmt(bar.endMs)}${kind}`;

    const extras: string[] = [];

    // Announced as well as drawn: a screen-reader user gets the same "there is
    // something here you cannot see" cue the marker gives everyone else.
    const side = offscreenSide(bar, this.scale, this.scrollEl.scrollLeft, this.scrollEl.clientWidth);
    if (side !== null) extras.push(`Off screen to the ${side}`);

    const node = this.schedule?.nodes.get(row.id);
    if (node && this.host.settings.showCriticalPath) {
      const days = this.floatDaysFor(row.id);
      extras.push(
        node.critical
          ? 'On the critical path'
          : `Float: ${days === null ? '?' : days.toFixed(1)} days`
      );
    }
    const variance = this.variances.get(row.id);
    if (variance) {
      const days = Math.abs(variance.endDays).toFixed(1);
      extras.push(
        variance.slipped
          ? `${days} working days later than baseline`
          : variance.endDays < -0.5
            ? `${days} working days ahead of baseline`
            : 'On baseline'
      );
    }

    const violations = this.schedule?.violations.filter((v) => v.edge.to === row.id) ?? [];
    for (const violation of violations) extras.push(violation.message);

    return extras.length > 0 ? `${base}\n${extras.join('\n')}` : base;
  }

  /**
   * Mirror the visible rows into the DOM for assistive technology.
   *
   * Only the visible slice is mirrored, so the cost stays constant no matter how many
   * tasks the chart holds.
   */
  private updateAccessibleRows(): void {
    const slice = visibleRows(this.rows.length, {
      scrollTop: this.scrollEl.scrollTop,
      height: this.scrollEl.clientHeight,
      rowHeight: this.metrics.rowHeight
    });

    this.liveRegion.empty();
    for (let i = slice.start; i < slice.end; i += 1) {
      const row = this.rows[i];
      if (!row) continue;
      const el = this.liveRegion.createDiv({ cls: 'tng-a11y-row' });
      el.setAttribute('role', 'row');
      el.setAttribute('aria-rowindex', String(i + 1));
      el.tabIndex = -1;
      el.setText(this.describeRow(row));
    }
  }

  requestRender(): void {
    if (this.disposed || this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /**
   * Shift a bar by whole days for the drag preview.
   *
   * Only the drawn extents move; the logical instants are recomputed properly from
   * the written dates once the drag commits.
   */
  private previewBar(bar: Bar, mode: DragMode, dayDelta: number): Bar {
    const shift = (ms: number) => addDays(ms, dayDelta);
    if (mode === 'move') {
      return {
        ...bar,
        startMs: shift(bar.startMs),
        endMs: shift(bar.endMs),
        displayStartMs: shift(bar.displayStartMs),
        displayEndMs: shift(bar.displayEndMs)
      };
    }
    if (mode === 'resize-start') {
      // Never let the start cross the end; a same-day span is the floor.
      const displayStartMs = Math.min(shift(bar.displayStartMs), bar.displayEndMs - DAY_MS);
      return { ...bar, startMs: shift(bar.startMs), displayStartMs };
    }
    const displayEndMs = Math.max(shift(bar.displayEndMs), bar.displayStartMs + DAY_MS);
    return { ...bar, endMs: shift(bar.endMs), displayEndMs };
  }

  /** The row list to draw: the live one, or a copy with the dragged bar previewed. */
  private rowsForRender(): readonly Row[] {
    const drag = this.drag;
    if (!drag || drag.dayDelta === 0) return this.rows;
    const rows = [...this.rows];
    const row = rows[drag.rowIndex];
    if (row?.bar) {
      rows[drag.rowIndex] = {
        ...row,
        bar: this.previewBar(drag.originBar, drag.mode, drag.dayDelta)
      };
    }
    return rows;
  }

  private render(): void {
    const width = this.timelineEl.clientWidth;
    const height = this.timelineEl.clientHeight;
    if (width === 0 || height === 0) return;

    const ctx = prepareCanvas(this.canvas, width, height);
    if (!ctx) return;

    renderChart(ctx, {
      rows: this.rowsForRender(),
      edges: this.edges,
      scale: this.scale,
      palette: readPalette(this.containerEl),
      metrics: this.metrics,
      statuses: this.host.catalog().statuses,
      viewport: {
        scrollTop: this.scrollEl.scrollTop,
        height: Math.max(0, height - this.metrics.headerHeight),
        rowHeight: this.metrics.rowHeight
      },
      scrollLeft: this.scrollEl.scrollLeft,
      width,
      height,
      todayMs: Date.now(),
      hoveredId: this.hoveredId,
      selectedIds: this.selectedIds,
      showDependencies: this.host.settings.showDependencies,
      showArrowheads: this.host.settings.showArrowheads,
      critical: this.host.settings.showCriticalPath
        ? (this.schedule?.critical ?? new Set())
        : new Set(),
      criticalEdges: this.host.settings.showCriticalPath ? this.criticalEdgeSet : new Set(),
      violations: this.host.settings.showViolations ? this.violationCounts : new Map(),
      loads: this.loads,
      baselines: this.host.settings.showBaseline ? this.baselines : new Map(),
      linkLine: this.link
        ? {
            fromX: this.link.fromX,
            fromY: this.link.fromY,
            toX: this.link.toX,
            toY: this.link.toY,
            valid: this.link.valid
          }
        : null
    });

    this.grid.render();
    this.updateAccessibleRows();
  }

  /** Screen rectangle of a bar, for the interaction layer added in Phase 2. */
  rectFor(path: TaskPath): { x: number; width: number; y: number; height: number } | null {
    const index = this.rows.findIndex((r) => r.id === path);
    const bar = this.rows[index]?.bar;
    if (index < 0 || !bar) return null;
    return barRect(bar, index, this.scale, this.metrics);
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.scrollEl.removeEventListener('pointerdown', this.onPointerDown);
    this.scrollEl.removeEventListener('pointermove', this.onPointerMove);
    this.scrollEl.removeEventListener('pointerup', this.onPointerUp);
    this.scrollEl.removeEventListener('pointercancel', this.onPointerUp);
    this.scrollEl.removeEventListener('pointerleave', this.onPointerLeave);
    this.scrollEl.removeEventListener('dblclick', this.onDoubleClick);
    this.scrollEl.removeEventListener('click', this.onClick);
    this.scrollEl.removeEventListener('wheel', this.onWheel);
    this.scrollEl.removeEventListener('keydown', this.onKeyDown);
    this.scrollEl.removeEventListener('touchstart', this.onTouchStart);
    this.scrollEl.removeEventListener('touchmove', this.onTouchMove);
    this.scrollEl.removeEventListener('touchend', this.onTouchEnd);
    this.grid.dispose();
    this.rootEl.remove();
  }
}
