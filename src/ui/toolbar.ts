import { setIcon, setTooltip } from 'obsidian';
import type { GanttController } from './controller';
import type { GanttSettings } from '../settings/defaults';
import type { GroupBy, SortKey } from '../render/layout';
import { ZOOM_LEVELS, type ZoomLevel } from '../render/timescale';

export interface ToolbarHost {
  settings: GanttSettings;
  controller: GanttController;
  /** Persist a settings change and re-render. */
  onChange: (patch: Partial<GanttSettings>) => void;
}

const GROUP_LABELS: Record<GroupBy, string> = {
  project: 'Project',
  status: 'Status',
  priority: 'Priority',
  context: 'Context',
  assignee: 'Assignee',
  none: 'No grouping'
};

const SORT_LABELS: Record<SortKey, string> = {
  manual: 'Manual order',
  start: 'Start date',
  due: 'Due date',
  title: 'Title',
  priority: 'Priority',
  status: 'Status'
};

const ZOOM_LABELS: Record<ZoomLevel, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter'
};

function iconButton(
  parent: HTMLElement,
  icon: string,
  tooltip: string,
  onClick: () => void
): HTMLElement {
  const button = parent.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(button, icon);
  setTooltip(button, tooltip);
  button.addEventListener('click', onClick);
  return button;
}

function select<T extends string>(
  parent: HTMLElement,
  labels: Record<T, string>,
  value: T,
  tooltip: string,
  onChange: (next: T) => void
): HTMLSelectElement {
  const el = parent.createEl('select', { cls: 'tng-toolbar-select' });
  setTooltip(el, tooltip);
  for (const [key, label] of Object.entries(labels) as [T, string][]) {
    el.createEl('option', { value: key, text: label });
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/**
 * The chart's own controls.
 *
 * Deliberately small: in the Bases view, filtering and sorting already belong to the
 * Bases toolbar above, so duplicating them here would give the user two controls that
 * disagree.
 */
export function buildToolbar(containerEl: HTMLElement, host: ToolbarHost): HTMLElement {
  const bar = containerEl.createDiv({ cls: 'tng-toolbar' });

  iconButton(bar, 'zoom-out', 'Zoom out', () => host.controller.zoomOut());
  const zoomSelect = select(bar, ZOOM_LABELS, host.settings.zoom, 'Timescale', (zoom) => {
    host.controller.setZoom(zoom);
    host.onChange({ zoom });
  });
  iconButton(bar, 'zoom-in', 'Zoom in', () => host.controller.zoomIn());
  iconButton(bar, 'calendar-clock', 'Scroll to today', () => host.controller.scrollToToday());

  bar.createDiv({ cls: 'tng-toolbar-divider' });

  select(bar, GROUP_LABELS, host.settings.groupBy, 'Group by', (groupBy) =>
    host.onChange({ groupBy })
  );
  select(bar, SORT_LABELS, host.settings.sortKey, 'Sort tasks by', (sortKey) =>
    host.onChange({ sortKey })
  );

  const collapse = bar.createEl('button', { cls: 'tng-toolbar-button' });
  const syncCollapse = () => {
    const all = host.controller.allGroupsCollapsed;
    setIcon(collapse, all ? 'unfold-vertical' : 'fold-vertical');
    setTooltip(collapse, all ? 'Expand all groups' : 'Collapse all groups');
  };
  syncCollapse();
  collapse.addEventListener('click', () => {
    host.controller.toggleAllGroups();
    syncCollapse();
  });

  bar.createDiv({ cls: 'tng-toolbar-divider' });

  const deps = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(deps, 'git-branch');
  setTooltip(deps, 'Toggle dependency lines');
  deps.toggleClass('is-active', host.settings.showDependencies);
  deps.addEventListener('click', () => {
    const showDependencies = !host.settings.showDependencies;
    deps.toggleClass('is-active', showDependencies);
    host.onChange({ showDependencies });
  });

  const heads = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(heads, 'arrow-right');
  setTooltip(heads, 'Toggle arrowheads');
  heads.toggleClass('is-active', host.settings.showArrowheads);
  heads.addEventListener('click', () => {
    const showArrowheads = !host.settings.showArrowheads;
    heads.toggleClass('is-active', showArrowheads);
    host.onChange({ showArrowheads });
  });

  const critical = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(critical, 'zap');
  setTooltip(critical, 'Highlight the critical path');
  critical.toggleClass('is-active', host.settings.showCriticalPath);
  critical.addEventListener('click', () => {
    const showCriticalPath = !host.settings.showCriticalPath;
    critical.toggleClass('is-active', showCriticalPath);
    host.onChange({ showCriticalPath });
  });

  const cascade = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(cascade, 'move-right');
  setTooltip(
    cascade,
    'Cascade: dragging a bar also pushes the tasks that depend on it'
  );
  cascade.toggleClass('is-active', host.settings.cascadeDependents);
  cascade.addEventListener('click', () => {
    const cascadeDependents = !host.settings.cascadeDependents;
    cascade.toggleClass('is-active', cascadeDependents);
    host.onChange({ cascadeDependents });
  });

  const capacity = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(capacity, 'bar-chart-3');
  setTooltip(capacity, 'Show a daily load histogram under each group');
  capacity.toggleClass('is-active', host.settings.showCapacity);
  capacity.addEventListener('click', () => {
    const showCapacity = !host.settings.showCapacity;
    capacity.toggleClass('is-active', showCapacity);
    host.onChange({ showCapacity });
  });

  const completed = bar.createEl('button', { cls: 'tng-toolbar-button' });
  setIcon(completed, 'check-check');
  setTooltip(completed, 'Show completed tasks');
  completed.toggleClass('is-active', host.settings.showCompleted);
  completed.addEventListener('click', () => {
    const showCompleted = !host.settings.showCompleted;
    completed.toggleClass('is-active', showCompleted);
    host.onChange({ showCompleted });
  });

  // Keep the zoom control in step when the wheel or the buttons change it.
  const syncZoom = () => {
    if (ZOOM_LEVELS.includes(host.controller.zoom)) zoomSelect.value = host.controller.zoom;
  };
  bar.addEventListener('tng-zoom-changed', syncZoom);

  return bar;
}

export interface BannerAction {
  label: string;
  tooltip?: string;
  onClick: () => void;
}

/** A banner for connection problems and data problems, shown above the chart. */
/**
 * How loud a banner is.
 *
 * `info` states a fact the chart depends on — what the load chart is measuring, say —
 * where a warning would be crying wolf about something that is working correctly.
 */
export type BannerLevel = 'info' | 'warn' | 'error';

export function buildBanner(
  containerEl: HTMLElement,
  message: string,
  level: BannerLevel,
  action?: BannerAction
): HTMLElement {
  const el = containerEl.createDiv({ cls: `tng-banner tng-banner-${level}` });
  el.createSpan({ cls: 'tng-banner-text', text: message });
  if (action) {
    const button = el.createEl('button', { cls: 'tng-banner-action', text: action.label });
    if (action.tooltip !== undefined) setTooltip(button, action.tooltip);
    button.addEventListener('click', action.onClick);
  }
  return el;
}
