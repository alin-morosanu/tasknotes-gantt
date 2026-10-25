import { describe, expect, it } from 'vitest';
import {
  basename,
  normalizeDependency,
  normalizeTask,
  parseLink,
  toNumber,
  toStringArray,
  type NormalizeContext
} from '../src/data/normalize';
import {
  BLANK_VALUES,
  CATALOG,
  COMPLETED,
  DATETIME_AND_ARCHIVED,
  DUE_ONLY_NO_TITLE,
  KNOWN_PATHS,
  makeResolver,
  MILESTONE,
  OBJECT_DEPS,
  STRING_DEPS
} from './fixtures/tasks';

const resolve = makeResolver(KNOWN_PATHS);
const ctx: NormalizeContext = { catalog: CATALOG, resolveLink: (target) => resolve(target) };

describe('parseLink', () => {
  it('parses wikilinks with and without an alias', () => {
    expect(parseLink('[[PRJ-01 Website Relaunch]]')).toEqual({
      target: 'PRJ-01 Website Relaunch'
    });
    expect(parseLink('[[TaskNotes/Tasks/BEL-0001|BEL-0001: Homepage]]')).toEqual({
      target: 'TaskNotes/Tasks/BEL-0001',
      alias: 'BEL-0001: Homepage'
    });
  });

  it('parses the markdown link form TaskNotes writes when configured to', () => {
    expect(parseLink('[BEL-0001](TaskNotes/Tasks/BEL-0001.md)')).toEqual({
      target: 'TaskNotes/Tasks/BEL-0001.md',
      alias: 'BEL-0001'
    });
  });

  it('treats a bare string as a target rather than dropping it', () => {
    expect(parseLink('PRJ-01')).toEqual({ target: 'PRJ-01' });
    expect(parseLink('  ')).toBeNull();
  });
});

describe('normalizeDependency', () => {
  it('accepts the bare-string shape and defaults the relation type', () => {
    expect(normalizeDependency('[[TaskNotes/Tasks/BEL-0002]]')).toEqual({
      uid: 'TaskNotes/Tasks/BEL-0002',
      reltype: 'FINISHTOSTART'
    });
  });

  it('accepts the object shape with an explicit relation type and gap', () => {
    expect(
      normalizeDependency({ uid: '[[BEL-0001]]', reltype: 'STARTTOSTART', gap: 'PT4H' })
    ).toEqual({ uid: 'BEL-0001', reltype: 'STARTTOSTART', gap: 'PT4H' });
  });

  it('falls back to FINISHTOSTART for an unknown relation type', () => {
    expect(normalizeDependency({ uid: '[[A]]', reltype: 'NONSENSE' })?.reltype).toBe(
      'FINISHTOSTART'
    );
    expect(normalizeDependency({ uid: '[[A]]', reltype: 'finish-to-start' })?.reltype).toBe(
      'FINISHTOSTART'
    );
  });

  it('drops entries with no usable uid', () => {
    expect(normalizeDependency({ reltype: 'FINISHTOSTART' })).toBeNull();
    expect(normalizeDependency(null)).toBeNull();
    expect(normalizeDependency(42)).toBeNull();
  });
});

describe('coercion helpers', () => {
  it('reads YAML lists, lone scalars and blanks alike', () => {
    expect(toStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(toStringArray('a')).toEqual(['a']);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray('')).toEqual([]);
    expect(toStringArray([1, 'a', null])).toEqual(['a']);
  });

  it('keeps a meaningful zero but rejects a blank', () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber('120')).toBe(120);
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber('abc')).toBeNull();
  });

  it('derives a display name from a path', () => {
    expect(basename('TaskNotes/Tasks/BOA-0002 Build checklist.md')).toBe(
      'BOA-0002 Build checklist'
    );
  });
});

describe('normalizeTask', () => {
  it('reads both authored dependency shapes from the same vault', () => {
    const objectForm = normalizeTask(OBJECT_DEPS, ctx);
    expect(objectForm.dependencies).toHaveLength(1);
    expect(objectForm.dependencies[0]?.reltype).toBe('FINISHTOSTART');
    expect(objectForm.dependencies[0]?.path).toBe(
      'TaskNotes/Tasks/BEL-0001 Draft homepage copy for review.md'
    );

    const stringForm = normalizeTask(STRING_DEPS, ctx);
    expect(stringForm.dependencies).toHaveLength(2);
    expect(stringForm.dependencies.every((d) => d.reltype === 'FINISHTOSTART')).toBe(true);
    expect(stringForm.dependencies[0]?.path).toBe(OBJECT_DEPS.path);
  });

  it('uses the status catalog rather than the literal "done" to decide completion', () => {
    expect(normalizeTask(COMPLETED, ctx).completed).toBe(true);
    expect(normalizeTask(OBJECT_DEPS, ctx).completed).toBe(false);
    // `in-progress` sorts after `done` in some catalogs; only isCompleted decides.
    expect(normalizeTask(BLANK_VALUES, ctx).completed).toBe(false);
  });

  it('treats blank frontmatter values as absent', () => {
    const task = normalizeTask(BLANK_VALUES, ctx);
    expect(task.scheduled).toBeNull();
    expect(task.due).toBeNull();
    expect(task.timeEstimate).toBeNull();
    expect(task.dependencies).toEqual([]);
  });

  it('keeps tasks whose project links dangle, and marks them as unresolved', () => {
    const task = normalizeTask(BLANK_VALUES, ctx);
    expect(task.projects).toHaveLength(2);
    expect(task.projects.every((p) => p.path === null)).toBe(true);
    expect(task.projects.map((p) => p.target)).toEqual([
      'Side Project',
      'Neighbourhood Directory'
    ]);
  });

  it('falls back to the filename when a task has no title', () => {
    expect(normalizeTask(DUE_ONLY_NO_TITLE, ctx).title).toBe(
      'BOA-0002 Build one-page moving checklist'
    );
  });

  it('keeps a due-only task with no inferred start of its own', () => {
    const task = normalizeTask(DUE_ONLY_NO_TITLE, ctx);
    expect(task.scheduled).toBeNull();
    expect(task.due).not.toBeNull();
    expect(task.timeEstimate).toBe(120);
  });

  it('preserves a zero estimate, which marks a milestone', () => {
    expect(normalizeTask(MILESTONE, ctx).timeEstimate).toBe(0);
  });

  it('reads the archive from the tag, not from a boolean property', () => {
    expect(normalizeTask(DATETIME_AND_ARCHIVED, ctx).archived).toBe(true);
    expect(normalizeTask(COMPLETED, ctx).archived).toBe(false);
  });

  it('collects non-TaskNotes fields into extra, keeping the vault’s own conventions', () => {
    expect(normalizeTask(COMPLETED, ctx).extra['assignee']).toBe('Avery');
    expect(normalizeTask(OBJECT_DEPS, ctx).extra['initiative']).toBe('Company Growth');
    // Mapped fields must not leak into extra.
    expect(normalizeTask(OBJECT_DEPS, ctx).extra['due']).toBeUndefined();
    expect(normalizeTask(OBJECT_DEPS, ctx).extra['tags']).toBeUndefined();
  });

  it('carries the manual sort key and the checklist counts through', () => {
    expect(normalizeTask(OBJECT_DEPS, ctx).sortOrder).toBe('0|hzzzzz:');
    expect(normalizeTask(STRING_DEPS, ctx).checklist).toEqual({ done: 0, total: 9 });
    expect(normalizeTask(MILESTONE, ctx).checklist).toBeNull();
  });

  it('respects a renamed field mapping instead of hardcoding property names', () => {
    const renamed: NormalizeContext = {
      catalog: {
        ...CATALOG,
        fieldMapping: { ...CATALOG.fieldMapping, due: 'deadline', timeEstimate: 'effort' }
      },
      resolveLink: (target) => resolve(target)
    };
    const task = normalizeTask(
      {
        path: 'TaskNotes/Tasks/renamed.md',
        frontmatter: { title: 'Renamed', status: 'backlog', deadline: '2026-05-01', effort: 90 }
      },
      renamed
    );
    expect(task.due?.raw).toBe('2026-05-01');
    expect(task.timeEstimate).toBe(90);
  });
});
