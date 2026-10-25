import type { AgentSnapshot, SnapshotTask } from './snapshot';

/**
 * A snapshot rendered for reading.
 *
 * Ordered so that a truncated read still contains what matters: scope, then what is
 * wrong, then what is uncertain, then the critical chain, then the tasks. A model that
 * runs out of context halfway down has still seen the problems.
 *
 * Dates carry a marker rather than a word — `~` means the chart inferred it — because
 * the flag appears on nearly every row and spelling it out would double the table.
 */

export interface BriefOptions {
  /** Ids to expand with full detail beneath the table. */
  detail?: readonly string[];
  /** Omit the task table entirely, for a problems-only view. */
  summaryOnly?: boolean;
}

function date(d: { date: string; origin: string }): string {
  return d.origin === 'inferred' ? `~${d.date}` : d.date;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderBrief(snapshot: AgentSnapshot, options: BriefOptions = {}): string {
  const out: string[] = [];
  const push = (line = '') => out.push(line);

  push(`# Gantt snapshot — ${snapshot.scope.description}`);
  push();
  push(
    `${snapshot.scope.taskCount} of ${snapshot.scope.totalInVault} tasks in the vault. ` +
      (snapshot.timeline.start === null
        ? 'No dated work.'
        : `Timeline ${snapshot.timeline.start} to ${snapshot.timeline.end}.`)
  );
  push();
  push(
    `Working week: ${snapshot.calendar.workdays.join(', ')}, ` +
      `${snapshot.calendar.dayStart}–${snapshot.calendar.dayEnd} ` +
      `(${snapshot.calendar.hoursPerDay}h/day). ` +
      `A due date means end of that day: ${snapshot.calendar.dueDateInclusive ? 'yes' : 'no'}.`
  );
  push();

  renderProblems(snapshot, push);
  renderUnknowns(snapshot, push);
  renderResources(snapshot, push);
  renderCritical(snapshot, push);

  if (options.summaryOnly !== true) renderTable(snapshot, push);
  renderDetail(snapshot, options.detail ?? [], push);

  renderLegend(snapshot, push);

  return out.join('\n');
}

function renderProblems(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  const { conflicts, cycles } = snapshot.problems;
  if (conflicts.length === 0 && cycles.length === 0) {
    push('## Problems');
    push();
    push('None. Every task starts after the things it depends on, and there are no loops.');
    push();
    return;
  }

  push('## Problems');
  push();

  if (cycles.length > 0) {
    push(
      `**${cycles.length} circular dependenc${cycles.length === 1 ? 'y' : 'ies'}.** ` +
        'These tasks each wait on the other, so none of them can start. They are excluded ' +
        'from scheduling entirely, which is why they have no float below.'
    );
    for (const cycle of cycles) push(`- ${cycle.join(' → ')} → ${cycle[0]}`);
    push();
  }

  if (conflicts.length > 0) {
    push(
      `**${conflicts.length} task${conflicts.length === 1 ? '' : 's'} scheduled before a ` +
        'dependency allows.** Each starts earlier than the thing blocking it finishes.'
    );
    push();
    push('| Task | Must follow | Type | Too early by |');
    push('| --- | --- | --- | --- |');
    for (const c of conflicts) {
      push(`| ${c.task} | ${c.blockedBy} | ${shortRel(c.type)} | ${c.overlapDays}d |`);
    }
    push();
  }
}

function renderUnknowns(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  const u = snapshot.unknowns;
  const lines: string[] = [];

  if (u.tasksWithInferredDates > 0) {
    lines.push(
      `${u.tasksWithInferredDates} task(s) have at least one date the chart worked out ` +
        `rather than read from the note — marked \`~\` below. ${u.tasksWithoutDates} have ` +
        'no dates at all.'
    );
  }
  if (u.tasksWithoutEstimate > 0) {
    lines.push(
      `${u.tasksWithoutEstimate} task(s) have no time estimate. They contribute nothing to ` +
        'the resource totals, so those totals understate the real load.'
    );
  }
  if (u.danglingDependencies.length > 0) {
    lines.push(
      `${u.danglingDependencies.length} dependenc(y/ies) point at notes that do not exist: ` +
        u.danglingDependencies.map((d) => `${d.task} → \`${d.link}\``).join(', ') +
        '. They are not part of the schedule.'
    );
  }
  if (u.danglingProjects.length > 0) {
    lines.push(
      `${u.danglingProjects.length} project link(s) point at missing notes: ` +
        u.danglingProjects.map((p) => `\`${p.project}\` (${p.taskCount} tasks)`).join(', ') +
        '.'
    );
  }

  if (lines.length === 0) return;
  push('## What this snapshot does not know');
  push();
  for (const line of lines) push(`- ${line}`);
  push();
}

function renderResources(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  const loaded = snapshot.resources.filter((r) => r.totalHours > 0 || r.overloadedDays > 0);
  if (loaded.length === 0) return;

  push('## Load');
  push();
  push('| Resource | Tasks | Total | Capacity | Days over |');
  push('| --- | --- | --- | --- | --- |');
  for (const r of loaded) {
    const capacity = r.capacityHoursPerDay === null ? 'unbounded' : `${r.capacityHoursPerDay}h/day`;
    const missing = r.unestimatedCount > 0 ? ` (${r.unestimatedCount} unestimated)` : '';
    push(
      `| ${r.name} | ${r.taskCount}${missing} | ${r.totalHours}h | ${capacity} | ${
        r.capacityHoursPerDay === null ? '—' : r.overloadedDays
      } |`
    );
  }
  push();

  const worst = loaded.filter((r) => r.overloads.length > 0).slice(0, 3);
  for (const r of worst) {
    const days = r.overloads
      .slice(0, 6)
      .map((d) => `${d.date} (${d.hours}h)`)
      .join(', ');
    push(
      `- **${r.name}** is over ${r.capacityHoursPerDay}h on: ${days}` +
        (r.overloads.length > 6 ? `, and ${r.overloads.length - 6} more days` : '')
    );
  }
  if (worst.length > 0) push();
}

function renderCritical(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  if (snapshot.criticalPath.length === 0) return;
  push('## Critical path');
  push();
  push(
    'These tasks have no slack: any of them slipping pushes the end of the plan they ' +
      'belong to. Measured per connected group of dependencies, not across the whole vault.'
  );
  push();
  push(snapshot.criticalPath.join(' → '));
  push();
}

function shortRel(type: string): string {
  switch (type) {
    case 'FINISHTOSTART':
      return 'FS';
    case 'STARTTOSTART':
      return 'SS';
    case 'FINISHTOFINISH':
      return 'FF';
    case 'STARTTOFINISH':
      return 'SF';
    default:
      return type;
  }
}

function dependencyCell(task: SnapshotTask): string {
  if (task.dependencies.length === 0) return '';
  return task.dependencies
    .map((d) => {
      const suffix = d.type === 'FINISHTOSTART' ? '' : `:${shortRel(d.type)}`;
      return `${d.blockedBy}${suffix}${d.unresolved === true ? '?' : ''}`;
    })
    .join(' ');
}

function renderTable(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  push('## Tasks');
  push();
  push('| id | task | status | pri | start | end | est | float | blocked by |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const t of snapshot.tasks) {
    const flags = [t.critical ? '!' : '', t.milestone === true ? '◆' : ''].join('');
    const estimate = t.estimateMinutes === null ? '' : `${round(t.estimateMinutes / 60)}h`;
    const float = t.floatDays === null ? '—' : `${t.floatDays}d`;
    push(
      `| ${t.id}${flags} | ${truncate(t.title, 44)} | ${t.status} | ${t.priority} | ` +
        `${date(t.start)} | ${date(t.end)} | ${estimate} | ${float} | ${dependencyCell(t)} |`
    );
  }
  push();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function renderDetail(
  snapshot: AgentSnapshot,
  ids: readonly string[],
  push: (line?: string) => void
): void {
  if (ids.length === 0) return;
  const wanted = new Set(ids.map((id) => id.toUpperCase()));
  const tasks = snapshot.tasks.filter((t) => wanted.has(t.id.toUpperCase()));
  if (tasks.length === 0) return;

  push('## Detail');
  push();
  for (const t of tasks) {
    push(`### ${t.id} — ${t.title}`);
    push();
    push(`- path: \`${t.path}\``);
    push(`- status: ${t.status}${t.done ? ' (complete)' : ''}, priority: ${t.priority}`);
    push(`- start: ${date(t.start)}, end: ${date(t.end)}, ${t.durationDays} working days`);
    if (t.estimateMinutes !== null) push(`- estimate: ${t.estimateMinutes} minutes`);
    if (t.progress !== null) push(`- progress: ${Math.round(t.progress * 100)}%`);
    if (t.projects.length > 0) push(`- projects: ${t.projects.join(', ')}`);
    if (t.contexts.length > 0) push(`- contexts: ${t.contexts.join(', ')}`);
    if (t.assignee !== undefined) push(`- assignee: ${t.assignee}`);
    for (const [key, value] of Object.entries(t.fields)) push(`- ${key}: ${value}`);
    if (t.dependencies.length > 0) push(`- blocked by: ${dependencyCell(t)}`);
    push(`- float: ${t.floatDays === null ? 'not scheduled (in a cycle)' : `${t.floatDays} days`}`);
    push();
  }
}

function renderLegend(snapshot: AgentSnapshot, push: (line?: string) => void): void {
  push('## Legend');
  push();
  push('- `~2026-04-15` — the chart inferred this date. **Nothing in the note says it.**');
  push('- `!` after an id — on the critical path. `◆` — a milestone.');
  push('- `float` — working days the task can slip before it delays its plan. `—` means it is in a cycle and not scheduled.');
  push('- `blocked by` — ids this task waits for. `FS`/`SS`/`FF`/`SF` mark a relation other than finish-to-start; `?` means the link does not resolve.');
  push('- `too early by 0d` — the order is wrong but the overlap falls entirely on non-working days, so no actual work collides.');
  push(
    `- statuses that mean done: ${
      snapshot.vocabulary.statuses
        .filter((s) => s.done)
        .map((s) => s.value)
        .join(', ') || 'none configured'
    }.`
  );
  push();
}
