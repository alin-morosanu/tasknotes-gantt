import { Notice, TFile, type App } from 'obsidian';
import type { TaskPath } from '../types';
import type { BaselinePatch } from '../model/baseline';

/**
 * Writes the fields this plugin owns, directly to task frontmatter.
 *
 * The split matters. Fields TaskNotes owns — scheduled, due, status, blockedBy — go
 * through its API so its caches, `dateModified` and events all stay correct. Fields
 * this plugin invents, like baselines, are not in TaskNotes' field mapping, so its API
 * has nothing to do with them and `processFrontMatter` is the right tool: it edits the
 * YAML in place without disturbing anything else in the note.
 */

export interface BaselineWriteResult {
  written: number;
  failed: { path: TaskPath; error: string }[];
  cancelled: boolean;
}

export interface FrontmatterWriterHost {
  app: App;
  isSafeMode: () => boolean;
  confirmThreshold: () => number;
  confirm: (label: string, descriptions: string[]) => Promise<boolean>;
}

interface UndoEntry {
  label: string;
  patches: BaselinePatch[];
}

export class BaselineWriter {
  private undoStack: UndoEntry[] = [];

  constructor(private host: FrontmatterWriterHost) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get nextUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  /**
   * Apply baseline patches, with the same gates as every other write path.
   *
   * Taking a baseline across a project touches every task in it, which is exactly the
   * kind of change that should be confirmed rather than assumed.
   */
  async apply(
    patches: readonly BaselinePatch[],
    fields: { start: string; end: string },
    label: string
  ): Promise<BaselineWriteResult> {
    if (patches.length === 0) return { written: 0, failed: [], cancelled: false };

    if (this.host.isSafeMode()) {
      new Notice('TaskNotes Gantt: safe mode is on — the Gantt is read-only.');
      return { written: 0, failed: [], cancelled: true };
    }

    if (patches.length > this.host.confirmThreshold()) {
      const approved = await this.host.confirm(
        label,
        patches.map((p) => p.description)
      );
      if (!approved) return { written: 0, failed: [], cancelled: true };
    }

    const result = await this.write(patches, fields);
    if (result.written > 0) {
      this.undoStack.push({
        label,
        // The inverse restores whatever was there before, including nothing.
        patches: patches.map((p) => ({
          ...p,
          start: p.previousStart,
          end: p.previousEnd,
          previousStart: p.start,
          previousEnd: p.end
        }))
      });
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    return result;
  }

  async undo(fields: { start: string; end: string }): Promise<BaselineWriteResult> {
    const entry = this.undoStack.pop();
    if (!entry) return { written: 0, failed: [], cancelled: true };
    if (this.host.isSafeMode()) {
      this.undoStack.push(entry);
      new Notice('TaskNotes Gantt: safe mode is on — the Gantt is read-only.');
      return { written: 0, failed: [], cancelled: true };
    }
    const result = await this.write(entry.patches, fields);
    if (result.written > 0) new Notice(`Undid: ${entry.label}`);
    return result;
  }

  private async write(
    patches: readonly BaselinePatch[],
    fields: { start: string; end: string }
  ): Promise<BaselineWriteResult> {
    const failed: BaselineWriteResult['failed'] = [];
    let written = 0;

    for (const patch of patches) {
      const file = this.host.app.vault.getAbstractFileByPath(patch.path);
      if (!(file instanceof TFile)) {
        failed.push({ path: patch.path, error: 'File not found' });
        continue;
      }
      try {
        await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
          // Deleting rather than writing null keeps the YAML clean: a `key:` with no
          // value would read back as a present-but-empty field.
          if (patch.start === null) delete frontmatter[fields.start];
          else frontmatter[fields.start] = patch.start;
          if (patch.end === null) delete frontmatter[fields.end];
          else frontmatter[fields.end] = patch.end;
        });
        written += 1;
      } catch (error) {
        failed.push({
          path: patch.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (failed.length > 0) {
      new Notice(
        `TaskNotes Gantt: ${failed.length} of ${patches.length} baseline writes failed. ${
          failed[0]?.error ?? ''
        }`,
        8000
      );
    }

    return { written, failed, cancelled: false };
  }
}
