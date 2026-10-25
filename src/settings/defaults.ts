import type { WorkingCalendar } from '../model/calendar';
import type { GroupBy, SortKey } from '../render/layout';
import type { ZoomLevel } from '../render/timescale';
import { DEFAULT_PROGRESS_ORDER, PROGRESS_SOURCES, type ProgressSource } from '../model/progress';
import { EMPTY_FILTER, type FilterState } from '../model/filter';

export interface GanttSettings {
  /** Weekly working pattern, indexed from Sunday. */
  workdays: boolean[];
  dayStartMinutes: number;
  dayEndMinutes: number;
  /** Non-working dates as `YYYY-MM-DD`. */
  holidays: string[];

  /** Whether an all-day due date means end of that day. */
  dueDateInclusive: boolean;
  /** Span for a task with dates but no estimate, in working minutes. */
  defaultDurationMinutes: number;

  groupBy: GroupBy;
  sortKey: SortKey;
  zoom: ZoomLevel;
  rowHeight: number;
  /** Width of the task-name grid beside the chart, in pixels. */
  gridWidth: number;
  /** Draw the connector lines between dependent tasks. */
  showDependencies: boolean;
  /**
   * Draw the arrowhead at the end of each connector.
   *
   * Separate from the lines: the heads carry the direction, but at density they add a
   * lot of ink, and some people would rather read the routing alone.
   */
  showArrowheads: boolean;
  /** Outline the chain that determines the project end date. */
  showCriticalPath: boolean;
  /** Badge tasks whose dates contradict a dependency. */
  showViolations: boolean;
  /** Also push dependents when a bar is dragged. */
  cascadeDependents: boolean;
  showCompleted: boolean;
  showArchived: boolean;

  /** Frontmatter property used as the resource axis: who or what owes the work. */
  resourceField: string;
  /** Working minutes a resource can absorb per day, before overrides. */
  defaultCapacityMinutesPerDay: number;
  /** Per-resource capacity, in working minutes per day, keyed by resource name. */
  capacityOverrides: Record<string, number>;
  /** Show a daily load histogram beneath each group. */
  showCapacity: boolean;

  /** Draw a thin baseline bar under each task and a variance column. */
  showBaseline: boolean;
  /** Frontmatter property holding the baselined start. */
  baselineStartField: string;
  /** Frontmatter property holding the baselined end. */
  baselineEndField: string;
  /** Order in which progress sources are consulted. */
  progressOrder: ProgressSource[];

  /** Which tasks the chart shows. Persisted so a view survives a reload. */
  filter: FilterState;
  /** Group rows switched off by their checkbox, by group id. */
  hiddenGroups: string[];

  /** Vault folder exports are written to. Empty means the vault root. */
  exportFolder: string;

  /** Blocks every write path when true. */
  safeMode: boolean;
  /** Operations touching more than this many tasks require confirmation. */
  confirmThreshold: number;
}

export const DEFAULT_SETTINGS: GanttSettings = {
  workdays: [false, true, true, true, true, true, false],
  dayStartMinutes: 9 * 60,
  dayEndMinutes: 17 * 60,
  holidays: [],

  dueDateInclusive: true,
  defaultDurationMinutes: 480,

  groupBy: 'project',
  sortKey: 'start',
  zoom: 'week',
  rowHeight: 28,
  gridWidth: 320,
  showDependencies: true,
  showArrowheads: true,
  showCriticalPath: false,
  showViolations: true,
  cascadeDependents: false,
  showCompleted: true,
  showArchived: false,

  resourceField: 'assignee',
  defaultCapacityMinutesPerDay: 480,
  capacityOverrides: {},
  showCapacity: false,

  showBaseline: true,
  baselineStartField: 'ganttBaselineStart',
  baselineEndField: 'ganttBaselineEnd',
  progressOrder: [...DEFAULT_PROGRESS_ORDER],

  filter: { text: '', facets: {} },
  hiddenGroups: [],

  exportFolder: '',

  safeMode: false,
  confirmThreshold: 10
};

/** Merge stored settings over the defaults, dropping anything malformed. */
export function mergeSettings(stored: unknown): GanttSettings {
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS };
  const s = stored as Partial<GanttSettings>;
  const merged: GanttSettings = { ...DEFAULT_SETTINGS };

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof GanttSettings)[]) {
    const value = s[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (merged as any)[key] = value;
  }

  // A seven-day pattern is assumed everywhere; a truncated array would silently make
  // some weekdays non-working.
  if (!Array.isArray(merged.workdays) || merged.workdays.length !== 7) {
    merged.workdays = [...DEFAULT_SETTINGS.workdays];
  }
  if (!Array.isArray(merged.holidays)) merged.holidays = [];
  if (!Array.isArray(merged.hiddenGroups)) merged.hiddenGroups = [];
  // A malformed stored filter would silently hide every task with no way to tell why.
  if (
    typeof merged.filter !== 'object' ||
    merged.filter === null ||
    typeof merged.filter.text !== 'string' ||
    typeof merged.filter.facets !== 'object' ||
    merged.filter.facets === null
  ) {
    merged.filter = { ...EMPTY_FILTER, facets: {} };
  }
  // A truncated or misspelt order would silently disable progress sources.
  if (
    !Array.isArray(merged.progressOrder) ||
    merged.progressOrder.some((v) => !PROGRESS_SOURCES.includes(v))
  ) {
    merged.progressOrder = [...DEFAULT_PROGRESS_ORDER];
  }
  if (typeof merged.capacityOverrides !== 'object' || merged.capacityOverrides === null) {
    merged.capacityOverrides = {};
  }
  if (merged.rowHeight < 16 || merged.rowHeight > 80) merged.rowHeight = DEFAULT_SETTINGS.rowHeight;

  migrateNulSentinels(merged);

  // `assigneeField` before the axis was understood to be any property, not just a
  // person. Without this, everyone's configured resource silently reverts to the
  // default and their load chart quietly measures nothing.
  const legacy = (s as Record<string, unknown>)['assigneeField'];
  if (typeof legacy === 'string' && legacy.trim() !== '' && s.resourceField === undefined) {
    merged.resourceField = legacy;
  }

  return merged;
}

/**
 * Rewrite the old NUL-byte sentinels in stored selections.
 *
 * `NO_VALUE` and the ungrouped-group key were once a literal `\0` prefix, and both end
 * up on disk: facet selections in `filter.facets`, and the catch-all group id in
 * `hiddenGroups`. Without this, upgrading silently orphans a saved "No project" filter
 * or a group the user had switched off — it would simply stop matching, with nothing
 * to explain why.
 */
function migrateNulSentinels(settings: GanttSettings): void {
  // Written as an escape, never as a literal: a raw NUL in the source is what made
  // `filter.ts` and `layout.ts` read as binary to every search tool in the first place.
  const fix = (value: string) =>
    typeof value === 'string' ? value.replace(/\u0000/g, ' ') : value;

  settings.hiddenGroups = settings.hiddenGroups.map(fix);
  for (const [id, values] of Object.entries(settings.filter.facets)) {
    if (Array.isArray(values)) settings.filter.facets[id] = values.map(fix);
  }
}

export function calendarFrom(settings: GanttSettings): WorkingCalendar {
  return {
    workdays: settings.workdays,
    dayStartMinutes: settings.dayStartMinutes,
    dayEndMinutes: settings.dayEndMinutes,
    holidays: new Set(settings.holidays)
  };
}
