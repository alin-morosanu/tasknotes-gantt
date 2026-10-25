import { describe, expect, it } from 'vitest';
import type { Bar, TaskPath } from '../src/types';
import type { Row } from '../src/render/layout';
import { DEFAULT_CALENDAR } from '../src/model/calendar';
import { parseTaskDate } from '../src/model/dates';
import { computeBar, type GeometryOptions } from '../src/model/geometry';
import { csvField, exportCsv } from '../src/export/csv';
import { exportMermaid, mermaidCodeBlock, mermaidId, mermaidLabel } from '../src/export/mermaid';
import { escapeXml } from '../src/export/svg';
import { exportPath, sanitiseFileName, timestampSuffix } from '../src/export';
import { makeTask } from './fixtures/build';

const at = (s: string) => parseTaskDate(s)!.ms;
const geometry: GeometryOptions = {
  calendar: DEFAULT_CALENDAR,
  dueDateInclusive: true,
  defaultDurationMinutes: 480,
  todayMs: at('2026-04-13T09:00')
};

function taskRow(title: string, scheduled: string | null, due: string | null): Row {
  const task = makeTask({
    title,
    scheduled: scheduled === null ? null : parseTaskDate(scheduled),
    due: due === null ? null : parseTaskDate(due),
    timeEstimate: 480
  });
  return { kind: 'task', id: task.path, label: task.title, depth: 1, task };
}

function barsFor(rows: readonly Row[]): Map<TaskPath, Bar> {
  const bars = new Map<TaskPath, Bar>();
  for (const row of rows) {
    if (row.task) bars.set(row.task.path, computeBar(row.task, geometry));
  }
  for (const row of rows) {
    if (row.task) row.bar = bars.get(row.task.path);
  }
  return bars;
}

const csvOptions = {
  calendar: DEFAULT_CALENDAR,
  scheduleFor: () => null,
  varianceFor: () => null,
  minutesPerDay: 480
};

describe('csvField', () => {
  it('neutralises a cell a spreadsheet would run as a formula', () => {
    // A task titled `=HYPERLINK(...)` would otherwise execute when the CSV is opened.
    for (const danger of ['=HYPERLINK("http://x","y")', '+1+1', '-cmd', '@SUM(A1)', '\tx']) {
      expect(csvField(danger).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });

  it('leaves numbers as numbers, including negative ones already formatted', () => {
    expect(csvField('-2.00')).toBe('-2.00');
    expect(csvField('+3')).toBe('+3');
    expect(csvField(-2)).toBe('-2');
  });

  it('leaves a plain value alone', () => {
    expect(csvField('Simple')).toBe('Simple');
    expect(csvField(42)).toBe('42');
  });

  it('quotes and escapes a value containing a comma, quote or newline', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('renders absent values as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('exportCsv', () => {
  it('emits a header and one line per task', () => {
    const rows = [taskRow('A', '2026-04-14', '2026-04-16'), taskRow('B', '2026-04-15', '2026-04-15')];
    const csv = exportCsv(rows, barsFor(rows), csvOptions);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Task');
  });

  it('marks which dates the chart inferred', () => {
    // A due-only task's start was guessed; a spreadsheet must not present it as given.
    const rows = [taskRow('Due only', null, '2026-08-21')];
    const csv = exportCsv(rows, barsFor(rows), csvOptions);
    const line = csv.split('\n')[1] ?? '';
    const fields = line.split(',');
    expect(fields[6]).toBe('yes');
    expect(fields[8]).toBe('no');
  });

  it('carries the enclosing group onto each task', () => {
    const rows: Row[] = [
      { kind: 'group', id: 'group:p', label: 'PRJ-01', depth: 0, count: 1 },
      taskRow('A', '2026-04-14', '2026-04-16')
    ];
    const csv = exportCsv(rows, barsFor(rows), csvOptions);
    expect(csv.split('\n')[1]).toContain('PRJ-01');
  });

  it('escapes a title containing a comma', () => {
    const rows = [taskRow('Write copy, then review', '2026-04-14', '2026-04-16')];
    const csv = exportCsv(rows, barsFor(rows), csvOptions);
    expect(csv).toContain('"Write copy, then review"');
  });

  it('skips capacity rows, which describe no task', () => {
    const rows: Row[] = [
      { kind: 'capacity', id: 'capacity:p', label: 'load', depth: 1, members: [] },
      taskRow('A', '2026-04-14', '2026-04-16')
    ];
    expect(exportCsv(rows, barsFor(rows), csvOptions).split('\n')).toHaveLength(2);
  });
});

describe('mermaid labels and ids', () => {
  it('replaces characters that would break the gantt grammar', () => {
    // A colon separates a label from its metadata, so one inside a title would make
    // the whole entry unparseable.
    expect(mermaidLabel('BEL-0002: Build templates')).toBe('BEL-0002- Build templates');
    expect(mermaidLabel('a;b#c')).toBe('a-b-c');
    expect(mermaidLabel('line\nbreak')).toBe('line break');
  });

  it('never returns an empty label', () => {
    expect(mermaidLabel('   ')).toBe('Untitled');
    expect(mermaidLabel(':::')).toBe('Untitled');
  });

  it('builds an id that starts with a letter and is unique per row', () => {
    const a = mermaidId('TaskNotes/Tasks/BEL-0001 Draft.md', 0);
    const b = mermaidId('TaskNotes/Tasks/BEL-0001 Draft.md', 1);
    expect(a).toMatch(/^[A-Za-z]/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(' ');
  });
});

describe('exportMermaid', () => {
  it('emits a gantt block with a date format', () => {
    const rows = [taskRow('A', '2026-04-14', '2026-04-16')];
    const diagram = exportMermaid(rows, barsFor(rows));
    expect(diagram.startsWith('gantt')).toBe(true);
    expect(diagram).toContain('dateFormat YYYY-MM-DD');
  });

  it('opens a section even when the rows carry no group', () => {
    // Mermaid drops tasks that appear before any section.
    const rows = [taskRow('A', '2026-04-14', '2026-04-16')];
    expect(exportMermaid(rows, barsFor(rows))).toContain('section Tasks');
  });

  it('uses group rows as sections', () => {
    const rows: Row[] = [
      { kind: 'group', id: 'group:p', label: 'PRJ-01: Relaunch', depth: 0, count: 1 },
      taskRow('A', '2026-04-14', '2026-04-16')
    ];
    const diagram = exportMermaid(rows, barsFor(rows));
    expect(diagram).toContain('section PRJ-01- Relaunch');
  });

  it('tags completed, active, critical and milestone tasks', () => {
    const done = taskRow('Done', '2026-04-14', '2026-04-16');
    done.task!.completed = true;
    const active = taskRow('Active', '2026-04-14', '2026-04-16');
    active.task!.progress = 0.5;
    const rows = [done, active];
    const bars = barsFor(rows);
    const diagram = exportMermaid(rows, bars, { critical: new Set([active.id]) });
    expect(diagram).toContain('done,');
    expect(diagram).toContain('active,');
    expect(diagram).toContain('crit,');
  });

  it('caps the number of tasks so a huge chart stays renderable', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      taskRow(`T${i}`, '2026-04-14', '2026-04-16')
    );
    const diagram = exportMermaid(rows, barsFor(rows), { maxTasks: 10 });
    expect(diagram).toContain('Truncated');
    // 10 tasks, plus the truncation notice.
    expect(diagram.split('\n').filter((l) => l.includes(' :')).length).toBe(11);
  });

  it('wraps cleanly in a fenced block', () => {
    const rows = [taskRow('A', '2026-04-14', '2026-04-16')];
    const block = mermaidCodeBlock(exportMermaid(rows, barsFor(rows)));
    expect(block.startsWith('```mermaid\n')).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
  });
});

describe('escapeXml', () => {
  it('escapes everything that would break an SVG attribute or element', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
    expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes the ampersand first, so escapes are not double-escaped', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('export paths', () => {
  it('strips characters that are illegal in a vault path', () => {
    expect(sanitiseFileName('a/b:c*d?e')).toBe('a-b-c-d-e');
    expect(sanitiseFileName('  ')).toBe('Gantt export');
  });

  it('adds a timestamp so repeated exports do not overwrite each other', () => {
    const stamp = timestampSuffix(new Date(2026, 3, 14, 9, 5));
    expect(stamp).toBe('2026-04-14 0905');
  });

  it('places the file in the requested folder with the right extension', () => {
    const path = exportPath('Exports', 'Gantt export', 'svg');
    expect(path.startsWith('Exports/Gantt export ')).toBe(true);
    expect(path.endsWith('.svg')).toBe(true);
  });

  it('writes to the vault root when no folder is given', () => {
    expect(exportPath('', 'Chart', 'csv')).not.toContain('/');
  });

  it('tolerates a folder given with stray slashes', () => {
    expect(exportPath('/Exports/', 'Chart', 'png').startsWith('Exports/')).toBe(true);
  });

  it('writes Mermaid as markdown, since that is what renders it', () => {
    expect(exportPath('', 'Chart', 'mermaid').endsWith('.md')).toBe(true);
  });
});
