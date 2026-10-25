import { setIcon } from 'obsidian';
import type { StatusDef } from '../types';
import type { Row } from '../render/layout';
import { visibleRows } from '../render/layout';
import { barDurationDays } from '../model/geometry';
import type { WorkingCalendar } from '../model/calendar';

/**
 * The task list beside the chart.
 *
 * Without it a Gantt is just coloured rectangles — the names are what make a bar mean
 * something. Rows are virtualized in step with the canvas and share its row height
 * exactly, so the two panes stay aligned at any scroll position.
 */

export interface GridHost {
  rowHeight: number;
  headerHeight: number;
  statuses: () => readonly StatusDef[];
  calendar: WorkingCalendar;
  onToggleGroup: (id: string) => void;
  /** Switch a whole group's tasks in or out of the chart. */
  onToggleGroupVisible: (id: string) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  /** Forward a wheel gesture over the grid to the chart's scroller. */
  onWheel: (event: WheelEvent) => void;
  onResize: (width: number) => void;
  /** Total float in working days, or null when the schedule has no answer. */
  floatDaysFor: (path: string) => number | null;
  /** Peak and capacity for a capacity row, in working minutes per day. */
  loadFor: (id: string) => { peakMinutes: number; capacity: number; overDays: number } | null;
  /** Working days moved against baseline, or null when the task has no baseline. */
  varianceDaysFor: (path: string) => number | null;
  /** Whether the variance column is shown at all. */
  showVariance: () => boolean;
  /** Whether the float column is shown at all. */
  showFloat: () => boolean;
}

const MIN_WIDTH = 160;
const MAX_WIDTH = 720;

function formatDate(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
}

export class TaskGrid {
  private rootEl: HTMLElement;
  private headerEl: HTMLElement;
  private viewportEl: HTMLElement;
  private rowsEl: HTMLElement;
  private splitterEl: HTMLElement;

  private rows: readonly Row[] = [];
  private scrollTop = 0;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private width: number;

  constructor(
    containerEl: HTMLElement,
    private host: GridHost,
    initialWidth: number
  ) {
    this.width = Math.min(Math.max(initialWidth, MIN_WIDTH), MAX_WIDTH);

    this.rootEl = containerEl.createDiv({ cls: 'tng-grid' });
    this.rootEl.style.width = `${this.width}px`;

    this.headerEl = this.rootEl.createDiv({ cls: 'tng-grid-header' });
    this.headerEl.style.height = `${host.headerHeight}px`;
    this.renderHeader();

    // Clipped rather than scrollable: the chart's scroller is the single source of
    // truth for vertical position, and two independent scrollers would drift apart.
    this.viewportEl = this.rootEl.createDiv({ cls: 'tng-grid-viewport' });
    this.rowsEl = this.viewportEl.createDiv({ cls: 'tng-grid-rows' });

    this.splitterEl = containerEl.createDiv({ cls: 'tng-splitter' });
    this.splitterEl.setAttribute('role', 'separator');
    this.splitterEl.setAttribute('aria-orientation', 'vertical');

    this.viewportEl.addEventListener('wheel', this.onWheel, { passive: false });
    this.splitterEl.addEventListener('pointerdown', this.onSplitterDown);
  }

  private renderHeader(): void {
    this.headerEl.empty();
    this.headerEl.createDiv({ cls: 'tng-grid-cell tng-grid-name', text: 'Task' });
    this.headerEl.createDiv({ cls: 'tng-grid-cell tng-grid-date', text: 'Start' });
    this.headerEl.createDiv({ cls: 'tng-grid-cell tng-grid-date', text: 'End' });
    if (this.host.showFloat()) {
      const floatCell = this.headerEl.createDiv({
        cls: 'tng-grid-cell tng-grid-float',
        text: 'Float'
      });
      floatCell.title = 'Working days this task can slip before it delays the project end';
    }
    if (this.host.showVariance()) {
      const cell = this.headerEl.createDiv({
        cls: 'tng-grid-cell tng-grid-float',
        text: 'Δ'
      });
      cell.title = 'Working days later (+) or earlier (−) than the baseline';
    }
  }

  get widthPx(): number {
    return this.width;
  }

  setRows(rows: readonly Row[]): void {
    this.rows = rows;
    this.renderHeader();
    this.render();
  }

  setScrollTop(scrollTop: number): void {
    if (scrollTop === this.scrollTop) return;
    this.scrollTop = scrollTop;
    this.render();
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.render();
  }

  setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.render();
  }

  private onWheel = (event: WheelEvent): void => {
    this.host.onWheel(event);
  };

  private onSplitterDown = (event: PointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.width;
    this.splitterEl.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const next = Math.min(Math.max(startWidth + (e.clientX - startX), MIN_WIDTH), MAX_WIDTH);
      this.width = next;
      this.rootEl.style.width = `${next}px`;
      this.host.onResize(next);
    };
    const up = (e: PointerEvent) => {
      this.splitterEl.releasePointerCapture(e.pointerId);
      this.splitterEl.removeEventListener('pointermove', move);
      this.splitterEl.removeEventListener('pointerup', up);
    };

    this.splitterEl.addEventListener('pointermove', move);
    this.splitterEl.addEventListener('pointerup', up);
  };

  private statusColor(value: string): string {
    return this.host.statuses().find((s) => s.value === value)?.color ?? 'var(--text-faint)';
  }

  /** Rebuild only the rows the viewport can show. */
  render(): void {
    const { rowHeight } = this.host;
    const height = this.viewportEl.clientHeight;
    const slice = visibleRows(this.rows.length, { scrollTop: this.scrollTop, height, rowHeight });

    this.rowsEl.empty();
    this.rowsEl.style.height = `${slice.totalHeight}px`;
    this.rowsEl.style.transform = `translateY(${slice.offsetY - this.scrollTop}px)`;

    for (let i = slice.start; i < slice.end; i += 1) {
      const row = this.rows[i];
      if (!row) continue;
      this.renderRow(row, rowHeight);
    }
  }

  private renderRow(row: Row, rowHeight: number): void {
    const el = this.rowsEl.createDiv({ cls: 'tng-grid-row' });
    el.style.height = `${rowHeight}px`;
    el.dataset['id'] = row.id;
    el.toggleClass('is-group', row.kind === 'group');
    el.toggleClass('is-hidden-group', row.kind === 'group' && row.visible === false);
    el.toggleClass('is-selected', row.id === this.selectedId);
    el.toggleClass('is-hovered', row.id === this.hoveredId);

    const name = el.createDiv({ cls: 'tng-grid-cell tng-grid-name' });
    name.style.paddingLeft = `${6 + row.depth * 14}px`;

    if (row.kind === 'capacity') {
      el.addClass('is-capacity');
      const load = this.host.loadFor(row.id);
      const icon = name.createSpan({ cls: 'tng-load-icon' });
      setIcon(icon, 'bar-chart-3');
      name.createSpan({ cls: 'tng-grid-label', text: row.label });
      if (load) {
        const hours = (m: number) => `${(m / 60).toFixed(1)}h`;
        const peak = el.createDiv({ cls: 'tng-grid-cell tng-grid-date' });
        peak.setText(hours(load.peakMinutes));
        peak.title = `Peak load per day (capacity ${hours(load.capacity)})`;
        if (load.peakMinutes > load.capacity) peak.addClass('is-over');

        const over = el.createDiv({ cls: 'tng-grid-cell tng-grid-date' });
        over.setText(load.overDays > 0 ? `${load.overDays}d` : '');
        over.title = 'Days over capacity';
        if (load.overDays > 0) over.addClass('is-over');
      }
      if (this.host.showFloat()) el.createDiv({ cls: 'tng-grid-cell tng-grid-float' });
      if (this.host.showVariance()) el.createDiv({ cls: 'tng-grid-cell tng-grid-float' });
      return;
    }

    if (row.kind === 'group') {
      // A real checkbox rather than an icon: it is the standard control for "include
      // this", it reads correctly to a screen reader, and it is keyboard reachable.
      const box = name.createEl('input', {
        cls: 'tng-group-check',
        attr: { type: 'checkbox' }
      });
      box.checked = row.visible !== false;
      box.setAttribute('aria-label', `Show ${row.label}`);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => this.host.onToggleGroupVisible(row.id));

      const twisty = name.createSpan({ cls: 'tng-twisty' });
      setIcon(twisty, row.collapsed ? 'chevron-right' : 'chevron-down');
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        this.host.onToggleGroup(row.id);
      });
    } else {
      const dot = name.createSpan({ cls: 'tng-status-dot' });
      dot.style.backgroundColor = this.statusColor(row.task?.status ?? '');
      if (row.task?.completed) dot.addClass('is-complete');
    }

    const label = name.createSpan({ cls: 'tng-grid-label', text: row.label });
    label.title = row.label;
    if (row.unresolved) {
      const warn = name.createSpan({ cls: 'tng-grid-warn' });
      setIcon(warn, 'alert-triangle');
      warn.title = 'This project note does not exist in the vault.';
    }
    if (row.alsoElsewhere) {
      const link = name.createSpan({ cls: 'tng-grid-linked' });
      setIcon(link, 'link');
      link.title = 'This task belongs to more than one group, so it appears in each.';
    }
    if (row.kind === 'group' && row.count !== undefined) {
      name.createSpan({ cls: 'tng-grid-count', text: String(row.count) });
    }

    const bar = row.bar;
    const inferred =
      bar !== undefined &&
      (bar.kind === 'inferred-start' || bar.kind === 'inferred-end' || bar.kind === 'unplanned');

    const start = el.createDiv({ cls: 'tng-grid-cell tng-grid-date' });
    const end = el.createDiv({ cls: 'tng-grid-cell tng-grid-date' });

    if (bar && row.kind === 'task') {
      // Show the real frontmatter dates, and mark the ones the chart guessed, so the
      // grid never presents an inference as though the user had entered it.
      const startText = row.task?.scheduled ? formatDate(row.task.scheduled.ms) : formatDate(bar.startMs);
      const endText = row.task?.due ? formatDate(row.task.due.ms) : formatDate(bar.endMs);
      start.setText(startText);
      end.setText(endText);
      if (!row.task?.scheduled) start.addClass('is-inferred');
      if (!row.task?.due) end.addClass('is-inferred');
      if (bar.kind === 'milestone') {
        start.setText('');
        end.addClass('is-milestone');
      }
      const days = barDurationDays(bar, this.host.calendar);
      el.title = `${row.label}\n${startText} to ${endText}${
        bar.kind === 'milestone' ? ' (milestone)' : ` — ${days.toFixed(days < 10 ? 1 : 0)}d`
      }${inferred ? '\nDates partly inferred from the estimate.' : ''}${
        bar.problem ? `\n${bar.problem}` : ''
      }`;
    }

    if (this.host.showFloat()) {
      const cell = el.createDiv({ cls: 'tng-grid-cell tng-grid-float' });
      if (row.kind === 'task') {
        const days = this.host.floatDaysFor(row.id);
        if (days === null) {
          // A task inside a dependency cycle has no earliest start, so no float.
          cell.setText('—');
          cell.addClass('is-unknown');
        } else {
          cell.setText(days < 0.05 ? '0' : days.toFixed(days < 10 ? 1 : 0));
          if (days < 0.05) cell.addClass('is-critical');
        }
      }
    }

    if (this.host.showVariance()) {
      const cell = el.createDiv({ cls: 'tng-grid-cell tng-grid-float' });
      if (row.kind === 'task') {
        const days = this.host.varianceDaysFor(row.id);
        if (days === null) {
          // No baseline: an em dash rather than a zero, which would read as "on plan".
          cell.setText('—');
          cell.addClass('is-unknown');
        } else if (Math.abs(days) < 0.5) {
          cell.setText('0');
        } else {
          cell.setText(`${days > 0 ? '+' : '−'}${Math.abs(days).toFixed(days < 10 ? 1 : 0)}`);
          cell.addClass(days > 0 ? 'is-over' : 'is-ahead');
        }
      }
    }

    el.addEventListener('click', () => {
      if (row.kind === 'group') this.host.onToggleGroup(row.id);
      else this.host.onSelect(row.id);
    });
    el.addEventListener('dblclick', () => {
      if (row.kind === 'task') this.host.onOpen(row.id);
    });
  }

  dispose(): void {
    this.viewportEl.removeEventListener('wheel', this.onWheel);
    this.splitterEl.removeEventListener('pointerdown', this.onSplitterDown);
    this.rootEl.remove();
    this.splitterEl.remove();
  }
}
