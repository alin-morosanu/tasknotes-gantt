import type { AgentSnapshot, SnapshotTask } from './snapshot';
import type { ProposalIssue } from './proposal';

/**
 * What a proposal would do, compared against what is there now.
 *
 * The report separates three things an agent needs to weigh differently: what makes
 * the change impossible, what it would break, and what it would fix. Collapsing them
 * into one list would leave a model unable to tell a blocker from a trade-off.
 */

export interface TaskChange {
  id: string;
  title: string;
  fields: { field: string; before: string; after: string }[];
}

export interface ValidationReport {
  /** False when anything in `errors` would prevent the change being applied. */
  ok: boolean;
  rationale?: string;
  errors: ProposalIssue[];
  regressions: string[];
  improvements: string[];
  neutral: string[];
  changes: TaskChange[];
  summary: {
    tasksChanged: number;
    conflicts: { before: number; after: number };
    cycles: { before: number; after: number };
    overloadedDays: { before: number; after: number };
    criticalTasks: { before: number; after: number };
    projectEnd: { before: string | null; after: string | null };
  };
}

function dateText(d: { date: string; origin: string }): string {
  return d.origin === 'inferred' ? `~${d.date}` : d.date;
}

function overloadedDays(snapshot: AgentSnapshot): number {
  return snapshot.resources.reduce((total, r) => total + r.overloadedDays, 0);
}

/** Compare one task before and after, field by field. */
function changeFor(before: SnapshotTask, after: SnapshotTask): TaskChange | null {
  const fields: TaskChange['fields'] = [];
  const compare = (field: string, a: string, b: string) => {
    if (a !== b) fields.push({ field, before: a, after: b });
  };

  compare('start', dateText(before.start), dateText(after.start));
  compare('end', dateText(before.end), dateText(after.end));
  compare('status', before.status, after.status);
  compare(
    'estimate',
    before.estimateMinutes === null ? '—' : `${before.estimateMinutes}m`,
    after.estimateMinutes === null ? '—' : `${after.estimateMinutes}m`
  );
  compare(
    'blocked by',
    before.dependencies.map((d) => d.blockedBy).join(' ') || '—',
    after.dependencies.map((d) => d.blockedBy).join(' ') || '—'
  );

  const fieldKeys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  for (const key of fieldKeys) {
    compare(key, before.fields[key] ?? '—', after.fields[key] ?? '—');
  }

  return fields.length === 0 ? null : { id: after.id, title: after.title, fields };
}

/**
 * Build the report.
 *
 * A new cycle is an error rather than a regression: a proposal that creates one cannot
 * be scheduled at all, so there is nothing to weigh.
 */
export function buildReport(
  before: AgentSnapshot,
  after: AgentSnapshot,
  errors: ProposalIssue[],
  rationale?: string
): ValidationReport {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const neutral: string[] = [];
  const blocking = [...errors];

  const beforeCycles = before.problems.cycles.length;
  const afterCycles = after.problems.cycles.length;
  if (afterCycles > beforeCycles) {
    const introduced = after.problems.cycles
      .filter((cycle) => !before.problems.cycles.some((b) => sameCycle(b, cycle)))
      .map((cycle) => cycle.join(' → '));
    blocking.push({
      operation: -1,
      kind: 'cycle',
      message: `This would create a circular dependency: ${introduced.join('; ')}.`,
      hint: 'Those tasks would each wait on the other, so none of them could start.'
    });
  } else if (afterCycles < beforeCycles) {
    improvements.push(
      `Breaks ${beforeCycles - afterCycles} circular dependenc${
        beforeCycles - afterCycles === 1 ? 'y' : 'ies'
      }.`
    );
  }

  const beforeConflicts = before.problems.conflicts.length;
  const afterConflicts = after.problems.conflicts.length;
  if (afterConflicts > beforeConflicts) {
    const introduced = after.problems.conflicts
      .filter(
        (c) => !before.problems.conflicts.some((b) => b.task === c.task && b.blockedBy === c.blockedBy)
      )
      .map((c) => `${c.task} would start ${c.overlapDays}d before ${c.blockedBy} finishes`);
    regressions.push(
      `Introduces ${afterConflicts - beforeConflicts} dependency conflict(s): ${introduced
        .slice(0, 5)
        .join('; ')}${introduced.length > 5 ? ', …' : ''}.`
    );
  } else if (afterConflicts < beforeConflicts) {
    improvements.push(
      `Resolves ${beforeConflicts - afterConflicts} dependency conflict(s)` +
        (afterConflicts === 0 ? ', leaving none.' : `, leaving ${afterConflicts}.`)
    );
  }

  const beforeOver = overloadedDays(before);
  const afterOver = overloadedDays(after);
  if (afterOver > beforeOver) {
    regressions.push(
      `Puts a resource over capacity on ${afterOver - beforeOver} more day(s).`
    );
  } else if (afterOver < beforeOver) {
    improvements.push(`Clears ${beforeOver - afterOver} day(s) of overload.`);
  }

  const beforeEnd = before.timeline.end;
  const afterEnd = after.timeline.end;
  if (beforeEnd !== null && afterEnd !== null && beforeEnd !== afterEnd) {
    if (afterEnd > beforeEnd) regressions.push(`Pushes the end of the plan out to ${afterEnd}.`);
    else improvements.push(`Pulls the end of the plan in to ${afterEnd}.`);
  }

  const beforeCritical = before.criticalPath.length;
  const afterCritical = after.criticalPath.length;
  if (afterCritical !== beforeCritical) {
    neutral.push(
      `Tasks with no slack: ${beforeCritical} → ${afterCritical}.` +
        (afterCritical > beforeCritical ? ' More of the plan is now unable to absorb a delay.' : '')
    );
  }

  const beforeById = new Map(before.tasks.map((t) => [t.id, t]));
  const changes: TaskChange[] = [];
  for (const task of after.tasks) {
    const previous = beforeById.get(task.id);
    if (!previous) continue;
    const change = changeFor(previous, task);
    if (change) changes.push(change);
  }

  // Ordered by operation, so the list reads in the same sequence as the proposal an
  // agent is about to repair. Document-level problems come last, since they are a
  // consequence of the operations rather than a fault in one of them.
  const ordered = [...blocking].sort((a, b) => {
    if (a.operation < 0) return 1;
    if (b.operation < 0) return -1;
    return a.operation - b.operation;
  });

  const report: ValidationReport = {
    ok: ordered.length === 0,
    errors: ordered,
    regressions,
    improvements,
    neutral,
    changes,
    summary: {
      tasksChanged: changes.length,
      conflicts: { before: beforeConflicts, after: afterConflicts },
      cycles: { before: beforeCycles, after: afterCycles },
      overloadedDays: { before: beforeOver, after: afterOver },
      criticalTasks: { before: beforeCritical, after: afterCritical },
      projectEnd: { before: beforeEnd, after: afterEnd }
    }
  };
  if (rationale !== undefined) report.rationale = rationale;
  return report;
}

function sameCycle(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort().join('|');
  const sortedB = [...b].sort().join('|');
  return sortedA === sortedB;
}

/** Render the report for reading. */
export function renderReport(report: ValidationReport): string {
  const out: string[] = [];
  const push = (line = '') => out.push(line);

  push(`# Validation — ${report.ok ? 'can be applied' : 'cannot be applied'}`);
  push();
  if (report.rationale !== undefined) {
    push(`Rationale: ${report.rationale}`);
    push();
  }

  if (report.errors.length > 0) {
    push('## Errors');
    push();
    push('These prevent the proposal being applied. Nothing has changed.');
    push();
    for (const issue of report.errors) {
      const where = issue.operation >= 0 ? `operation ${issue.operation}` : 'proposal';
      push(`- **${where}**: ${issue.message}${issue.hint === undefined ? '' : ` ${issue.hint}`}`);
    }
    push();
  }

  if (report.improvements.length > 0) {
    push('## What this fixes');
    push();
    for (const line of report.improvements) push(`- ${line}`);
    push();
  }

  if (report.regressions.length > 0) {
    push('## What this breaks');
    push();
    for (const line of report.regressions) push(`- ${line}`);
    push();
  }

  if (report.neutral.length > 0) {
    push('## Also worth knowing');
    push();
    for (const line of report.neutral) push(`- ${line}`);
    push();
  }

  push('## Summary');
  push();
  push('| | before | after |');
  push('| --- | --- | --- |');
  push(`| conflicts | ${report.summary.conflicts.before} | ${report.summary.conflicts.after} |`);
  push(`| cycles | ${report.summary.cycles.before} | ${report.summary.cycles.after} |`);
  push(
    `| days over capacity | ${report.summary.overloadedDays.before} | ${report.summary.overloadedDays.after} |`
  );
  push(
    `| tasks with no slack | ${report.summary.criticalTasks.before} | ${report.summary.criticalTasks.after} |`
  );
  push(
    `| end of plan | ${report.summary.projectEnd.before ?? '—'} | ${report.summary.projectEnd.after ?? '—'} |`
  );
  push();

  if (report.changes.length === 0) {
    push('No task would change.');
    push();
    return out.join('\n');
  }

  push(`## Changes (${report.changes.length} tasks)`);
  push();
  push('| task | field | before | after |');
  push('| --- | --- | --- | --- |');
  for (const change of report.changes) {
    for (const [i, field] of change.fields.entries()) {
      const label = i === 0 ? change.id : '';
      push(`| ${label} | ${field.field} | ${field.before} | ${field.after} |`);
    }
  }
  push();

  return out.join('\n');
}
