import type { GanttTask, TaskNotesCatalog } from '../types';
import { resourceValuesOf } from './resource';

/**
 * Filtering the chart down to the work you care about.
 *
 * Facets combine the way people describe what they want: OR within a facet, AND
 * across them. "The in-progress and up-next tasks, on these two projects, under the
 * Company Growth initiative" is three facets, and each narrows the last.
 */

/**
 * The bucket for a task with no value for a facet, so "no project" is selectable.
 *
 * The leading space is the sentinel: every value reaching a facet comes from
 * frontmatter and is rejected when blank, so no real value can be " none". It used to
 * be a literal NUL byte, which worked but made this file and `layout.ts` read as
 * binary to grep, ripgrep and GitHub's diff view — every search of the two most
 * filter-relevant files in the repo silently found nothing.
 */
export const NO_VALUE = ' none';

export interface FacetDefinition {
  id: string;
  label: string;
  /** The values this task has for the facet. Never empty: absence is `NO_VALUE`. */
  valuesOf: (task: GanttTask) => string[];
  /** How a raw value is shown. Defaults to the value itself. */
  labelOf: (value: string) => string;
}

export interface FilterState {
  /** Free text, matched against the task title. */
  text: string;
  /** Selected values per facet id. An absent or empty entry means "no restriction". */
  facets: Record<string, string[]>;
}

export const EMPTY_FILTER: FilterState = { text: '', facets: {} };

/** A readable name for whichever property is acting as the resource axis. */
export function resourceLabel(field: string): string {
  if (field === 'assignee') return 'Assignee';
  const trimmed = field.trim();
  if (trimmed === '') return 'Resource';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Strip a path down to the name a person would recognise. */
function displayName(pathOrTarget: string): string {
  const file = pathOrTarget.slice(pathOrTarget.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}

function nonEmpty(values: string[]): string[] {
  const cleaned = values.filter((v) => v.trim() !== '');
  return cleaned.length > 0 ? cleaned : [NO_VALUE];
}

/**
 * The facets available for a vault.
 *
 * Built from the user's own TaskNotes catalog, so their statuses, priorities and
 * user-defined fields all appear — `initiative` in the reference vault is a user field,
 * and filtering by it is one of the things this exists for.
 */
export function buildFacets(
  catalog: TaskNotesCatalog,
  resourceField: string
): FacetDefinition[] {
  const statusLabel = (value: string) =>
    catalog.statuses.find((s) => s.value === value)?.label ?? value;
  const priorityLabel = (value: string) =>
    catalog.priorities.find((p) => p.value === value)?.label ?? value;

  const facets: FacetDefinition[] = [
    {
      id: 'project',
      label: 'Project',
      // Keyed the same way group rows are, so a project selected here and a group
      // shown in the chart always mean the same thing.
      valuesOf: (task) =>
        nonEmpty(task.projects.map((ref) => ref.path ?? `unresolved:${ref.target}`)),
      labelOf: (value) =>
        value === NO_VALUE
          ? 'No project'
          : displayName(value.startsWith('unresolved:') ? value.slice(11) : value)
    },
    {
      id: 'status',
      label: 'Status',
      valuesOf: (task) => nonEmpty([task.status]),
      labelOf: (value) => (value === NO_VALUE ? 'No status' : statusLabel(value))
    },
    {
      id: 'priority',
      label: 'Priority',
      valuesOf: (task) => nonEmpty([task.priority]),
      labelOf: (value) => (value === NO_VALUE ? 'No priority' : priorityLabel(value))
    },
    {
      id: 'context',
      label: 'Context',
      valuesOf: (task) => nonEmpty(task.contexts),
      labelOf: (value) => (value === NO_VALUE ? 'No context' : value)
    },
    {
      id: 'tag',
      label: 'Tag',
      valuesOf: (task) => nonEmpty(task.tags),
      labelOf: (value) => (value === NO_VALUE ? 'No tag' : `#${value}`)
    },
  ];

  // The resource axis is a property the user picks, so it gets its own facet — unless
  // it is a field already listed above. Pointing it at `contexts` otherwise produced
  // "Context" and "Contexts" side by side, the same thirteen values twice.
  //
  // Labelling it after the property matters too: a chart keyed on contexts used to
  // offer a facet called "Assignee" that listed contexts.
  const BUILT_IN: Record<string, string> = {
    projects: 'project',
    contexts: 'context',
    tags: 'tag',
    status: 'status',
    priority: 'priority'
  };
  if (BUILT_IN[resourceField] === undefined) {
    facets.push({
      id: `field:${resourceField}`,
      label: resourceLabel(resourceField),
      valuesOf: (task) => nonEmpty(resourceValuesOf(task, resourceField)),
      labelOf: (value) =>
        value === NO_VALUE ? `No ${resourceLabel(resourceField).toLowerCase()}` : value
    });
  }

  for (const field of catalog.userFields) {
    // The resource property may also be a declared user field; do not offer it twice.
    if (field.key === resourceField) continue;
    facets.push({
      id: `field:${field.key}`,
      label: field.displayName,
      valuesOf: (task) => nonEmpty(resourceValuesOf(task, field.key)),
      labelOf: (value) => (value === NO_VALUE ? `No ${field.displayName.toLowerCase()}` : value)
    });
  }

  return facets;
}


/** Does this task survive the filter? */
export function matchesFilter(
  task: GanttTask,
  filter: FilterState,
  facets: readonly FacetDefinition[]
): boolean {
  const text = filter.text.trim().toLowerCase();
  if (text !== '' && !task.title.toLowerCase().includes(text)) return false;

  for (const facet of facets) {
    const selected = filter.facets[facet.id];
    if (!selected || selected.length === 0) continue;
    const values = facet.valuesOf(task);
    // OR within a facet: any one of the selected values is enough.
    if (!values.some((value) => selected.includes(value))) return false;
  }

  return true;
}

export function applyFilter(
  tasks: readonly GanttTask[],
  filter: FilterState,
  facets: readonly FacetDefinition[]
): GanttTask[] {
  if (!isFilterActive(filter)) return [...tasks];
  return tasks.filter((task) => matchesFilter(task, filter, facets));
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/**
 * The values a facet can take, with how many tasks carry each.
 *
 * Counts come from the tasks remaining after every OTHER facet is applied, so they
 * tell you what selecting a value would actually get you rather than what it would
 * have got you before the current filter narrowed things.
 */
export function facetOptions(
  tasks: readonly GanttTask[],
  facet: FacetDefinition,
  filter: FilterState,
  allFacets: readonly FacetDefinition[]
): FacetOption[] {
  const others = allFacets.filter((f) => f.id !== facet.id);
  const scoped = tasks.filter((task) => matchesFilter(task, filter, others));

  const counts = new Map<string, number>();
  for (const task of scoped) {
    for (const value of facet.valuesOf(task)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  // Selected values stay listed even when nothing matches them any more, or they
  // could not be unselected.
  for (const value of filter.facets[facet.id] ?? []) {
    if (!counts.has(value)) counts.set(value, 0);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: facet.labelOf(value), count }))
    .sort((a, b) => {
      // "No value" sorts last; the rest alphabetically.
      if (a.value === NO_VALUE) return 1;
      if (b.value === NO_VALUE) return -1;
      return a.label.localeCompare(b.label);
    });
}

export function isFilterActive(filter: FilterState): boolean {
  if (filter.text.trim() !== '') return true;
  return Object.values(filter.facets).some((values) => values.length > 0);
}

/** How many facets are narrowing the view, for the "clear" affordance. */
export function activeFacetCount(filter: FilterState): number {
  return Object.values(filter.facets).filter((values) => values.length > 0).length;
}

/** Toggle one value in one facet, returning a new state. */
export function toggleFacetValue(
  filter: FilterState,
  facetId: string,
  value: string
): FilterState {
  const current = filter.facets[facetId] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const facets = { ...filter.facets };
  if (next.length === 0) delete facets[facetId];
  else facets[facetId] = next;
  return { ...filter, facets };
}

export function clearFacet(filter: FilterState, facetId: string): FilterState {
  const facets = { ...filter.facets };
  delete facets[facetId];
  return { ...filter, facets };
}

/** Drop selections for facets that no longer exist, e.g. a renamed user field. */
export function pruneFilter(
  filter: FilterState,
  facets: readonly FacetDefinition[]
): FilterState {
  const known = new Set(facets.map((f) => f.id));
  const pruned: Record<string, string[]> = {};
  for (const [id, values] of Object.entries(filter.facets)) {
    if (known.has(id) && values.length > 0) pruned[id] = values;
  }
  return { text: filter.text, facets: pruned };
}
