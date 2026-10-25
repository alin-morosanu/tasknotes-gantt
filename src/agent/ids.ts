import type { GanttTask, TaskPath } from '../types';

/**
 * Short, stable identifiers for tasks.
 *
 * Agents refer to tasks constantly — in a snapshot they read, in a proposal they
 * write, in an answer they give back. A 60-character vault path is a poor identifier
 * for that: it is expensive to repeat, easy to mistype by a character, and a proposal
 * naming a subtly wrong path fails without saying so.
 *
 * The vault already names its tasks `BEL-0002`, `BOA-0012`, `TASK-0610`. Those are
 * short, meaningful to the user, and stable as long as the file is not renamed — so
 * they are used verbatim wherever they exist.
 */

/** A leading `PREFIX-1234` code, which is how the reference vault names every task. */
const CODE = /^([A-Za-z]{2,8}-\d{1,6})\b/;

export interface IdMap {
  /** Short id to task path. */
  byId: Map<string, TaskPath>;
  /** Task path to short id. */
  byPath: Map<TaskPath, string>;
}

function basename(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}

/**
 * Derive a candidate id from a task.
 *
 * The filename is tried before the title: a vault that codes its filenames does so
 * deliberately, and the code is what the user recognises. A task without a code falls
 * back to a slug of its name, which is longer but still readable.
 */
function candidate(task: GanttTask): string {
  const fromFile = CODE.exec(basename(task.path));
  if (fromFile?.[1]) return fromFile[1].toUpperCase();

  const fromTitle = CODE.exec(task.title);
  if (fromTitle?.[1]) return fromTitle[1].toUpperCase();

  const slug = task.title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .split(/[\s_-]+/)
    .slice(0, 4)
    .join('-')
    .toUpperCase();

  return slug === '' ? 'TASK' : slug.slice(0, 32);
}

/**
 * Build the id map for a set of tasks.
 *
 * Ids must be unique or a proposal cannot be resolved. Where two tasks want the same
 * code — the reference vault has a `PRJ-06` used twice — later ones get a numeric
 * suffix rather than the collision being ignored. Tasks are processed in path order so
 * the same vault always yields the same ids, which matters when an agent reads a
 * snapshot in one session and writes a proposal in another.
 */
export function buildIdMap(tasks: readonly GanttTask[]): IdMap {
  const byId = new Map<string, TaskPath>();
  const byPath = new Map<TaskPath, string>();

  const ordered = [...tasks].sort((a, b) => a.path.localeCompare(b.path));

  for (const task of ordered) {
    const base = candidate(task);
    let id = base;
    let suffix = 2;
    while (byId.has(id)) {
      id = `${base}#${suffix}`;
      suffix += 1;
    }
    byId.set(id, task.path);
    byPath.set(task.path, id);
  }

  return { byId, byPath };
}

/**
 * Resolve a reference an agent supplied.
 *
 * Accepts a short id, a full path, or a bare filename, because a model handed several
 * shapes across a conversation will not reliably pick the one you meant. Matching is
 * case-insensitive on the id, since a code is naturally written either way.
 */
export function resolveRef(ref: string, map: IdMap): TaskPath | null {
  const trimmed = ref.trim();
  if (trimmed === '') return null;

  const direct = map.byId.get(trimmed) ?? map.byId.get(trimmed.toUpperCase());
  if (direct !== undefined) return direct;

  if (map.byPath.has(trimmed)) return trimmed;

  const withExtension = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
  if (map.byPath.has(withExtension)) return withExtension;

  // A bare filename, which is how links are written in half the vault.
  const target = basename(withExtension).toLowerCase();
  for (const path of map.byPath.keys()) {
    if (basename(path).toLowerCase() === target) return path;
  }

  return null;
}

/** Short id for a path, or the path itself when it is not a known task. */
export function idFor(path: TaskPath, map: IdMap): string {
  return map.byPath.get(path) ?? path;
}
