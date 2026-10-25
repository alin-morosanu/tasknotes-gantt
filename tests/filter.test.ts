import { describe, expect, it } from 'vitest';
import {
  activeFacetCount,
  applyFilter,
  buildFacets,
  clearFacet,
  EMPTY_FILTER,
  facetOptions,
  isFilterActive,
  matchesFilter,
  NO_VALUE,
  pruneFilter,
  toggleFacetValue,
  type FilterState
} from '../src/model/filter';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

const facets = buildFacets(CATALOG, 'assignee');
const facet = (id: string) => facets.find((f) => f.id === id)!;

const project = (target: string, path: string | null) => ({
  raw: `[[${target}]]`,
  target,
  path
});

const filter = (over: Partial<FilterState> = {}): FilterState => ({
  ...EMPTY_FILTER,
  facets: {},
  ...over
});

const tasks = [
  makeTask({
    title: 'Homepage draft',
    status: 'in-progress',
    priority: 'high',
    contexts: ['business'],
    projects: [project('PRJ-01', 'TaskNotes/Projects/PRJ-01.md')],
    extra: { initiative: 'Company Growth', assignee: 'Avery' }
  }),
  makeTask({
    title: 'Skills ladder',
    status: 'backlog',
    priority: 'high',
    contexts: ['team'],
    projects: [project('PRJ-TL-01', 'TaskNotes/Projects/PRJ-TL-01.md')],
    extra: { initiative: 'Team Development' }
  }),
  makeTask({
    title: 'Loose end',
    status: 'backlog',
    priority: 'low',
    contexts: [],
    projects: [],
    extra: {}
  }),
  makeTask({
    title: 'Audit checklist',
    status: 'in-progress',
    priority: 'normal',
    contexts: ['business', 'new-business'],
    projects: [project('BOA-01', 'TaskNotes/Projects/BOA-01.md')],
    extra: { initiative: 'Company Growth' }
  })
];

describe('buildFacets', () => {
  it('offers the standard facets plus the user’s own fields', () => {
    const ids = facets.map((f) => f.id);
    expect(ids).toContain('project');
    expect(ids).toContain('status');
    expect(ids).toContain('priority');
    expect(ids).toContain('context');
    // `initiative` is a TaskNotes user field in this vault, and filtering by it is
    // one of the things this exists for.
    expect(ids).toContain('field:initiative');
  });

  it('labels a status by its configured label, not its raw value', () => {
    expect(facet('status').labelOf('in-progress')).toBe('In Progress');
  });

  it('does not offer the assignee field twice when it is also a user field', () => {
    const withAssigneeAsUserField = buildFacets(
      { ...CATALOG, userFields: [{ id: 'a', key: 'assignee', displayName: 'Owner', type: 'text' }] },
      'assignee'
    );
    expect(withAssigneeAsUserField.filter((f) => f.id === 'field:assignee')).toHaveLength(1);
  });

  it('keys projects the same way group rows do', () => {
    const values = facet('project').valuesOf(tasks[0]!);
    expect(values).toEqual(['TaskNotes/Projects/PRJ-01.md']);
  });

  it('marks a dangling project link as unresolved rather than dropping it', () => {
    const task = makeTask({ projects: [project('Side Project', null)] });
    expect(facet('project').valuesOf(task)).toEqual(['unresolved:Side Project']);
    expect(facet('project').labelOf('unresolved:Side Project')).toBe('Side Project');
  });

  it('represents absence as a selectable value', () => {
    expect(facet('project').valuesOf(tasks[2]!)).toEqual([NO_VALUE]);
    expect(facet('project').labelOf(NO_VALUE)).toBe('No project');
    expect(facet('field:initiative').labelOf(NO_VALUE)).toBe('No initiative');
  });
});

describe('matchesFilter', () => {
  it('passes everything when nothing is selected', () => {
    expect(applyFilter(tasks, filter(), facets)).toHaveLength(4);
  });

  it('matches free text against the title, case insensitively', () => {
    expect(applyFilter(tasks, filter({ text: 'ladder' }), facets)).toHaveLength(1);
    expect(applyFilter(tasks, filter({ text: 'LADDER' }), facets)).toHaveLength(1);
    expect(applyFilter(tasks, filter({ text: 'nothing here' }), facets)).toHaveLength(0);
  });

  it('ORs values within one facet', () => {
    const state = filter({ facets: { status: ['backlog', 'in-progress'] } });
    expect(applyFilter(tasks, state, facets)).toHaveLength(4);
    expect(applyFilter(tasks, filter({ facets: { status: ['backlog'] } }), facets)).toHaveLength(2);
  });

  it('ANDs across facets', () => {
    // "in-progress tasks under Company Growth" — the combination the user asked for.
    const state = filter({
      facets: { status: ['in-progress'], 'field:initiative': ['Company Growth'] }
    });
    const result = applyFilter(tasks, state, facets);
    expect(result.map((t) => t.title)).toEqual(['Homepage draft', 'Audit checklist']);
  });

  it('combines three facets', () => {
    const state = filter({
      facets: {
        status: ['in-progress'],
        'field:initiative': ['Company Growth'],
        project: ['TaskNotes/Projects/BOA-01.md']
      }
    });
    expect(applyFilter(tasks, state, facets).map((t) => t.title)).toEqual(['Audit checklist']);
  });

  it('matches a task on any of its several contexts', () => {
    const state = filter({ facets: { context: ['new-business'] } });
    expect(applyFilter(tasks, state, facets).map((t) => t.title)).toEqual(['Audit checklist']);
  });

  it('can select tasks that have no value for a facet', () => {
    const state = filter({ facets: { project: [NO_VALUE] } });
    expect(applyFilter(tasks, state, facets).map((t) => t.title)).toEqual(['Loose end']);
  });

  it('combines text with facets', () => {
    const state = filter({ text: 'audit', facets: { status: ['in-progress'] } });
    expect(applyFilter(tasks, state, facets)).toHaveLength(1);
    expect(
      applyFilter(tasks, filter({ text: 'audit', facets: { status: ['backlog'] } }), facets)
    ).toHaveLength(0);
  });

  it('ignores a facet whose selection is empty', () => {
    expect(matchesFilter(tasks[0]!, filter({ facets: { status: [] } }), facets)).toBe(true);
  });
});

describe('facetOptions', () => {
  it('counts how many tasks carry each value', () => {
    const options = facetOptions(tasks, facet('status'), filter(), facets);
    expect(options.find((o) => o.value === 'in-progress')?.count).toBe(2);
    expect(options.find((o) => o.value === 'backlog')?.count).toBe(2);
  });

  it('counts against the other facets, so a count says what selecting would give', () => {
    // With Team Development selected, only one status is still reachable. A value that
    // would return nothing is not offered at all: every option in the menu does
    // something when you click it.
    const state = filter({ facets: { 'field:initiative': ['Team Development'] } });
    const options = facetOptions(tasks, facet('status'), state, facets);
    expect(options.find((o) => o.value === 'backlog')?.count).toBe(1);
    expect(options.find((o) => o.value === 'in-progress')).toBeUndefined();
  });

  it('does not narrow a facet by its own selection', () => {
    // Selecting one status must not hide the others, or they could never be added.
    const state = filter({ facets: { status: ['backlog'] } });
    const options = facetOptions(tasks, facet('status'), state, facets);
    expect(options.find((o) => o.value === 'in-progress')?.count).toBe(2);
  });

  it('keeps a selected value listed even when nothing matches it', () => {
    const state = filter({ facets: { status: ['on-hold'] } });
    const options = facetOptions(tasks, facet('status'), state, facets);
    expect(options.find((o) => o.value === 'on-hold')).toBeDefined();
  });

  it('sorts the no-value bucket last', () => {
    const options = facetOptions(tasks, facet('project'), filter(), facets);
    expect(options[options.length - 1]?.value).toBe(NO_VALUE);
  });
});

describe('filter state helpers', () => {
  it('toggles a value on and off', () => {
    const once = toggleFacetValue(filter(), 'status', 'backlog');
    expect(once.facets['status']).toEqual(['backlog']);
    const twice = toggleFacetValue(once, 'status', 'backlog');
    // Removing the last value drops the facet entirely, so it reads as unset.
    expect(twice.facets['status']).toBeUndefined();
  });

  it('accumulates several values in one facet', () => {
    let state = toggleFacetValue(filter(), 'status', 'backlog');
    state = toggleFacetValue(state, 'status', 'done');
    expect(state.facets['status']).toEqual(['backlog', 'done']);
  });

  it('never mutates the state it was given', () => {
    const original = filter({ facets: { status: ['backlog'] } });
    toggleFacetValue(original, 'status', 'done');
    expect(original.facets['status']).toEqual(['backlog']);
  });

  it('clears one facet without touching the others', () => {
    const state = filter({ facets: { status: ['backlog'], priority: ['high'] } });
    const cleared = clearFacet(state, 'status');
    expect(cleared.facets['status']).toBeUndefined();
    expect(cleared.facets['priority']).toEqual(['high']);
  });

  it('reports whether anything is narrowing the view', () => {
    expect(isFilterActive(filter())).toBe(false);
    expect(isFilterActive(filter({ text: '  ' }))).toBe(false);
    expect(isFilterActive(filter({ text: 'a' }))).toBe(true);
    expect(isFilterActive(filter({ facets: { status: [] } }))).toBe(false);
    expect(isFilterActive(filter({ facets: { status: ['done'] } }))).toBe(true);
    expect(activeFacetCount(filter({ facets: { status: ['done'], priority: [] } }))).toBe(1);
  });

  it('prunes selections for facets that no longer exist', () => {
    // A renamed user field would otherwise leave a filter nothing can match or clear.
    const state = filter({ facets: { status: ['backlog'], 'field:gone': ['x'] } });
    const pruned = pruneFilter(state, facets);
    expect(pruned.facets['status']).toEqual(['backlog']);
    expect(pruned.facets['field:gone']).toBeUndefined();
  });
});
