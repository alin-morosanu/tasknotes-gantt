import type { Bar, GanttTask, ScheduleNode, TaskPath } from '../types';
import type { Row } from '../render/layout';
import { formatTaskDate, startOfDay } from '../model/dates';
import { barDurationDays } from '../model/geometry';
import type { WorkingCalendar } from '../model/calendar';
import type { Variance } from '../model/baseline';

/**
 * The chart as a table.
 *
 * Exports what the chart shows, including the dates it inferred — but marks those, so
 * a spreadsheet built from this cannot mistake a guess for something the user entered.
 */

export interface CsvOptions {
  calendar: WorkingCalendar;
  scheduleFor: (path: TaskPath) => ScheduleNode | null;
  varianceFor: (path: TaskPath) => Variance | null;
  minutesPerDay: number;
}

/** Quote a field for CSV, doubling any embedded quotes. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // A text cell beginning with = + - @ or a tab is evaluated as a formula by Excel,
  // Numbers and Sheets, so a task titled `=HYPERLINK(...)` would run when the export is
  // opened. A leading apostrophe makes it literal text. Plain numbers are left alone,
  // including the ones already formatted as strings: a variance of -2.00 is data.
  if (/^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dateCell(ms: number | null): string {
  return ms === null ? '' : formatTaskDate(startOfDay(ms), true);
}

const HEADERS = [
  'Task',
  'Path',
  'Group',
  'Status',
  'Priority',
  'Start',
  'Start is inferred',
  'End',
  'End is inferred',
  'Duration (working days)',
  'Estimate (minutes)',
  'Progress',
  'Total float (working days)',
  'Critical',
  'Baseline start',
  'Baseline end',
  'Variance (working days)',
  'Blocked by'
];

export function exportCsv(
  rows: readonly Row[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: CsvOptions
): string {
  const lines: string[] = [HEADERS.map(csvField).join(',')];
  let group = '';

  for (const row of rows) {
    if (row.kind === 'group') {
      group = row.label;
      continue;
    }
    if (row.kind !== 'task' || !row.task) continue;

    const task: GanttTask = row.task;
    const bar = bars.get(task.path);
    const node = options.scheduleFor(task.path);
    const variance = options.varianceFor(task.path);

    lines.push(
      [
        task.title,
        task.path,
        group,
        task.status,
        task.priority,
        // The bar's dates, since that is what the chart drew, with a flag saying
        // whether the underlying note actually carries them.
        bar ? dateCell(bar.startMs) : '',
        task.scheduled === null ? 'yes' : 'no',
        bar ? dateCell(bar.endMs) : '',
        task.due === null ? 'yes' : 'no',
        bar ? barDurationDays(bar, options.calendar).toFixed(2) : '',
        task.timeEstimate ?? '',
        task.progress === null ? '' : Math.round(task.progress * 100),
        node ? (node.totalFloat / options.minutesPerDay).toFixed(2) : '',
        node ? (node.critical ? 'yes' : 'no') : '',
        (task.extra['ganttBaselineStart'] as string) ?? '',
        (task.extra['ganttBaselineEnd'] as string) ?? '',
        variance ? variance.endDays.toFixed(2) : '',
        task.dependencies.map((d) => d.uid).join('; ')
      ]
        .map(csvField)
        .join(',')
    );
  }

  return lines.join('\n');
}
