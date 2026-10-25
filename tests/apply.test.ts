import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GanttTask, ResolvedDependency } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { parseTaskDate } from '../src/model/dates';
import { buildIdMap } from '../src/agent/ids';
import { parseProposal } from '../src/agent/proposal';
import { simulate } from '../src/agent/simulate';
import { planWrites, renderDependencies, writePlan } from '../cli/apply';
import { readVault } from '../cli/vault';
import { makeTask } from './fixtures/build';
import { CATALOG } from './fixtures/tasks';
import { note as NOTE, readAll, removeScratchVaults, scratchVault } from './fixtures/vault';

const NOW = parseTaskDate('2026-04-13T09:00')!.ms;

const task = (id: string, over: Partial<GanttTask> = {}) =>
  makeTask({
    path: `TaskNotes/Tasks/${id}.md`,
    title: id,
    scheduled: parseTaskDate('2026-04-13'),
    due: parseTaskDate('2026-04-14'),
    ...over
  });

const ids = (tasks: GanttTask[]) => buildIdMap(tasks);

/** Run a proposal through the whole pipeline and return the write plan. */
function plan(tasks: GanttTask[], operations: unknown[], rationale?: string) {
  const map = ids(tasks);
  const parsed = parseProposal({ version: 1, operations, rationale }, map, CATALOG);
  expect(parsed.errors).toEqual([]);
  const applied = simulate(tasks, parsed.resolved, DEFAULT_SETTINGS, CATALOG, NOW);
  expect(applied.errors).toEqual([]);
  return planWrites(
    tasks,
    applied.tasks,
    applied.touched,
    CATALOG,
    map,
    parsed.proposal.rationale
  );
}

describe('planWrites', () => {
  it('writes only the keys that actually changed', () => {
    const tasks = [task('BEL-0001')];
    const { writes } = plan(tasks, [
      { op: 'set_dates', id: 'BEL-0001', due: '2026-04-20' }
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.edits).toEqual([{ key: 'due', value: '2026-04-20' }]);
  });

  it('writes both dates when a shift moves them', () => {
    const { writes } = plan([task('BEL-0001')], [{ op: 'shift', id: 'BEL-0001', days: 3 }]);
    expect(writes[0]?.edits.map((e) => e.key)).toEqual(['scheduled', 'due']);
  });

  it('names no file when the proposal changes nothing on disk', () => {
    // set_field to the value already there: simulate marks it touched, but there is
    // nothing to write, and offering to write it would be a lie.
    const tasks = [task('BEL-0001', { extra: { initiative: 'Health' } })];
    const { writes } = plan(tasks, [
      { op: 'set_field', id: 'BEL-0001', field: 'initiative', value: 'Health' }
    ]);
    expect(writes).toEqual([]);
  });

  it('uses the vault’s own field names, not literals', () => {
    const renamed = {
      ...CATALOG,
      fieldMapping: { ...CATALOG.fieldMapping, due: 'deadline', scheduled: 'starts' }
    };
    const tasks = [task('BEL-0001')];
    const map = ids(tasks);
    const parsed = parseProposal(
      { version: 1, operations: [{ op: 'shift', id: 'BEL-0001', days: 1 }] },
      map,
      renamed
    );
    const applied = simulate(tasks, parsed.resolved, DEFAULT_SETTINGS, renamed, NOW);
    const { writes } = planWrites(tasks, applied.tasks, applied.touched, renamed, map);
    expect(writes[0]?.edits.map((e) => e.key)).toEqual(['starts', 'deadline']);
  });

  it('clears a key by writing null, never an empty string', () => {
    const { writes } = plan([task('BEL-0001', { timeEstimate: 120 })], [
      { op: 'set_estimate', id: 'BEL-0001', minutes: null }
    ]);
    expect(writes[0]?.edits).toEqual([{ key: 'timeEstimate', value: null }]);
  });

  it('holds dependency changes back for the writer to shape', () => {
    const tasks = [task('BEL-0001'), task('BEL-0002')];
    const { writes } = plan(tasks, [
      { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }
    ]);
    expect(writes[0]?.edits).toEqual([]);
    expect(writes[0]?.dependencies?.key).toBe('blockedBy');
    expect(writes[0]?.dependencies?.value).toHaveLength(1);
  });
});

describe('planWrites: the undo proposal', () => {
  it('restores the dates that were there before', () => {
    const { undo } = plan([task('BEL-0001')], [{ op: 'shift', id: 'BEL-0001', days: 5 }]);
    expect(undo.operations).toEqual([
      { op: 'set_dates', id: 'BEL-0001', scheduled: '2026-04-13', due: '2026-04-14' }
    ]);
  });

  it('restores an absent date as an explicit null', () => {
    // Without the null the undo would silently leave the date the apply invented.
    const tasks = [task('BEL-0001', { scheduled: null, timeEstimate: 120 })];
    const { undo } = plan(tasks, [{ op: 'shift', id: 'BEL-0001', days: 2 }]);
    const op = undo.operations[0];
    expect(op).toMatchObject({ op: 'set_dates', scheduled: null });
  });

  it('inverts an added dependency into a removal', () => {
    const tasks = [task('BEL-0001'), task('BEL-0002')];
    const { undo } = plan(tasks, [
      { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }
    ]);
    expect(undo.operations).toEqual([
      { op: 'remove_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }
    ]);
  });

  it('inverts a removed dependency into an addition that keeps its type and lag', () => {
    const dependency: ResolvedDependency = {
      uid: 'TaskNotes/Tasks/BEL-0001',
      path: 'TaskNotes/Tasks/BEL-0001.md',
      reltype: 'STARTTOSTART',
      gap: 'PT4H'
    };
    const tasks = [task('BEL-0001'), task('BEL-0002', { dependencies: [dependency] })];
    const { undo } = plan(tasks, [
      { op: 'remove_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }
    ]);
    expect(undo.operations).toEqual([
      {
        op: 'add_dependency',
        id: 'BEL-0002',
        blockedBy: 'BEL-0001',
        type: 'STARTTOSTART',
        lag: 'PT4H'
      }
    ]);
  });

  it('carries the rationale, so the undo file says what it undoes', () => {
    const { undo } = plan([task('BEL-0001')], [{ op: 'shift', id: 'BEL-0001', days: 1 }], 'Pull in.');
    expect(undo.rationale).toBe('Undo: Pull in.');
  });
});

describe('renderDependencies', () => {
  const dep = (uid: string, over: Partial<ResolvedDependency> = {}): ResolvedDependency => ({
    uid,
    path: `${uid}.md`,
    reltype: 'FINISHTOSTART',
    ...over
  });

  it('keeps a note that writes plain links writing plain links', () => {
    expect(renderDependencies([dep('A'), dep('B')], ['[[A]]'])).toEqual([
      '[[A]]',
      '[[B]]'
    ]);
  });

  it('keeps a note that writes mappings writing mappings', () => {
    const existing = [{ uid: '[[A]]', reltype: 'FINISHTOSTART' }];
    expect(renderDependencies([dep('A'), dep('B')], existing)).toEqual([
      { uid: '[[A]]', reltype: 'FINISHTOSTART' },
      { uid: '[[B]]', reltype: 'FINISHTOSTART' }
    ]);
  });

  it('uses a mapping whenever the plain form could not carry the meaning', () => {
    expect(renderDependencies([dep('A', { reltype: 'STARTTOSTART' })], ['[[A]]'])).toEqual([
      { uid: '[[A]]', reltype: 'STARTTOSTART' }
    ]);
    expect(renderDependencies([dep('A', { gap: 'PT4H' })], ['[[A]]'])).toEqual([
      { uid: '[[A]]', reltype: 'FINISHTOSTART', gap: 'PT4H' }
    ]);
  });

  it('defaults a note with no dependencies yet to the plainer form', () => {
    expect(renderDependencies([dep('A')], undefined)).toEqual(['[[A]]']);
  });
});

/* ---------------------------------------------------------------- end to end */

/** Read the vault, run a proposal, write it, and hand back the undo. */
function applyTo(root: string, operations: unknown[]) {
  const vault = readVault(root);
  const map = buildIdMap(vault.tasks);
  const parsed = parseProposal({ version: 1, operations }, map, vault.catalog);
  expect(parsed.errors).toEqual([]);
  const applied = simulate(vault.tasks, parsed.resolved, vault.settings, vault.catalog, NOW);
  expect(applied.errors).toEqual([]);
  const written = planWrites(vault.tasks, applied.tasks, applied.touched, vault.catalog, map);
  const outcomes = writePlan(root, written);
  return { undo: written.undo, outcomes };
}

afterEach(removeScratchVaults);

describe('apply, end to end on a scratch vault', () => {
  const NOTES = {
    'BEL-0001 First.md': NOTE('BEL-0001', {
      status: 'backlog',
      priority: 'high',
      scheduled: '2026-04-13',
      due: '2026-04-14',
      timeEstimate: '120',
      initiative: 'Company Growth'
    }),
    'BEL-0002 Second.md': NOTE('BEL-0002', {
      status: 'backlog',
      priority: 'normal',
      scheduled: '2026-04-13',
      due: '2026-04-15',
      timeEstimate: '60'
    })
  };

  it('changes the dates it was asked to and nothing else', () => {
    const root = scratchVault(NOTES);
    const before = readAll(root);
    applyTo(root, [{ op: 'set_dates', id: 'BEL-0001', scheduled: '2026-04-20', due: '2026-04-22' }]);
    const after = readAll(root);

    expect(after['BEL-0002 Second.md']).toBe(before['BEL-0002 Second.md']);
    const changed = after['BEL-0001 First.md']!.split('\n').filter(
      (line, i) => line !== before['BEL-0001 First.md']!.split('\n')[i]
    );
    expect(changed).toEqual(['scheduled: 2026-04-20', 'due: 2026-04-22']);
  });

  it('is reversible: apply then undo restores every byte', () => {
    // The guarantee that makes --write safe to use on a real vault.
    const root = scratchVault(NOTES);
    const before = readAll(root);

    const { undo } = applyTo(root, [
      { op: 'shift', id: 'BEL-0001', days: 4 },
      { op: 'set_status', id: 'BEL-0002', status: 'in-progress' },
      { op: 'set_estimate', id: 'BEL-0002', minutes: 90 }
    ]);
    expect(readAll(root)).not.toEqual(before);

    applyTo(root, undo.operations);
    expect(readAll(root)).toEqual(before);
  });

  it('leaves an empty key behind when the undo clears one the change created', () => {
    // The single exception to byte-exact reversal, pinned here so it stays visible.
    // A clear cannot tell a key that was blank before from one this change added, and
    // the writer blanks rather than deletes because that is the direction that never
    // destroys a line the author wrote. `blockedBy:` reads back as no dependencies.
    const root = scratchVault(NOTES);
    const before = readAll(root);

    const { undo } = applyTo(root, [
      { op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }
    ]);
    applyTo(root, undo.operations);

    const after = readAll(root);
    expect(after['BEL-0001 First.md']).toBe(before['BEL-0001 First.md']);
    expect(after['BEL-0002 Second.md']).toBe(
      before['BEL-0002 Second.md']!.replace('  - task\n---', '  - task\nblockedBy:\n---')
    );
    // And semantically it is back where it started.
    const reread = readVault(root).tasks.find((t) => t.path.includes('BEL-0002'));
    expect(reread?.dependencies).toEqual([]);
  });

  it('clears a key by blanking it, so the change can be undone', () => {
    const root = scratchVault(NOTES);
    const before = readAll(root);
    const { undo } = applyTo(root, [{ op: 'set_estimate', id: 'BEL-0001', minutes: null }]);
    expect(readAll(root)['BEL-0001 First.md']).toContain('timeEstimate:\n');
    expect(readVault(root).tasks.find((t) => t.path.includes('BEL-0001'))?.timeEstimate).toBeNull();

    applyTo(root, undo.operations);
    expect(readAll(root)).toEqual(before);
  });

  it('restores a key that was blank to start with, byte for byte', () => {
    // These exist in the real vault: TaskNotes writes `scheduled:` with no value. A
    // clear that deleted the line could never put it back.
    const root = scratchVault({
      'BLA-0001 Blank.md': NOTE('BLA-0001', { status: 'backlog', scheduled: '', due: '' })
    });
    const before = readAll(root);
    const { undo } = applyTo(root, [
      { op: 'set_dates', id: 'BLA-0001', scheduled: '2026-05-04', due: '2026-05-05' }
    ]);
    expect(readAll(root)).not.toEqual(before);
    applyTo(root, undo.operations);
    expect(readAll(root)).toEqual(before);
  });

  it('adds a dependency key to a note that has none, in the plain form', () => {
    const root = scratchVault(NOTES);
    applyTo(root, [{ op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }]);
    const text = readAll(root)['BEL-0002 Second.md']!;
    expect(text).toContain('blockedBy:\n  - "[[TaskNotes/Tasks/BEL-0001 First]]"');

    // And the vault reads it back as the dependency that was asked for.
    const reread = readVault(root).tasks.find((t) => t.path.includes('BEL-0002'));
    expect(reread?.dependencies[0]?.path).toBe('TaskNotes/Tasks/BEL-0001 First.md');
  });

  it('reports which keys it touched in which file', () => {
    const root = scratchVault(NOTES);
    const { outcomes } = applyTo(root, [{ op: 'shift', id: 'BEL-0001', days: 1 }]);
    expect(outcomes).toEqual([
      { path: 'TaskNotes/Tasks/BEL-0001 First.md', keys: ['scheduled', 'due'] }
    ]);
  });

  it('writes nothing at all when one note in the batch cannot be edited', () => {
    // Half an applied change set is worse than none: the plan it describes never
    // existed, and the undo file no longer matches what is on disk.
    const root = scratchVault(NOTES);
    const before = readAll(root);
    const vault = readVault(root);
    const map = buildIdMap(vault.tasks);
    const parsed = parseProposal(
      {
        version: 1,
        operations: [
          { op: 'shift', id: 'BEL-0001', days: 1 },
          { op: 'shift', id: 'BEL-0002', days: 1 }
        ]
      },
      map,
      vault.catalog
    );
    const applied = simulate(vault.tasks, parsed.resolved, vault.settings, vault.catalog, NOW);
    const written = planWrites(vault.tasks, applied.tasks, applied.touched, vault.catalog, map);

    fs.rmSync(path.join(root, 'TaskNotes/Tasks/BEL-0002 Second.md'));
    expect(() => writePlan(root, written)).toThrow(/Could not read/);
    expect(readAll(root)['BEL-0001 First.md']).toBe(before['BEL-0001 First.md']);
  });
});
