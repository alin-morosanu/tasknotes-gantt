import type { Bar, TaskPath } from '../types';
import type { Row } from '../render/layout';
import { formatTaskDate, startOfDay } from '../model/dates';

/**
 * The chart as a Mermaid gantt block.
 *
 * Worth having beyond the other exports because Obsidian renders Mermaid natively:
 * pasting the result into a project note gives that note a real timeline, which is
 * what the hand-drawn ASCII diagrams in those notes were reaching for.
 */

export interface MermaidOptions {
  title?: string;
  /** Tasks on the critical path, marked `crit` so Mermaid highlights them. */
  critical?: ReadonlySet<TaskPath>;
  /** Cap the output; very large charts become unreadable and slow to render. */
  maxTasks?: number;
}

/**
 * Make a label safe for Mermaid's gantt grammar.
 *
 * A colon separates the label from its metadata, and a semicolon or newline ends the
 * entry, so those cannot survive in a name. Replaced rather than stripped, so the
 * label stays readable.
 */
export function mermaidLabel(text: string): string {
  const cleaned = text
    .replace(/[:;#]/g, '-')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A title made entirely of separators cleans down to punctuation that says nothing;
  // a placeholder is more use in a diagram than "---".
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : 'Untitled';
}

/** Mermaid section headers have the same restrictions as labels. */
export function mermaidSection(text: string): string {
  return mermaidLabel(text);
}

/** A stable, syntactically valid id for a task. */
export function mermaidId(path: string, index: number): string {
  const base = path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.md$/, '')
    .replace(/[^A-Za-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  // Ids must start with a letter, and two tasks can share a filename stem.
  return `t${index}_${base.slice(0, 40) || 'task'}`;
}

export function exportMermaid(
  rows: readonly Row[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: MermaidOptions = {}
): string {
  const max = options.maxTasks ?? 300;
  const lines: string[] = ['gantt'];
  if (options.title !== undefined && options.title.trim() !== '') {
    lines.push(`    title ${mermaidLabel(options.title)}`);
  }
  lines.push('    dateFormat YYYY-MM-DD');
  lines.push('    axisFormat %d %b');

  let emitted = 0;
  let sectionOpen = false;
  let truncated = false;

  for (const row of rows) {
    if (row.kind === 'capacity') continue;

    if (row.kind === 'group') {
      lines.push(`    section ${mermaidSection(row.label)}`);
      sectionOpen = true;
      continue;
    }
    if (!row.task) continue;

    if (emitted >= max) {
      truncated = true;
      break;
    }
    const bar = bars.get(row.task.path);
    if (!bar) continue;

    if (!sectionOpen) {
      lines.push('    section Tasks');
      sectionOpen = true;
    }

    const tags: string[] = [];
    if (row.task.completed) tags.push('done');
    else if ((row.task.progress ?? 0) > 0) tags.push('active');
    if (options.critical?.has(row.task.path)) tags.push('crit');
    if (bar.kind === 'milestone') tags.push('milestone');

    const start = formatTaskDate(startOfDay(bar.displayStartMs), true);
    // Mermaid's end date is exclusive, which is exactly what displayEndMs already is.
    const end = formatTaskDate(startOfDay(bar.displayEndMs), true);
    const id = mermaidId(row.task.path, emitted);

    const meta = [...tags, id, start, end].join(', ');
    lines.push(`    ${mermaidLabel(row.task.title)} :${meta}`);
    emitted += 1;
  }

  if (truncated) {
    lines.push(`    section Truncated`);
    lines.push(`    ${max} of more tasks shown :done, truncated, 2026-01-01, 2026-01-02`);
  }

  return lines.join('\n');
}

/** Wrap the diagram in a fenced block, ready to paste into a note. */
export function mermaidCodeBlock(diagram: string): string {
  return ['```mermaid', diagram, '```'].join('\n');
}

