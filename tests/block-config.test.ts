import { describe, expect, it } from 'vitest';
import type { GanttTask } from '../src/types';
import { buildFacets, NO_VALUE } from '../src/model/filter';
import {
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  parseBlockConfig,
  resolveSelectors
} from '../src/settings/block-config';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';

const parse = (source: string) => parseBlockConfig(source, CATALOG, 'assignee');

/** Tasks shaped like the reference vault: real project paths, contexts, a user field. */
const TASKS: GanttTask[] = [
  makeTask({
    path: 'TaskNotes/Tasks/BEL-0001.md',
    title: 'BEL-0001: Draft homepage copy',
    status: 'backlog',
    contexts: ['business'],
    projects: [
      {
        raw: '[[PRJ-01 Website Relaunch]]',
        target: 'PRJ-01 Website Relaunch',
        path: 'TaskNotes/Projects/PRJ-01 Website Relaunch.md'
      }
    ],
    extra: { initiative: 'Company Growth' }
  }),
  makeTask({
    path: 'TaskNotes/Tasks/BLO-0001.md',
    title: 'BLO-0001: Set up docs platform',
    status: 'in-progress',
    contexts: ['business'],
    projects: [
      {
        raw: '[[PRJ-06 Docs & Help Centre]]',
        target: 'PRJ-06 Docs & Help Centre',
        path: 'TaskNotes/Projects/PRJ-06 Docs & Help Centre.md'
      }
    ],
    extra: { initiative: 'Company Growth' }
  }),
  makeTask({
    path: 'TaskNotes/Tasks/BLO-0002.md',
    title: 'BLO-0002: Keyword research',
    status: 'backlog',
    projects: [
      {
        raw: '[[Docs]]',
        target: 'Docs',
        path: 'TaskNotes/Projects/Docs.md'
      }
    ]
  }),
  makeTask({
    path: 'TaskNotes/Tasks/LOOSE-0001.md',
    title: 'LOOSE-0001: No project at all',
    status: 'backlog'
  })
];

const FACETS = buildFacets(CATALOG, 'assignee');
const resolve = (source: string) => {
  const config = parse(source);
  return { config, ...resolveSelectors(config.selectors, FACETS, TASKS, config.text) };
};

describe('parseBlockConfig: display options', () => {
  it('defaults to a read-only chart of a usable height', () => {
    const config = parse('');
    expect(config.editable).toBe(false);
    expect(config.height).toBe(DEFAULT_HEIGHT);
    expect(config.settings).toEqual({});
    expect(config.errors).toEqual([]);
  });

  it('reads zoom, grouping and sorting', () => {
    const config = parse('zoom: month\ngroupBy: none\nsort: due');
    expect(config.settings.zoom).toBe('month');
    expect(config.settings.groupBy).toBe('none');
    expect(config.settings.sortKey).toBe('due');
  });

  it('names the valid values when one is wrong', () => {
    // An error that lists the alternatives is fixable without opening the docs.
    const config = parse('zoom: fortnight');
    expect(config.errors[0]).toContain('day, week, month, quarter');
    expect(config.settings.zoom).toBeUndefined();
  });

  it('clamps a height rather than rendering something unusable', () => {
    expect(parse('height: 4').height).toBe(MIN_HEIGHT);
    expect(parse('height: 99999').height).toBe(MAX_HEIGHT);
    expect(parse('height: 500').height).toBe(500);
  });

  it('accepts the several ways people write a boolean', () => {
    for (const yes of ['true', 'yes', 'on', '1', 'TRUE']) {
      expect(parse(`editable: ${yes}`).editable).toBe(true);
    }
    for (const no of ['false', 'no', 'off', '0']) {
      expect(parse(`editable: ${no}`).editable).toBe(false);
    }
    expect(parse('editable: maybe').errors[0]).toContain('true or false');
  });

  it('maps the short toggle names onto their settings', () => {
    const config = parse('critical: true\ncapacity: yes\ncompleted: false');
    expect(config.settings.showCriticalPath).toBe(true);
    expect(config.settings.showCapacity).toBe(true);
    expect(config.settings.showCompleted).toBe(false);
  });

  it('ignores blank lines and comments', () => {
    const config = parse('\n# just a note\n\nzoom: day\n');
    expect(config.errors).toEqual([]);
    expect(config.settings.zoom).toBe('day');
  });

  it('reports a line it cannot read rather than skipping it', () => {
    // Silently ignoring a line means a chart that quietly is not what was asked for.
    expect(parse('zoom month').errors[0]).toContain('expected `key: value`');
    expect(parse('zoom:').errors[0]).toContain('no value');
    expect(parse('wibble: 3').errors[0]).toContain('Unknown option');
  });
});

describe('parseBlockConfig: filters', () => {
  it('recognises the built-in facets, singular or plural', () => {
    const config = parse('project: A\ncontexts: business\ntag: urgent');
    expect(config.selectors.map((s) => s.facetId)).toEqual(['project', 'context', 'tag']);
  });

  it('splits a comma-separated value into several wanted values', () => {
    expect(parse('status: backlog, in-progress').selectors[0]?.wanted).toEqual([
      'backlog',
      'in-progress'
    ]);
  });

  it('recognises a user-defined field by its own name', () => {
    // `initiative` is a user field in this catalog, not something the plugin knows.
    expect(parse('initiative: Company Growth').selectors[0]?.facetId).toBe(
      'field:initiative'
    );
  });

  it('rejects a field the vault does not define', () => {
    expect(parse('sponsor: Someone').errors[0]).toContain('Unknown option `sponsor`');
  });

  it('lets a display key win over a same-named field', () => {
    // Otherwise a vault with a user field called "zoom" would lose the display option.
    const catalog = {
      ...CATALOG,
      userFields: [{ id: 'x', key: 'zoom', displayName: 'Zoom', type: 'text' }]
    };
    const config = parseBlockConfig('zoom: month', catalog, 'assignee');
    expect(config.settings.zoom).toBe('month');
    expect(config.selectors).toEqual([]);
  });
});

describe('resolveSelectors', () => {
  it('matches a project by a fragment of its name', () => {
    // The facet value is a note path; nobody is going to type that in a code block.
    const { filter, errors } = resolve('project: Relaunch');
    expect(errors).toEqual([]);
    expect(filter.facets['project']).toEqual([
      'TaskNotes/Projects/PRJ-01 Website Relaunch.md'
    ]);
  });

  it('matches the exact value or the full label too', () => {
    for (const wanted of [
      'TaskNotes/Projects/PRJ-06 Docs & Help Centre.md',
      'PRJ-06 Docs & Help Centre'
    ]) {
      const { filter } = resolve(`project: ${wanted}`);
      expect(filter.facets['project']).toEqual([
        'TaskNotes/Projects/PRJ-06 Docs & Help Centre.md'
      ]);
    }
  });

  it('prefers an exact label match over a substring one', () => {
    // Two projects here are called "Docs" and "PRJ-06 Docs & Help Centre". Asking for
    // "Docs" names one of them exactly and is a substring of the other. Without the
    // exact-wins rule the chart would quietly include a project nobody asked for.
    const exact = resolve('project: Docs');
    expect(exact.filter.facets['project']).toEqual(['TaskNotes/Projects/Docs.md']);

    // A fragment that is nobody's whole name still matches everything containing it.
    const partial = resolve('project: doc');
    expect(partial.filter.facets['project']?.sort()).toEqual([
      'TaskNotes/Projects/Docs.md',
      'TaskNotes/Projects/PRJ-06 Docs & Help Centre.md'
    ]);
  });

  it('lets `none` select the empty bucket', () => {
    const { filter, errors } = resolve('project: none');
    expect(errors).toEqual([]);
    expect(filter.facets['project']).toEqual([NO_VALUE]);
  });

  it('reports a selector that matches nothing', () => {
    // An empty chart and a project with no tasks look identical on screen.
    const { errors, filter } = resolve('project: Nonexistent');
    expect(errors[0]).toContain('matches no task');
    expect(filter.facets['project']).toBeUndefined();
  });

  it('resolves a user field by its value', () => {
    const { filter, errors } = resolve('initiative: Company Growth');
    expect(errors).toEqual([]);
    expect(filter.facets['field:initiative']).toEqual(['Company Growth']);
  });

  it('carries free text through untouched', () => {
    const { filter } = resolve('text: homepage copy');
    expect(filter.text).toBe('homepage copy');
  });

  it('combines several facets, each narrowing the last', () => {
    const { filter, errors } = resolve('project: Relaunch\nstatus: backlog');
    expect(errors).toEqual([]);
    expect(Object.keys(filter.facets).sort()).toEqual(['project', 'status']);
  });
});
