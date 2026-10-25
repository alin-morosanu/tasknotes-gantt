import type { App, CachedMetadata, TFile } from 'obsidian';
import type { GanttTask, TaskIdentification, TaskNotesCatalog } from '../types';
import { normalizeTask, type NormalizeContext, type RawTaskRecord } from './normalize';
import { frontmatterTags, isTaskNote as matchesIdentification } from './identify';

/**
 * Reads tasks straight from Obsidian's metadata cache.
 *
 * This is the fallback path used when the TaskNotes runtime API is unavailable, and
 * it is also the cheapest way to obtain body checklist counts, which the API does not
 * expose. Everything here is read-only.
 */

/** Count `- [ ]` / `- [x]` items in a note body without reading the file. */
export function countChecklist(cache: CachedMetadata | null): { done: number; total: number } {
  const items = cache?.listItems ?? [];
  let done = 0;
  let total = 0;
  for (const item of items) {
    // `task` is undefined for plain list items and a single character for checkboxes.
    if (item.task === undefined) continue;
    total += 1;
    if (item.task !== ' ') done += 1;
  }
  return { done, total };
}

/** All tags on a note, from both frontmatter and inline `#tags`. */
function collectTags(cache: CachedMetadata | null): string[] {
  const tags = new Set(frontmatterTags(cache?.frontmatter?.['tags']));
  // Obsidian has already located the inline tags; no need to re-scan the body.
  for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, '').toLowerCase());
  return [...tags];
}

/**
 * Does this note qualify as a TaskNotes task?
 *
 * Delegates to the shared rule so the headless reader used by the CLI and this one
 * cannot disagree about which notes are tasks.
 */
export function isTaskNote(
  file: TFile,
  cache: CachedMetadata | null,
  ident: TaskIdentification
): boolean {
  return matchesIdentification(
    file.path,
    cache?.frontmatter ?? {},
    collectTags(cache),
    ident
  );
}

export class VaultAdapter {
  constructor(
    private app: App,
    private catalog: TaskNotesCatalog,
    private resolveLink: (target: string, sourcePath: string) => string | null
  ) {}

  /** Keep the adapter in step with a settings change in TaskNotes. */
  setCatalog(catalog: TaskNotesCatalog): void {
    this.catalog = catalog;
  }

  private get context(): NormalizeContext {
    return { catalog: this.catalog, resolveLink: this.resolveLink };
  }

  /** Read one file as a task, or null when it does not qualify. */
  readTask(file: TFile): GanttTask | null {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!isTaskNote(file, cache, this.catalog.identification)) return null;
    const record: RawTaskRecord = {
      path: file.path,
      frontmatter: cache?.frontmatter ?? {},
      checklist: countChecklist(cache)
    };
    return normalizeTask(record, this.context);
  }

  /** Every task note in the vault. */
  readAll(): GanttTask[] {
    const tasks: GanttTask[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const task = this.readTask(file);
      if (task) tasks.push(task);
    }
    return tasks;
  }
}
