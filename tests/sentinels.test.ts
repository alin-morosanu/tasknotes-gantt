import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NO_VALUE } from '../src/model/filter';
import { mergeSettings } from '../src/settings/defaults';

/**
 * The sentinels that stand for "this task has no value for that facet".
 *
 * They were once a literal NUL byte, which worked as a sentinel and made `filter.ts`
 * and `layout.ts` read as binary to grep, ripgrep and GitHub's diff view — every
 * search of the two most filter-relevant files in the repo silently found nothing.
 *
 * Every NUL below is written as an escape. A literal one in this file would bring the
 * problem back to the test that exists to prevent it.
 */

const NUL = '\u0000';

describe('sentinel values', () => {
  it('cannot collide with a real value', () => {
    // Every value reaching a facet comes from frontmatter and is rejected when blank,
    // so a leading space is unreachable from real data.
    expect(NO_VALUE).toBe(' none');
    expect(NO_VALUE.trim()).toBe('none');
    expect(NO_VALUE).not.toBe('none');
  });

  it('keeps every source file readable as text', () => {
    // Guards the rule, not just the two files that happened to break it.
    for (const file of [
      'src/model/filter.ts',
      'src/render/layout.ts',
      'src/settings/defaults.ts'
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain(NUL);
    }
  });
});

describe('migrating settings written with the old sentinel', () => {
  const stored = () => ({
    hiddenGroups: [`group:${NUL}ungrouped`, 'group:TaskNotes/Projects/PRJ-01.md'],
    filter: { text: '', facets: { project: [`${NUL}none`, 'PRJ-01.md'], status: [] } }
  });

  it('rewrites a saved "no value" facet selection', () => {
    // Without this the selection stops matching anything, with nothing to explain why.
    const merged = mergeSettings(stored());
    expect(merged.filter.facets['project']).toEqual([NO_VALUE, 'PRJ-01.md']);
  });

  it('rewrites a switched-off catch-all group', () => {
    const merged = mergeSettings(stored());
    expect(merged.hiddenGroups).toEqual([
      'group: ungrouped',
      'group:TaskNotes/Projects/PRJ-01.md'
    ]);
  });

  it('carries a stored assigneeField onto the renamed resourceField', () => {
    // Renamed once the axis was understood to be any property, not just a person.
    // Without the migration everyone's configured resource silently reverts to the
    // default and their load chart quietly measures nothing.
    const merged = mergeSettings({ assigneeField: 'contexts' });
    expect(merged.resourceField).toBe('contexts');
  });

  it('prefers the new key when both are present', () => {
    const merged = mergeSettings({ assigneeField: 'contexts', resourceField: 'owner' });
    expect(merged.resourceField).toBe('owner');
  });

  it('leaves settings that never saw the old sentinel alone', () => {
    const clean = {
      hiddenGroups: ['group:x'],
      filter: { text: 'q', facets: { status: ['done'] } }
    };
    const merged = mergeSettings(clean);
    expect(merged.hiddenGroups).toEqual(['group:x']);
    expect(merged.filter.facets['status']).toEqual(['done']);
    expect(merged.filter.text).toBe('q');
  });
});
