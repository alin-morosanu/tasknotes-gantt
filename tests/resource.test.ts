import { describe, expect, it } from 'vitest';
import { resourceValuesOf } from '../src/model/resource';
import { buildFacets, NO_VALUE, resourceLabel } from '../src/model/filter';
import { resourceValues, UNASSIGNED } from '../src/model/capacity';
import { buildRows, DEFAULT_LAYOUT } from '../src/render/layout';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

/**
 * The resource axis is a property the user picks, and three places resolve it: the
 * load chart, the filter facet, and the resource grouping. Each used to read
 * `task.extra` on its own, which is right only for properties TaskNotes does not map —
 * so picking `contexts`, the field most tasks in the reference vault actually carry,
 * worked for capacity and silently returned nothing for the other two.
 */

const withContext = makeTask({ title: 'A', contexts: ['business', 'personal'] });
const withOwner = makeTask({ title: 'B', extra: { owner: 'Alin' } });
const withNothing = makeTask({ title: 'C' });

describe('resourceValuesOf', () => {
  it('reads a field TaskNotes maps onto the task itself', () => {
    expect(resourceValuesOf(withContext, 'contexts')).toEqual(['business', 'personal']);
    expect(resourceValuesOf(makeTask({ status: 'done' }), 'status')).toEqual(['done']);
    expect(resourceValuesOf(makeTask({ tags: ['task'] }), 'tags')).toEqual(['task']);
  });

  it('reads an unmapped property out of extra, scalar or list', () => {
    expect(resourceValuesOf(withOwner, 'owner')).toEqual(['Alin']);
    expect(resourceValuesOf(makeTask({ extra: { owner: ['A', 'B'] } }), 'owner')).toEqual([
      'A',
      'B'
    ]);
  });

  it('returns nothing when the task has no value, and trims what it finds', () => {
    expect(resourceValuesOf(withNothing, 'assignee')).toEqual([]);
    expect(resourceValuesOf(makeTask({ extra: { owner: '  Alin  ' } }), 'owner')).toEqual([
      'Alin'
    ]);
    expect(resourceValuesOf(makeTask({ extra: { owner: '   ' } }), 'owner')).toEqual([]);
  });
});

describe('every consumer agrees', () => {
  it('capacity, the filter and grouping all see the same values', () => {
    // The bug this prevents: capacity found two lanes while the facet found none.
    expect(resourceValues(withContext, 'contexts')).toEqual(['business', 'personal']);

    // `contexts` is already a built-in facet, so it is not offered twice — the
    // built-in one is what the filter uses, and it must see the same values.
    const facets = buildFacets(CATALOG, 'contexts');
    expect(facets.filter((f) => f.id === 'field:contexts')).toEqual([]);
    expect(facets.find((f) => f.id === 'context')?.valuesOf(withContext)).toEqual([
      'business',
      'personal'
    ]);

    const { rows } = buildRows(
      [withContext],
      new Map(),
      { ...DEFAULT_LAYOUT, groupBy: 'assignee', resourceField: 'contexts' },
      (a, b) => a.title.localeCompare(b.title)
    );
    const groups = rows.filter((r) => r.kind === 'group').map((r) => r.label);
    expect(groups.sort()).toEqual(['business', 'personal']);
  });

  it('each falls back to its own empty bucket', () => {
    expect(resourceValues(withNothing, 'assignee')).toEqual([UNASSIGNED]);
    const facet = buildFacets(CATALOG, 'assignee').find((f) => f.id === 'field:assignee');
    expect(facet?.valuesOf(withNothing)).toEqual([NO_VALUE]);
  });
});

describe('resourceLabel', () => {
  it('keeps calling it Assignee when it is one', () => {
    expect(resourceLabel('assignee')).toBe('Assignee');
  });

  it('names whatever property was chosen instead', () => {
    // A chart keyed on contexts offering a facet called "Assignee" is a lie.
    expect(resourceLabel('contexts')).toBe('Contexts');
    expect(resourceLabel('owner')).toBe('Owner');
    expect(resourceLabel('')).toBe('Resource');
  });

  it('labels the facet and its empty bucket from the property', () => {
    const facet = buildFacets(CATALOG, 'owner').find((f) => f.id === 'field:owner');
    expect(facet?.label).toBe('Owner');
    expect(facet?.labelOf(NO_VALUE)).toBe('No owner');
  });

  it('does not offer a second facet for a field already listed', () => {
    // Pointing the resource property at `contexts` used to produce "Context" and
    // "Contexts" side by side, the same values twice.
    for (const [field, existing] of [
      ['contexts', 'context'],
      ['projects', 'project'],
      ['tags', 'tag'],
      ['status', 'status'],
      ['priority', 'priority']
    ] as const) {
      const facets = buildFacets(CATALOG, field);
      expect(facets.filter((f) => f.id === `field:${field}`)).toEqual([]);
      expect(facets.filter((f) => f.id === existing)).toHaveLength(1);
    }
  });

  it('still offers one for a property of the user’s own', () => {
    const facets = buildFacets(CATALOG, 'owner');
    expect(facets.filter((f) => f.id === 'field:owner')).toHaveLength(1);
  });
});
