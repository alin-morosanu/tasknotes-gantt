import type { BasesEntry } from 'obsidian';
import type { GanttTask, TaskNotesCatalog } from '../types';
import { normalizeTask, type NormalizeContext, type RawTaskRecord } from './normalize';

/**
 * Turns Bases query results into Gantt tasks.
 *
 * This is what makes the Bases view worth having: every filter, formula and saved view
 * in the user's `.base` files already decides which rows arrive here, so the chart
 * inherits all of it without reimplementing a filter UI.
 */

/**
 * Recover the frontmatter of an entry.
 *
 * `BasesEntry.getValue` returns wrapped `Value` objects shaped for Bases' own
 * rendering, and unwrapping every property type is fragile. The metadata cache holds
 * the same frontmatter in the plain form the normalizer already handles, so entries
 * are resolved back through the file instead.
 */
export interface BasesAdapterDeps {
  getFrontmatter: (path: string) => Record<string, unknown> | null;
  getChecklist: (path: string) => { done: number; total: number } | undefined;
  catalog: TaskNotesCatalog;
  resolveLink: (target: string, sourcePath: string) => string | null;
}

export function tasksFromEntries(
  entries: readonly BasesEntry[],
  deps: BasesAdapterDeps
): GanttTask[] {
  const ctx: NormalizeContext = { catalog: deps.catalog, resolveLink: deps.resolveLink };
  const tasks: GanttTask[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const path = entry.file?.path;
    if (typeof path !== 'string' || seen.has(path)) continue;
    seen.add(path);

    const frontmatter = deps.getFrontmatter(path);
    // A Bases query can return notes that are not tasks at all; those have nothing
    // for the chart to draw, so they are skipped rather than rendered as empty rows.
    if (!frontmatter) continue;

    const record: RawTaskRecord = { path, frontmatter };
    const checklist = deps.getChecklist(path);
    if (checklist) record.checklist = checklist;
    tasks.push(normalizeTask(record, ctx));
  }

  return tasks;
}
