import type { GanttTask, TaskNotesCatalog } from '../types';
import type { GroupBy, SortKey } from '../render/layout';
import type { ZoomLevel } from '../render/timescale';
import { ZOOM_LEVELS } from '../render/timescale';
import { NO_VALUE, type FacetDefinition, type FilterState } from '../model/filter';
import type { GanttSettings } from './defaults';

/**
 * The body of a ```tngantt``` code block.
 *
 * Parsing is deliberately in two halves. `parseBlockConfig` is pure text work and
 * knows nothing about the vault; `resolveSelectors` matches what the author asked for
 * against the values the tasks actually carry. Splitting them is what lets the block
 * say `project: Relaunch` when the facet value is a full note path, and what lets
 * a selector that matches nothing be reported instead of silently emptying the chart.
 */

export interface BlockSelector {
  /** The facet this narrows, e.g. `project` or `field:initiative`. */
  facetId: string;
  /** What the author wrote, before resolution. */
  wanted: string[];
  /** The key as typed, for error messages. */
  key: string;
}

export interface BlockConfig {
  /** Overrides to layer over the plugin's settings. */
  settings: Partial<GanttSettings>;
  selectors: BlockSelector[];
  /** Free text, matched against task titles. */
  text: string;
  /** Chart height in pixels. A code block has no natural height. */
  height: number;
  /** Dragging is off unless the author asks for it. */
  editable: boolean;
  /** Unusable lines, reported in place of the chart rather than ignored. */
  errors: string[];
}

export const MIN_HEIGHT = 80;
export const MAX_HEIGHT = 2000;
export const DEFAULT_HEIGHT = 320;

const GROUP_BYS: readonly GroupBy[] = [
  'project',
  'status',
  'priority',
  'context',
  'assignee',
  'none'
];
const SORT_KEYS: readonly SortKey[] = ['manual', 'start', 'due', 'title', 'priority', 'status'];

/** Block keys that set a boolean on the chart, and the setting each drives. */
const TOGGLES: Record<string, keyof GanttSettings> = {
  dependencies: 'showDependencies',
  arrowheads: 'showArrowheads',
  critical: 'showCriticalPath',
  violations: 'showViolations',
  completed: 'showCompleted',
  archived: 'showArchived',
  capacity: 'showCapacity',
  baseline: 'showBaseline'
};

/** Block keys that name a facet directly, rather than by its internal id. */
const FACET_ALIASES: Record<string, string> = {
  project: 'project',
  projects: 'project',
  status: 'status',
  statuses: 'status',
  priority: 'priority',
  priorities: 'priority',
  context: 'context',
  contexts: 'context',
  tag: 'tag',
  tags: 'tag'
};

function splitValues(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  return null;
}

/**
 * Parse a block body into overrides and selectors.
 *
 * `catalog` is needed only to know which user-defined field names are legitimate keys,
 * so `initiative: Company Growth` works in a vault that defines that field and is
 * reported as unknown in one that does not.
 */
export function parseBlockConfig(
  source: string,
  catalog: TaskNotesCatalog,
  resourceField: string
): BlockConfig {
  const config: BlockConfig = {
    settings: {},
    selectors: [],
    text: '',
    height: DEFAULT_HEIGHT,
    editable: false,
    errors: []
  };

  const userFieldKeys = new Set(catalog.userFields.map((f) => f.key));

  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      config.errors.push(`Line ${index + 1}: expected \`key: value\`, got \`${trimmed}\`.`);
      continue;
    }

    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const raw = trimmed.slice(colon + 1).trim();
    if (raw === '') {
      config.errors.push(`Line ${index + 1}: \`${key}\` has no value.`);
      continue;
    }

    // Settings first, then facets, so a vault whose user field is called "zoom" does
    // not quietly take over a display key.
    if (key === 'zoom') {
      if (!(ZOOM_LEVELS as readonly string[]).includes(raw)) {
        config.errors.push(`\`zoom: ${raw}\` — expected one of ${ZOOM_LEVELS.join(', ')}.`);
        continue;
      }
      config.settings.zoom = raw as ZoomLevel;
      continue;
    }

    if (key === 'groupby' || key === 'group') {
      if (!(GROUP_BYS as readonly string[]).includes(raw)) {
        config.errors.push(`\`${key}: ${raw}\` — expected one of ${GROUP_BYS.join(', ')}.`);
        continue;
      }
      config.settings.groupBy = raw as GroupBy;
      continue;
    }

    if (key === 'sort' || key === 'sortby') {
      if (!(SORT_KEYS as readonly string[]).includes(raw)) {
        config.errors.push(`\`${key}: ${raw}\` — expected one of ${SORT_KEYS.join(', ')}.`);
        continue;
      }
      config.settings.sortKey = raw as SortKey;
      continue;
    }

    if (key === 'height' || key === 'rowheight' || key === 'gridwidth') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        config.errors.push(`\`${key}: ${raw}\` — expected a number.`);
        continue;
      }
      if (key === 'height') config.height = clamp(value, MIN_HEIGHT, MAX_HEIGHT);
      else if (key === 'rowheight') config.settings.rowHeight = clamp(value, 16, 80);
      else config.settings.gridWidth = clamp(value, 0, 800);
      continue;
    }

    if (key === 'editable') {
      const value = parseBoolean(raw);
      if (value === null) {
        config.errors.push(`\`editable: ${raw}\` — expected true or false.`);
        continue;
      }
      config.editable = value;
      continue;
    }

    const toggle = TOGGLES[key];
    if (toggle !== undefined) {
      const value = parseBoolean(raw);
      if (value === null) {
        config.errors.push(`\`${key}: ${raw}\` — expected true or false.`);
        continue;
      }
      (config.settings as Record<string, unknown>)[toggle] = value;
      continue;
    }

    if (key === 'text' || key === 'search') {
      config.text = raw;
      continue;
    }

    const facetId = FACET_ALIASES[key];
    if (facetId !== undefined) {
      config.selectors.push({ facetId, wanted: splitValues(raw), key });
      continue;
    }

    if (key === 'assignee' || key === resourceField.toLowerCase()) {
      config.selectors.push({
        facetId: `field:${resourceField}`,
        wanted: splitValues(raw),
        key
      });
      continue;
    }

    // A user-defined TaskNotes field, matched case-insensitively against its key.
    const userField = [...userFieldKeys].find((k) => k.toLowerCase() === key);
    if (userField !== undefined) {
      config.selectors.push({ facetId: `field:${userField}`, wanted: splitValues(raw), key });
      continue;
    }

    config.errors.push(
      `Unknown option \`${key}\`. Expected a filter (${Object.keys(FACET_ALIASES)
        .slice(0, 4)
        .join(', ')}, or one of your own fields) or a display option (zoom, groupBy, height).`
    );
  }

  return config;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Match what the author wrote against the values the tasks actually carry.
 *
 * Facet values are internal — a project is a note path, not the name a person types —
 * so each wanted value is matched against the value itself, against the facet's own
 * display label, and finally as a case-insensitive substring of that label. That last
 * one is what makes `project: Relaunch` select "PRJ-01 Website Relaunch", the
 * same courtesy the CLI extends.
 *
 * A selector matching nothing becomes an error. Silently producing an empty chart
 * would look identical to a project with no tasks in it.
 */
export function resolveSelectors(
  selectors: readonly BlockSelector[],
  facets: readonly FacetDefinition[],
  tasks: readonly GanttTask[],
  text = ''
): { filter: FilterState; errors: string[] } {
  const filter: FilterState = { text, facets: {} };
  const errors: string[] = [];

  for (const selector of selectors) {
    const facet = facets.find((f) => f.id === selector.facetId);
    if (facet === undefined) {
      errors.push(`\`${selector.key}\` is not a field this vault defines.`);
      continue;
    }

    const present = new Set<string>();
    for (const task of tasks) for (const value of facet.valuesOf(task)) present.add(value);

    const resolved = new Set<string>();
    for (const wanted of selector.wanted) {
      const matches = matchValue(wanted, present, facet);
      if (matches.length === 0) {
        errors.push(`\`${selector.key}: ${wanted}\` matches no task.`);
        continue;
      }
      for (const match of matches) resolved.add(match);
    }

    if (resolved.size > 0) filter.facets[selector.facetId] = [...resolved];
  }

  return { filter, errors };
}

function matchValue(
  wanted: string,
  present: ReadonlySet<string>,
  facet: FacetDefinition
): string[] {
  const needle = wanted.trim().toLowerCase();
  if (needle === '') return [];

  // "none" is how a person asks for the empty bucket; the sentinel is not typeable.
  if (needle === 'none' && present.has(NO_VALUE)) return [NO_VALUE];
  if (present.has(wanted)) return [wanted];

  const exact: string[] = [];
  const partial: string[] = [];
  for (const value of present) {
    const label = facet.labelOf(value).toLowerCase();
    if (value.toLowerCase() === needle || label === needle) exact.push(value);
    else if (label.includes(needle) || value.toLowerCase().includes(needle)) partial.push(value);
  }
  // An exact label match wins outright, so a project called "Docs" is not dragged in
  // by a request for "Docs & Help Centre" or vice versa.
  return exact.length > 0 ? exact : partial;
}
