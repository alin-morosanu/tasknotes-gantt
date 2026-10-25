import type { GanttTask } from '../src/types';
import { parseTaskDate } from '../src/model/dates';
import { buildSnapshot, type AgentSnapshot } from '../src/agent/snapshot';
import { buildIdMap, type IdMap } from '../src/agent/ids';
import { parseProposal, type ParsedProposal } from '../src/agent/proposal';
import { simulate, type SimulationResult } from '../src/agent/simulate';
import { buildReport, type ValidationReport } from '../src/agent/diff';
import { planWrites, type WritePlan } from './apply';
import type { VaultData } from './vault';

/**
 * The pipeline both front doors run.
 *
 * The CLI maps flags onto it and the MCP server maps tool arguments onto it, so the
 * two cannot answer the same question differently — which is the whole point of the
 * shared core. Neither of them reasons about a vault on its own.
 */

export interface ScopeOptions {
  /** Values of the user-defined initiative field. */
  initiatives?: readonly string[];
  /** Substrings of a project name; matching is case-insensitive. */
  projects?: readonly string[];
  statuses?: readonly string[];
  /** Window bounds as YYYY-MM-DD. A task is in scope if any part of it overlaps. */
  from?: string;
  to?: string;
  /** Archived tasks are excluded unless this is set. */
  includeArchived?: boolean;
}

export interface Scope {
  tasks: GanttTask[];
  description: string;
}

function clean(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v !== '');
}

/**
 * Narrow the vault to the work in question.
 *
 * Matching is case-insensitive and by substring for names, because an agent given a
 * project called "PRJ-01 Website Relaunch" will reasonably ask for "Relaunch".
 */
export function applyScope(vault: VaultData, options: ScopeOptions): Scope {
  let tasks = vault.tasks;
  const parts: string[] = [];

  const initiatives = clean(options.initiatives);
  if (initiatives.length > 0) {
    const wanted = initiatives.map((v) => v.toLowerCase());
    // The initiative field is user-defined; find whichever key holds it.
    const keys = vault.catalog.userFields.map((f) => f.key);
    tasks = tasks.filter((t) =>
      keys.some((key) => {
        const value = t.extra[key];
        return typeof value === 'string' && wanted.includes(value.trim().toLowerCase());
      })
    );
    parts.push(`initiative ${initiatives.join(' or ')}`);
  }

  const projects = clean(options.projects);
  if (projects.length > 0) {
    const wanted = projects.map((v) => v.toLowerCase());
    tasks = tasks.filter((t) =>
      t.projects.some((p) => {
        const name = (p.alias ?? p.target).toLowerCase();
        return wanted.some((w) => name.includes(w));
      })
    );
    parts.push(`project ${projects.join(' or ')}`);
  }

  const statuses = clean(options.statuses);
  if (statuses.length > 0) {
    const wanted = statuses.map((v) => v.toLowerCase());
    tasks = tasks.filter((t) => wanted.includes(t.status.toLowerCase()));
    parts.push(`status ${statuses.join(' or ')}`);
  }

  const from = parseTaskDate(options.from);
  const to = parseTaskDate(options.to);
  if (from !== null || to !== null) {
    // A task is in a window if any part of it falls inside, so a long task spanning
    // the window is not dropped for starting before it.
    tasks = tasks.filter((t) => {
      const start = t.scheduled?.ms ?? t.due?.ms ?? null;
      const end = t.due?.ms ?? t.scheduled?.ms ?? null;
      if (start === null || end === null) return false;
      if (from !== null && end < from.ms) return false;
      if (to !== null && start > to.ms) return false;
      return true;
    });
    parts.push(`between ${options.from ?? 'any'} and ${options.to ?? 'any'}`);
  }

  if (options.includeArchived !== true) {
    const before = tasks.length;
    tasks = tasks.filter((t) => !t.archived);
    if (tasks.length !== before) parts.push('excluding archived');
  }

  return { tasks, description: parts.length === 0 ? 'whole vault' : parts.join(', ') };
}

export function snapshotFor(vault: VaultData, scope: Scope, tasks = scope.tasks): AgentSnapshot {
  return buildSnapshot({
    vaultPath: vault.vaultPath,
    tasks,
    totalInVault: vault.tasks.length,
    scopeDescription: scope.description,
    catalog: vault.catalog,
    settings: vault.settings
  });
}

export interface Evaluation {
  ids: IdMap;
  parsed: ParsedProposal;
  applied: SimulationResult;
  report: ValidationReport;
}

/**
 * Read a proposal, simulate it, and report what it would do.
 *
 * The scope must match the snapshot the proposal was written against, or ids will not
 * resolve. Nothing here touches a file.
 */
export function evaluateProposal(vault: VaultData, scope: Scope, raw: unknown): Evaluation {
  const ids = buildIdMap(scope.tasks);
  const parsed = parseProposal(raw, ids, vault.catalog);
  const applied = simulate(scope.tasks, parsed.resolved, vault.settings, vault.catalog);
  const report = buildReport(
    snapshotFor(vault, scope),
    snapshotFor(vault, scope, applied.tasks),
    [...parsed.errors, ...applied.errors],
    parsed.proposal.rationale
  );
  return { ids, parsed, applied, report };
}

/** The file edits an evaluation implies, plus the proposal that would undo them. */
export function planFor(vault: VaultData, scope: Scope, evaluation: Evaluation): WritePlan {
  return planWrites(
    scope.tasks,
    evaluation.applied.tasks,
    evaluation.applied.touched,
    vault.catalog,
    evaluation.ids,
    evaluation.parsed.proposal.rationale
  );
}

/**
 * Whether a report's errors may be waived.
 *
 * A restored cycle is the one error a person may knowingly accept: undoing a change
 * that broke a loop necessarily puts the loop back. Parse and simulation errors stay
 * absolute — when an operation did not apply, writing would commit a change set nobody
 * described.
 */
export function onlyCycleErrors(report: ValidationReport): boolean {
  return report.errors.length > 0 && report.errors.every((e) => e.kind === 'cycle');
}

/**
 * Notes that looked like tasks but could not be read.
 *
 * Reported rather than swallowed: a file the reader skipped is work missing from every
 * total above it, and silence about it is the one thing a plan cannot afford.
 */
export function renderUnreadable(vault: VaultData): string[] {
  if (vault.unreadable.length === 0) return [];
  const lines = ['## Unreadable notes', ''];
  for (const item of vault.unreadable) lines.push(`- \`${item.path}\`: ${item.error}`);
  lines.push('');
  return lines;
}

/** The keys one file write would touch, for reporting what is about to change. */
export function touchedKeys(write: WritePlan['writes'][number]): string[] {
  return [
    ...write.edits.map((e) => e.key),
    ...(write.dependencies === undefined ? [] : [write.dependencies.key])
  ];
}
