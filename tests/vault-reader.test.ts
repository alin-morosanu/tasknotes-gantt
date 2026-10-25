import { describe, expect, it } from 'vitest';
import {
  countChecklist,
  makeResolver,
  parseFrontmatter,
  splitNote
} from '../cli/vault';
import { frontmatterTags, inlineTags, isTaskNote } from '../src/data/identify';
import { normalizeTask, type NormalizeContext } from '../src/data/normalize';
import { isTaskNote as cliIsTaskNote } from '../cli/identify';
import { ALL_RECORDS, CATALOG, KNOWN_PATHS, makeResolver as fixtureResolver } from './fixtures/tasks';

/**
 * The headless reader must see the same vault the plugin does.
 *
 * If these two disagree, an agent and the chart give different answers about the same
 * notes, and neither is obviously wrong — the worst kind of divergence.
 */

describe('splitNote', () => {
  it('separates a frontmatter block from the body', () => {
    const { frontmatter, body } = splitNote('---\ntitle: A\n---\nBody text\n');
    expect(frontmatter).toBe('title: A');
    expect(body).toBe('Body text\n');
  });

  it('ignores a horizontal rule further down the note', () => {
    // `---` mid-document is a rule, not frontmatter, and treating it as one would
    // swallow half the note.
    const { frontmatter, body } = splitNote('No frontmatter here\n\n---\n\nMore text');
    expect(frontmatter).toBeNull();
    expect(body).toContain('No frontmatter here');
  });

  it('handles a note that is only frontmatter', () => {
    const { frontmatter, body } = splitNote('---\ntitle: A\n---\n');
    expect(frontmatter).toBe('title: A');
    expect(body).toBe('');
  });

  it('handles CRLF line endings', () => {
    const { frontmatter } = splitNote('---\r\ntitle: A\r\n---\r\nBody');
    expect(frontmatter).toBe('title: A');
  });
});

describe('parseFrontmatter', () => {
  it('parses the shapes the reference vault actually contains', () => {
    const fm = parseFrontmatter(
      [
        'title: "BEL-0002: Build templates"',
        'status: in-progress',
        'scheduled: 2026-04-14',
        'timeEstimate: 180',
        'tags:',
        '  - task',
        'blockedBy:',
        '  - uid: "[[TaskNotes/Tasks/BEL-0001]]"',
        '    reltype: FINISHTOSTART'
      ].join('\n')
    );
    expect(fm['status']).toBe('in-progress');
    expect(fm['timeEstimate']).toBe(180);
    expect(Array.isArray(fm['blockedBy'])).toBe(true);
  });

  it('reads a blank value as null, not as a missing key', () => {
    const fm = parseFrontmatter('scheduled:\ndue: 2026-04-16');
    expect('scheduled' in fm).toBe(true);
    expect(fm['scheduled']).toBeNull();
  });

  it('returns an empty record when there is nothing to read', () => {
    expect(parseFrontmatter(null)).toEqual({});
    expect(parseFrontmatter('   ')).toEqual({});
  });

  it('rejects a block that is not a map', () => {
    // YAML is tolerant enough to recover from most malformed input rather than throw,
    // so the guard that matters is this one: `- [}` parses to an ARRAY, and handing an
    // array downstream as frontmatter would break every field lookup after it.
    expect(parseFrontmatter('- [}')).toEqual({});
    expect(parseFrontmatter('just a string')).toEqual({});
  });

  it('never throws, whatever the note contains', () => {
    // One malformed note must not hide the other hundred and sixty.
    for (const block of ['a:\n\tb: 1', 'title: "unterminated', '{{{', ': :']) {
      expect(() => parseFrontmatter(block)).not.toThrow();
    }
  });

  it('survives an unrendered template placeholder', () => {
    // A real vault contains `date: {{date:DD-MM-YYYY}}` in template notes.
    expect(() => parseFrontmatter('date: {{date:DD-MM-YYYY}}')).not.toThrow();
  });
});

describe('countChecklist', () => {
  it('counts done and total checkboxes', () => {
    expect(countChecklist('- [ ] one\n- [x] two\n- [X] three\n')).toEqual({ done: 2, total: 3 });
  });

  it('ignores plain list items', () => {
    // One plain bullet and one unchecked box: one checklist item, none done.
    expect(countChecklist('- one\n- [ ] two\n')).toEqual({ done: 0, total: 1 });
  });

  it('counts nested items', () => {
    expect(countChecklist('- [ ] a\n  - [x] b\n')).toEqual({ done: 1, total: 2 });
  });

  it('returns zeroes for a body with no checklist', () => {
    expect(countChecklist('Just prose.')).toEqual({ done: 0, total: 0 });
  });
});

describe('makeResolver', () => {
  const paths = [
    'TaskNotes/Tasks/BEL-0001 Draft homepage copy.md',
    'TaskNotes/Projects/PRJ-01 Website Relaunch.md',
    'Archive/BEL-0001 Draft homepage copy.md'
  ];
  const resolve = makeResolver(paths);

  it('resolves a full path', () => {
    expect(resolve('TaskNotes/Tasks/BEL-0001 Draft homepage copy')).toBe(paths[0]);
  });

  it('resolves a bare filename, as Obsidian does', () => {
    expect(resolve('PRJ-01 Website Relaunch')).toBe(paths[1]);
  });

  it('prefers the shortest path when a name is ambiguous', () => {
    // Obsidian's own rule, and two notes here share a filename.
    expect(resolve('BEL-0001 Draft homepage copy')).toBe(paths[2]);
  });

  it('returns null for a link that points at nothing', () => {
    expect(resolve('Side Project')).toBeNull();
    expect(resolve('')).toBeNull();
  });
});

describe('task identification', () => {
  const ident = CATALOG.identification;

  it('identifies by frontmatter tag', () => {
    expect(cliIsTaskNote('TaskNotes/Tasks/a.md', { tags: ['task'] }, '', ident)).toBe(true);
    expect(cliIsTaskNote('TaskNotes/Tasks/a.md', { tags: ['note'] }, '', ident)).toBe(false);
  });

  it('identifies by an inline tag in the body', () => {
    expect(cliIsTaskNote('Notes/a.md', {}, 'Some text #task here', ident)).toBe(true);
  });

  it('ignores a tag inside a code block', () => {
    expect(cliIsTaskNote('Notes/a.md', {}, '```\n#task\n```', ident)).toBe(false);
  });

  it('honours excluded folders', () => {
    // The reference vault excludes templates, archive and root.
    expect(cliIsTaskNote('templates/a.md', { tags: ['task'] }, '', ident)).toBe(false);
    expect(cliIsTaskNote('archive/a.md', { tags: ['task'] }, '', ident)).toBe(false);
  });

  it('supports property identification', () => {
    const byProperty = { ...ident, method: 'property' as const, propertyName: 'isTask', propertyValue: 'true' };
    expect(isTaskNote('a.md', { isTask: true }, [], byProperty)).toBe(true);
    expect(isTaskNote('a.md', { isTask: false }, [], byProperty)).toBe(false);
    expect(isTaskNote('a.md', {}, [], byProperty)).toBe(false);
  });

  it('normalizes tags written with a hash or in mixed case', () => {
    expect(frontmatterTags(['#Task'])).toEqual(['task']);
    expect(inlineTags('text #Task more')).toEqual(['task']);
  });

  it('does not treat a bare number as a tag', () => {
    expect(inlineTags('issue #123 fixed')).toEqual([]);
  });
});

describe('parity with the plugin reader', () => {
  it('normalizes the shared fixtures identically', () => {
    // Both readers hand the same RawTaskRecord to normalizeTask; this asserts the
    // records themselves survive a round trip through YAML unchanged, so the agent
    // and the chart cannot disagree about a task.
    const resolve = fixtureResolver(KNOWN_PATHS);
    const ctx: NormalizeContext = { catalog: CATALOG, resolveLink: (t) => resolve(t) };

    for (const record of ALL_RECORDS) {
      const direct = normalizeTask(record, ctx);

      // Round-trip the frontmatter through the CLI's own parser.
      const yamlText = Object.entries(record.frontmatter)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n');
      const reparsed = parseFrontmatter(yamlText);
      const viaYaml = normalizeTask({ ...record, frontmatter: reparsed }, ctx);

      expect(viaYaml.title).toBe(direct.title);
      expect(viaYaml.status).toBe(direct.status);
      expect(viaYaml.completed).toBe(direct.completed);
      expect(viaYaml.archived).toBe(direct.archived);
      expect(viaYaml.timeEstimate).toBe(direct.timeEstimate);
      expect(viaYaml.scheduled?.raw ?? null).toBe(direct.scheduled?.raw ?? null);
      expect(viaYaml.due?.raw ?? null).toBe(direct.due?.raw ?? null);
      expect(viaYaml.dependencies).toEqual(direct.dependencies);
      expect(viaYaml.projects).toEqual(direct.projects);
      expect(viaYaml.contexts).toEqual(direct.contexts);
    }
  });
});
