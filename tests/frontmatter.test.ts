import { describe, expect, it } from 'vitest';
import { editFrontmatter } from '../cli/frontmatter';
import { parseFrontmatter, splitNote } from '../cli/vault';

/**
 * A note in the shape the reference vault really uses: quoted title with a colon in
 * it, bare dates, a quoted wikilink list, a manual-order key whose value would be
 * mangled by a careless writer, and a body with checkboxes.
 */
const NOTE = `---
title: "BEL-0002: Build page templates in the CMS"
status: in-progress
priority: high
scheduled: 2026-04-14
due: 2026-04-15
dateCreated: 2026-04-07T18:00:00.000+01:00
dateModified: 2026-04-11T00:21:08.410+01:00
tags:
  - task
contexts:
  - business
projects:
  - "[[PRJ-01 Website Relaunch]]"
initiative: Company Growth
timeEstimate: 180
blockedBy:
  - uid: "[[TaskNotes/Tasks/BEL-0001 Draft homepage copy for review]]"
    reltype: FINISHTOSTART
tasknotes_manual_order: "0|hzzzzz:"
---

## What needs doing
Load all 7 belief-shift emails into the CMS.

- [x] All 7 emails loaded
- [ ] Automation continues
`;

const fm = (text: string) => parseFrontmatter(splitNote(text).frontmatter);

describe('editFrontmatter', () => {
  it('changes only the line it was asked to', () => {
    const { text } = editFrontmatter(NOTE, [{ key: 'scheduled', value: '2026-05-04' }]);
    const before = NOTE.split('\n');
    const after = text.split('\n');
    const differing = after.filter((line, i) => line !== before[i]);
    expect(differing).toEqual(['scheduled: 2026-05-04']);
  });

  it('leaves key order, comments and the body untouched', () => {
    const { text } = editFrontmatter(NOTE, [{ key: 'status', value: 'done' }]);
    expect(Object.keys(fm(text))).toEqual(Object.keys(fm(NOTE)));
    expect(splitNote(text).body).toBe(splitNote(NOTE).body);
  });

  it('reports when nothing actually changed', () => {
    const result = editFrontmatter(NOTE, [{ key: 'status', value: 'in-progress' }]);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(NOTE);
  });

  it('round-trips: an unrelated key written and read back leaves every field alone', () => {
    // The guarantee that matters. A whole-block rewrite would pass a value check and
    // still reorder a hundred and sixty notes.
    const { text } = editFrontmatter(NOTE, [{ key: 'timeEstimate', value: 240 }]);
    const before = fm(NOTE);
    const after = fm(text);
    for (const key of Object.keys(before)) {
      if (key === 'timeEstimate') continue;
      expect(after[key]).toEqual(before[key]);
    }
    expect(after['timeEstimate']).toBe(240);
  });

  it('keeps the quoting style a value already had', () => {
    // `"0|hzzzzz:"` read back unquoted would end in a colon and stop being a string.
    const { text } = editFrontmatter(NOTE, [
      { key: 'tasknotes_manual_order', value: '0|hzzzzy:' }
    ]);
    expect(text).toContain('tasknotes_manual_order: "0|hzzzzy:"');
    expect(fm(text)['tasknotes_manual_order']).toBe('0|hzzzzy:');
  });

  it('quotes a value that would otherwise change type', () => {
    for (const [value, expected] of [
      ['[[Link]]', '"[[Link]]"'],
      ['2', '"2"'],
      ['yes', '"yes"'],
      ['a: b', '"a: b"'],
      ['', '""']
    ] as const) {
      const { text } = editFrontmatter(NOTE, [{ key: 'initiative', value }]);
      expect(text).toContain(`initiative: ${expected}`);
      expect(fm(text)['initiative']).toBe(value);
    }
  });

  it('leaves a plain value plain', () => {
    const { text } = editFrontmatter(NOTE, [{ key: 'initiative', value: 'Health' }]);
    expect(text).toContain('initiative: Health');
  });

  it('clears a key on null, blanking the whole block it spans', () => {
    // The key stays. A note whose `scheduled:` was cleared must still be restorable,
    // and the vault is full of notes that carry a bare key with no value.
    const { text } = editFrontmatter(NOTE, [{ key: 'blockedBy', value: null }]);
    expect(fm(text)['blockedBy']).toBeNull();
    expect(text).toContain('blockedBy:\n');
    expect(text).not.toContain('FINISHTOSTART');
    expect(fm(text)['tasknotes_manual_order']).toBe('0|hzzzzz:');
  });

  it('treats an empty list the same way', () => {
    const { text } = editFrontmatter(NOTE, [{ key: 'blockedBy', value: [] }]);
    expect(fm(text)['blockedBy']).toBeNull();
  });

  it('appends a key the note does not have, at the end of the block', () => {
    const { text } = editFrontmatter(NOTE, [{ key: 'completedDate', value: '2026-05-01' }]);
    expect(Object.keys(fm(text)).at(-1)).toBe('completedDate');
    expect(splitNote(text).body).toBe(splitNote(NOTE).body);
  });

  it('does nothing when asked to clear a key that is not there', () => {
    // Clearing must not be a way to add an empty key the note never had.
    expect(editFrontmatter(NOTE, [{ key: 'nope', value: null }]).changed).toBe(false);
  });

  it('writes a list of strings at the note’s own indentation', () => {
    const { text } = editFrontmatter(NOTE, [
      { key: 'blockedBy', value: ['[[A]]', '[[B]]'] }
    ]);
    expect(text).toContain('blockedBy:\n  - "[[A]]"\n  - "[[B]]"\n');
    expect(fm(text)['blockedBy']).toEqual(['[[A]]', '[[B]]']);
  });

  it('writes a list of mappings, continuation keys aligned under the first', () => {
    const { text } = editFrontmatter(NOTE, [
      { key: 'blockedBy', value: [{ uid: '[[A]]', reltype: 'STARTTOSTART', gap: 'PT4H' }] }
    ]);
    expect(fm(text)['blockedBy']).toEqual([
      { uid: '[[A]]', reltype: 'STARTTOSTART', gap: 'PT4H' }
    ]);
  });

  it('grows and shrinks a list without disturbing what follows', () => {
    const grown = editFrontmatter(NOTE, [
      { key: 'tags', value: ['task', 'urgent', 'business'] }
    ]).text;
    expect(fm(grown)['tags']).toEqual(['task', 'urgent', 'business']);
    expect(fm(grown)['contexts']).toEqual(['business']);

    const shrunk = editFrontmatter(grown, [{ key: 'tags', value: ['task'] }]).text;
    expect(fm(shrunk)).toEqual(fm(NOTE));
  });

  it('applies several edits in one pass', () => {
    const { text } = editFrontmatter(NOTE, [
      { key: 'scheduled', value: '2026-05-04' },
      { key: 'due', value: '2026-05-06' },
      { key: 'timeEstimate', value: null }
    ]);
    const after = fm(text);
    expect(after['scheduled']).toBe('2026-05-04');
    expect(after['due']).toBe('2026-05-06');
    expect(after['timeEstimate']).toBeNull();
  });

  it('preserves CRLF line endings', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const { text } = editFrontmatter(crlf, [{ key: 'status', value: 'done' }]);
    expect(text).toContain('status: done\r\n');
    expect(text.includes('\n\n')).toBe(false);
  });

  it('keeps blank lines and comments inside the block', () => {
    const commented = `---\ntitle: A\n\n# a note to self\nstatus: backlog\n---\nbody\n`;
    const { text } = editFrontmatter(commented, [{ key: 'status', value: 'done' }]);
    expect(text).toContain('# a note to self');
    expect(text).toContain('title: A\n\n');
  });

  it('cannot be made to end the frontmatter block from inside a value', () => {
    // `\n---\n` in a value would close the block, push the remaining keys into the
    // body, and inject text of the caller's choosing.
    const evil = 'hi\n---\ninjected body';
    const { text } = editFrontmatter(NOTE, [{ key: 'initiative', value: evil }]);
    expect(fm(text)['initiative']).toBe(evil);
    expect(fm(text)['status']).toBe('in-progress');
    expect(splitNote(text).body).toBe(splitNote(NOTE).body);
  });

  it('escapes every control character in a value', () => {
    const value = 'a\tb\rc\u0007d';
    const { text } = editFrontmatter(NOTE, [{ key: 'initiative', value }]);
    expect(fm(text)['initiative']).toBe(value);
    expect(text.split('\n').filter((l) => l.startsWith('initiative:'))).toHaveLength(1);
  });

  it('refuses a key that could start a line of its own', () => {
    // A key is written verbatim, so it can only be refused: `x\nstatus` would write a
    // second key, `status: done`, past every check made on status changes.
    for (const key of ['x\nstatus', 'a: b', '- item', '# comment', '', ' lead']) {
      expect(() => editFrontmatter(NOTE, [{ key, value: 'done' }])).toThrow(/plain name/);
    }
  });

  it('refuses a note with no frontmatter rather than inventing one', () => {
    expect(() => editFrontmatter('# Just a note\n', [{ key: 'status', value: 'done' }])).toThrow(
      /no frontmatter/
    );
  });

  it('ignores a `---` further down the note', () => {
    const withRule = `---\nstatus: backlog\n---\n\nintro\n\n---\n\nmore\n`;
    const { text } = editFrontmatter(withRule, [{ key: 'status', value: 'done' }]);
    expect(text).toBe(`---\nstatus: done\n---\n\nintro\n\n---\n\nmore\n`);
  });
});
