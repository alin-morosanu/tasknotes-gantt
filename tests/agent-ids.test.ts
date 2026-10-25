import { describe, expect, it } from 'vitest';
import { buildIdMap, idFor, resolveRef } from '../src/agent/ids';
import { makeTask } from './fixtures/build';

const task = (path: string, title = 'Untitled') => makeTask({ path, title });

describe('buildIdMap', () => {
  it('uses the code a vault already puts in its filenames', () => {
    const map = buildIdMap([
      task('TaskNotes/Tasks/BEL-0002 Build page templates.md'),
      task('TaskNotes/Tasks/BOA-0012 Set the moving budget.md')
    ]);
    expect([...map.byId.keys()].sort()).toEqual(['BEL-0002', 'BOA-0012']);
  });

  it('falls back to the title when the filename carries no code', () => {
    const map = buildIdMap([
      task('TaskNotes/Tasks/some note.md', 'TLS-0001: Announce skills system')
    ]);
    expect(map.byId.has('TLS-0001')).toBe(true);
  });

  it('slugs a task with no code at all', () => {
    const map = buildIdMap([task('Tasks/x.md', 'Buy milk and bread today please')]);
    const id = [...map.byId.keys()][0] ?? '';
    // Four words, so the id stays short enough to repeat.
    expect(id).toBe('BUY-MILK-AND-BREAD');
  });

  it('disambiguates a code used twice rather than losing one', () => {
    // The reference vault genuinely uses PRJ-06 for two different things.
    const map = buildIdMap([
      task('a/PRJ-06 Docs and Help Centre.md'),
      task('b/PRJ-06 Market Research.md')
    ]);
    expect(map.byId.size).toBe(2);
    expect([...map.byId.keys()].sort()).toEqual(['PRJ-06', 'PRJ-06#2']);
  });

  it('is stable regardless of the order tasks arrive in', () => {
    const a = task('a/PRJ-06 One.md');
    const b = task('b/PRJ-06 Two.md');
    const first = buildIdMap([a, b]);
    const second = buildIdMap([b, a]);
    // An agent reading a snapshot in one session and writing a proposal in another
    // must get the same ids both times.
    expect(second.byPath.get(a.path)).toBe(first.byPath.get(a.path));
    expect(second.byPath.get(b.path)).toBe(first.byPath.get(b.path));
  });

  it('never emits an empty id', () => {
    const map = buildIdMap([task('Tasks/x.md', '   ')]);
    expect([...map.byId.keys()][0]).toBeTruthy();
  });
});

describe('resolveRef', () => {
  const map = buildIdMap([
    task('TaskNotes/Tasks/BEL-0002 Build page templates.md'),
    task('TaskNotes/Tasks/BOA-0012 Set the moving budget.md')
  ]);

  it('resolves a short id', () => {
    expect(resolveRef('BEL-0002', map)).toBe(
      'TaskNotes/Tasks/BEL-0002 Build page templates.md'
    );
  });

  it('resolves an id whatever case it is written in', () => {
    expect(resolveRef('bel-0002', map)).toBe(
      'TaskNotes/Tasks/BEL-0002 Build page templates.md'
    );
  });

  it('resolves a full path, with or without the extension', () => {
    const path = 'TaskNotes/Tasks/BEL-0002 Build page templates.md';
    expect(resolveRef(path, map)).toBe(path);
    expect(resolveRef(path.replace(/\.md$/, ''), map)).toBe(path);
  });

  it('resolves a bare filename', () => {
    // A model handed several shapes across a conversation will not reliably pick one.
    expect(resolveRef('BEL-0002 Build page templates', map)).toBe(
      'TaskNotes/Tasks/BEL-0002 Build page templates.md'
    );
  });

  it('returns null for something it does not recognise', () => {
    expect(resolveRef('NOPE-9999', map)).toBeNull();
    expect(resolveRef('', map)).toBeNull();
    expect(resolveRef('   ', map)).toBeNull();
  });
});

describe('idFor', () => {
  it('gives back the path when it is not a task in scope', () => {
    const map = buildIdMap([task('TaskNotes/Tasks/BEL-0002 x.md')]);
    expect(idFor('Some/Other/Note.md', map)).toBe('Some/Other/Note.md');
  });
});
