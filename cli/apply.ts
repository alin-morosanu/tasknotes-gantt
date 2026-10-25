import fs from 'node:fs';
import path from 'node:path';
import type { GanttTask, ResolvedDependency, TaskNotesCatalog, TaskPath } from '../src/types';
import { DEFAULT_REL_TYPE } from '../src/types';
import { idFor, type IdMap } from '../src/agent/ids';
import type { Operation, Proposal } from '../src/agent/proposal';
import { editFrontmatter, type KeyEdit, type YamlItem } from './frontmatter';
import { parseFrontmatter, splitNote } from './vault';

/**
 * Turn a simulated result into file edits and the proposal that would undo them.
 *
 * The writes are derived by comparing the before and after tasks rather than by
 * re-reading the operations, so a `shift` lands on exactly the dates the validator
 * reported — there is no second implementation of what an operation means, and so no
 * way for the report and the write to disagree.
 */

export interface FileWrite {
  path: TaskPath;
  /** Edits that need no knowledge of the note's current text. */
  edits: KeyEdit[];
  /**
   * Present only when the dependency list changed. Rendered at write time against the
   * note's own authored shape, which normalization does not preserve.
   */
  dependencies?: { key: string; value: ResolvedDependency[] };
}

export interface WritePlan {
  writes: FileWrite[];
  /** The proposal that returns the vault to its current state. */
  undo: Proposal;
}

function sameDate(a: { raw: string } | null, b: { raw: string } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.raw === b.raw;
}

function sameDependencies(
  a: readonly ResolvedDependency[],
  b: readonly ResolvedDependency[]
): boolean {
  if (a.length !== b.length) return false;
  const key = (d: ResolvedDependency) => `${d.uid} ${d.reltype} ${d.gap ?? ''}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((v, i) => v === right[i]);
}

/** The operations that would restore one task's dependency list. */
function undoDependencies(
  id: string,
  before: readonly ResolvedDependency[],
  after: readonly ResolvedDependency[],
  ids: IdMap
): Operation[] {
  const out: Operation[] = [];
  const nameOf = (dep: ResolvedDependency) => (dep.path === null ? dep.uid : idFor(dep.path, ids));

  for (const dep of after) {
    if (!before.some((b) => b.uid === dep.uid)) {
      out.push({ op: 'remove_dependency', id, blockedBy: nameOf(dep) });
    }
  }
  for (const dep of before) {
    const still = after.find((a) => a.uid === dep.uid);
    if (still !== undefined && still.reltype === dep.reltype && still.gap === dep.gap) continue;
    out.push({
      op: 'add_dependency',
      id,
      blockedBy: nameOf(dep),
      type: dep.reltype,
      ...(dep.gap === undefined ? {} : { lag: dep.gap })
    });
  }
  return out;
}

/**
 * Compare before and after, and say what has to be written.
 *
 * Pure: takes the two task sets and returns edits. Nothing here touches a file.
 */
export function planWrites(
  before: readonly GanttTask[],
  after: readonly GanttTask[],
  touched: ReadonlySet<TaskPath>,
  catalog: TaskNotesCatalog,
  ids: IdMap,
  rationale?: string
): WritePlan {
  const map = catalog.fieldMapping;
  const beforeByPath = new Map(before.map((t) => [t.path, t]));
  const writes: FileWrite[] = [];
  const undoOperations: Operation[] = [];

  for (const task of after) {
    if (!touched.has(task.path)) continue;
    const previous = beforeByPath.get(task.path);
    if (previous === undefined) continue;

    const id = idFor(task.path, ids);
    const edits: KeyEdit[] = [];
    const write: FileWrite = { path: task.path, edits };

    const scheduledChanged = !sameDate(previous.scheduled, task.scheduled);
    const dueChanged = !sameDate(previous.due, task.due);
    if (scheduledChanged) edits.push({ key: map.scheduled, value: task.scheduled?.raw ?? null });
    if (dueChanged) edits.push({ key: map.due, value: task.due?.raw ?? null });
    if (scheduledChanged || dueChanged) {
      undoOperations.push({
        op: 'set_dates',
        id,
        ...(scheduledChanged ? { scheduled: previous.scheduled?.raw ?? null } : {}),
        ...(dueChanged ? { due: previous.due?.raw ?? null } : {})
      });
    }

    if (previous.timeEstimate !== task.timeEstimate) {
      edits.push({ key: map.timeEstimate, value: task.timeEstimate });
      undoOperations.push({ op: 'set_estimate', id, minutes: previous.timeEstimate });
    }

    if (previous.status !== task.status) {
      edits.push({ key: map.status, value: task.status });
      undoOperations.push({ op: 'set_status', id, status: previous.status });
    }

    for (const key of new Set([...Object.keys(previous.extra), ...Object.keys(task.extra)])) {
      const was = previous.extra[key];
      const now = task.extra[key];
      if (was === now) continue;
      edits.push({ key, value: now === undefined || now === null ? null : String(now) });
      undoOperations.push({
        op: 'set_field',
        id,
        field: key,
        value: was === undefined || was === null ? null : String(was)
      });
    }

    if (!sameDependencies(previous.dependencies, task.dependencies)) {
      write.dependencies = { key: map.blockedBy, value: [...task.dependencies] };
      undoOperations.push(...undoDependencies(id, previous.dependencies, task.dependencies, ids));
    }

    if (edits.length > 0 || write.dependencies !== undefined) writes.push(write);
  }

  const undo: Proposal = {
    version: 1,
    rationale: rationale === undefined ? 'Undo the previous apply.' : `Undo: ${rationale}`,
    operations: undoOperations
  };

  return { writes, undo };
}

/** Strip a wikilink and any alias down to the target, matching `parseLink`. */
function stripLink(value: string): string {
  const match = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
  const inner = match?.[1] ?? value.trim();
  const pipe = inner.indexOf('|');
  return (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
}

/**
 * Render a dependency list in the shape the note already uses.
 *
 * A note in the reference vault uses one of two authored shapes — a list of link
 * strings, or a list of `{uid, reltype}` mappings — and normalization discards which.
 * Matching each entry back to how it was written keeps an unrelated dependency from
 * being rewritten into the other form for no reason.
 */
export function renderDependencies(
  dependencies: readonly ResolvedDependency[],
  existing: unknown
): YamlItem[] {
  const shapeByUid = new Map<string, 'string' | 'object'>();
  let objects = 0;
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (typeof entry === 'string') {
        shapeByUid.set(stripLink(entry), 'string');
      } else if (typeof entry === 'object' && entry !== null) {
        const uid = (entry as Record<string, unknown>)['uid'];
        if (typeof uid === 'string') shapeByUid.set(stripLink(uid), 'object');
        objects += 1;
      }
    }
  }
  // A new entry follows whatever the note mostly does, so a note stays internally
  // consistent rather than acquiring a second style alongside the first.
  const fallback: 'string' | 'object' =
    objects > 0 && objects * 2 >= shapeByUid.size ? 'object' : 'string';

  return dependencies.map((dep) => {
    const link = `[[${dep.uid}]]`;
    const needsObject = dep.reltype !== DEFAULT_REL_TYPE || dep.gap !== undefined;
    const shape = needsObject ? 'object' : (shapeByUid.get(dep.uid) ?? fallback);
    if (shape === 'string') return link;
    return {
      uid: link,
      reltype: dep.reltype,
      ...(dep.gap === undefined ? {} : { gap: dep.gap })
    };
  });
}

export interface WriteOutcome {
  path: TaskPath;
  keys: string[];
}

/**
 * Write the plan to disk.
 *
 * Every file is read, edited and checked in memory first; nothing is written until all
 * of them succeed, so a note that cannot be edited stops the batch rather than leaving
 * half a change set applied.
 */
export function writePlan(vaultPath: string, plan: WritePlan): WriteOutcome[] {
  const pending: { file: string; text: string; outcome: WriteOutcome }[] = [];

  for (const write of plan.writes) {
    const file = path.join(vaultPath, write.path);
    let original: string;
    try {
      original = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(
        `Could not read ${write.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const edits = [...write.edits];
    if (write.dependencies !== undefined) {
      const current = parseFrontmatter(splitNote(original).frontmatter);
      edits.push({
        key: write.dependencies.key,
        value: renderDependencies(write.dependencies.value, current[write.dependencies.key])
      });
    }

    let edited;
    try {
      edited = editFrontmatter(original, edits);
    } catch (error) {
      throw new Error(
        `Could not edit ${write.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!edited.changed) continue;

    // The edited note must still read back. A block that no longer parses would take
    // the note out of the chart entirely, which is a far worse outcome than a refusal.
    const reparsed = parseFrontmatter(splitNote(edited.text).frontmatter);
    if (Object.keys(reparsed).length === 0) {
      throw new Error(`Editing ${write.path} would produce frontmatter that cannot be parsed.`);
    }
    for (const edit of edits) {
      // A cleared key reads back as absent or empty; anything else means the edit
      // landed somewhere other than where it was aimed.
      const cleared = edit.value === null || (Array.isArray(edit.value) && edit.value.length === 0);
      const value = reparsed[edit.key];
      if (cleared && value !== undefined && value !== null && value !== '') {
        throw new Error(`Clearing \`${edit.key}\` in ${write.path} did not take effect.`);
      }
    }

    pending.push({
      file,
      text: edited.text,
      outcome: { path: write.path, keys: edits.map((e) => e.key) }
    });
  }

  for (const item of pending) fs.writeFileSync(item.file, item.text, 'utf8');
  return pending.map((item) => item.outcome);
}
