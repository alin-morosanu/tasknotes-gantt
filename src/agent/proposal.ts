import type { RelType, TaskNotesCatalog, TaskPath } from '../types';
import { REL_TYPES } from '../types';
import { parseDurationMinutes, parseTaskDate } from '../model/dates';
import { resolveRef, type IdMap } from './ids';

/**
 * A change set an agent proposes.
 *
 * Deliberately small and explicit. Every operation names one task and one intent, so a
 * validation report can say precisely which part of a proposal is wrong rather than
 * rejecting the whole thing — an agent that is told "operation 3 names a task that does
 * not exist" fixes it; one told "invalid proposal" guesses again.
 */

export interface SetDatesOp {
  op: 'set_dates';
  id: string;
  /** Omit to leave alone; null to clear. */
  scheduled?: string | null;
  due?: string | null;
}

export interface ShiftOp {
  op: 'shift';
  id: string;
  /** Whole days. Negative moves earlier. */
  days: number;
}

export interface SetEstimateOp {
  op: 'set_estimate';
  id: string;
  minutes: number | null;
}

export interface AddDependencyOp {
  op: 'add_dependency';
  id: string;
  blockedBy: string;
  type?: RelType;
  /** ISO-8601 duration, e.g. `PT4H`. Negative for a lead. */
  lag?: string;
}

export interface RemoveDependencyOp {
  op: 'remove_dependency';
  id: string;
  blockedBy: string;
}

export interface SetStatusOp {
  op: 'set_status';
  id: string;
  status: string;
}

export interface SetFieldOp {
  op: 'set_field';
  id: string;
  field: string;
  value: string | null;
}

export type Operation =
  | SetDatesOp
  | ShiftOp
  | SetEstimateOp
  | AddDependencyOp
  | RemoveDependencyOp
  | SetStatusOp
  | SetFieldOp;

export interface Proposal {
  version: number;
  /** Why. Carried through to the report and, later, the commit trail. */
  rationale?: string;
  operations: Operation[];
}

/** One operation with its references already resolved to vault paths. */
export interface ResolvedOperation {
  index: number;
  op: Operation;
  path: TaskPath;
  /** For dependency operations: the other end. */
  targetPath?: TaskPath;
}

export interface ProposalIssue {
  /** Index of the offending operation, or -1 for a document-level problem. */
  operation: number;
  message: string;
  /** A concrete next step, where one exists. */
  hint?: string;
  /**
   * What kind of problem this is, where a caller needs to tell them apart.
   *
   * `cycle` is the one error a human may knowingly choose to accept — undoing a
   * change that broke a loop necessarily puts the loop back.
   */
  kind?: 'cycle';
}

export interface ParsedProposal {
  proposal: Proposal;
  resolved: ResolvedOperation[];
  errors: ProposalIssue[];
}

const OPS = new Set([
  'set_dates',
  'shift',
  'set_estimate',
  'add_dependency',
  'remove_dependency',
  'set_status',
  'set_field'
]);

/**
 * Ids that look like the one an agent meant.
 *
 * A typo'd reference is the most likely failure in a generated proposal, and an error
 * naming the near misses is repairable in one step where a bare rejection is not.
 */
export function suggestIds(ref: string, map: IdMap, limit = 3): string[] {
  const wanted = ref.trim().toUpperCase();
  if (wanted === '') return [];
  const ids = [...map.byId.keys()];

  const prefix = wanted.split('-')[0] ?? wanted;
  const sameFamily = ids.filter((id) => id.toUpperCase().startsWith(prefix));
  const pool = sameFamily.length > 0 ? sameFamily : ids;

  return pool
    .map((id) => ({ id, score: distance(wanted, id.toUpperCase()) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Levenshtein distance, bounded to the short strings ids actually are. */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[cols - 1] ?? Number.MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A date field: absent, an explicit clear, or a parseable date. */
function checkDate(
  value: unknown,
  field: string,
  index: number,
  errors: ProposalIssue[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    errors.push({ operation: index, message: `\`${field}\` must be a date string or null.` });
    return undefined;
  }
  if (parseTaskDate(value) === null) {
    errors.push({
      operation: index,
      message: `\`${field}\` is not a date this vault can read: ${JSON.stringify(value)}.`,
      hint: 'Use YYYY-MM-DD, or null to clear the date.'
    });
    return undefined;
  }
  return value;
}

/**
 * Parse and resolve a proposal.
 *
 * Every problem is collected rather than throwing on the first, because an agent
 * repairing one error per round trip converges far more slowly than one handed the
 * whole list.
 */
export function parseProposal(
  input: unknown,
  ids: IdMap,
  catalog: TaskNotesCatalog
): ParsedProposal {
  const errors: ProposalIssue[] = [];
  const resolved: ResolvedOperation[] = [];
  const empty: Proposal = { version: 1, operations: [] };

  if (!isRecord(input)) {
    errors.push({
      operation: -1,
      message: 'A proposal must be a JSON object.',
      hint: 'Expected {"version": 1, "operations": [...]}.'
    });
    return { proposal: empty, resolved, errors };
  }

  const version = input['version'];
  if (version !== undefined && version !== 1) {
    errors.push({ operation: -1, message: `Unsupported proposal version: ${String(version)}.` });
  }

  const rawOperations = input['operations'];
  if (!Array.isArray(rawOperations)) {
    errors.push({
      operation: -1,
      message: '`operations` must be an array.',
      hint: 'An empty array is valid and changes nothing.'
    });
    return { proposal: empty, resolved, errors };
  }

  const statuses = new Set(catalog.statuses.map((s) => s.value));
  const operations: Operation[] = [];

  rawOperations.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push({ operation: index, message: 'Each operation must be an object.' });
      return;
    }

    const op = raw['op'];
    if (typeof op !== 'string' || !OPS.has(op)) {
      errors.push({
        operation: index,
        message: `Unknown operation: ${JSON.stringify(op)}.`,
        hint: `Expected one of ${[...OPS].join(', ')}.`
      });
      return;
    }

    const ref = raw['id'];
    if (typeof ref !== 'string') {
      errors.push({ operation: index, message: '`id` must be a string naming a task.' });
      return;
    }
    const path = resolveRef(ref, ids);
    if (path === null) {
      const suggestions = suggestIds(ref, ids);
      errors.push({
        operation: index,
        message: `No task called ${JSON.stringify(ref)}.`,
        ...(suggestions.length > 0 ? { hint: `Did you mean ${suggestions.join(', ')}?` } : {})
      });
      return;
    }

    switch (op) {
      case 'set_dates': {
        const scheduled = checkDate(raw['scheduled'], 'scheduled', index, errors);
        const due = checkDate(raw['due'], 'due', index, errors);
        if (raw['scheduled'] === undefined && raw['due'] === undefined) {
          errors.push({
            operation: index,
            message: 'set_dates changes nothing: give `scheduled`, `due`, or both.'
          });
          return;
        }
        const entry: SetDatesOp = { op: 'set_dates', id: ref };
        if (scheduled !== undefined) entry.scheduled = scheduled;
        if (due !== undefined) entry.due = due;
        operations.push(entry);
        resolved.push({ index, op: entry, path });
        return;
      }

      case 'shift': {
        const days = raw['days'];
        if (typeof days !== 'number' || !Number.isFinite(days) || !Number.isInteger(days)) {
          errors.push({
            operation: index,
            message: '`days` must be a whole number.',
            hint: 'Negative moves the task earlier.'
          });
          return;
        }
        if (days === 0) {
          errors.push({ operation: index, message: 'shift by 0 changes nothing.' });
          return;
        }
        const entry: ShiftOp = { op: 'shift', id: ref, days };
        operations.push(entry);
        resolved.push({ index, op: entry, path });
        return;
      }

      case 'set_estimate': {
        const minutes = raw['minutes'];
        if (minutes !== null && (typeof minutes !== 'number' || minutes < 0)) {
          errors.push({
            operation: index,
            message: '`minutes` must be a non-negative number, or null to clear it.',
            hint: 'An estimate of 0 marks a milestone.'
          });
          return;
        }
        const entry: SetEstimateOp = { op: 'set_estimate', id: ref, minutes };
        operations.push(entry);
        resolved.push({ index, op: entry, path });
        return;
      }

      case 'add_dependency':
      case 'remove_dependency': {
        const blockedBy = raw['blockedBy'];
        if (typeof blockedBy !== 'string') {
          errors.push({
            operation: index,
            message: '`blockedBy` must name the task this one waits for.'
          });
          return;
        }
        const targetPath = resolveRef(blockedBy, ids);
        if (targetPath === null) {
          const suggestions = suggestIds(blockedBy, ids);
          errors.push({
            operation: index,
            message: `No task called ${JSON.stringify(blockedBy)}.`,
            ...(suggestions.length > 0 ? { hint: `Did you mean ${suggestions.join(', ')}?` } : {})
          });
          return;
        }
        if (targetPath === path) {
          errors.push({
            operation: index,
            message: 'A task cannot depend on itself.'
          });
          return;
        }

        if (op === 'remove_dependency') {
          const entry: RemoveDependencyOp = { op: 'remove_dependency', id: ref, blockedBy };
          operations.push(entry);
          resolved.push({ index, op: entry, path, targetPath });
          return;
        }

        const type = raw['type'];
        if (type !== undefined && !(REL_TYPES as readonly string[]).includes(String(type))) {
          errors.push({
            operation: index,
            message: `Unknown dependency type: ${JSON.stringify(type)}.`,
            hint: `Expected one of ${REL_TYPES.join(', ')}.`
          });
          return;
        }
        const lag = raw['lag'];
        if (lag !== undefined && (typeof lag !== 'string' || parseDurationMinutes(lag) === null)) {
          errors.push({
            operation: index,
            message: `\`lag\` is not a duration this vault can read: ${JSON.stringify(lag)}.`,
            hint: 'Use an ISO-8601 duration such as PT4H or P1D. Prefix with - for a lead.'
          });
          return;
        }

        const entry: AddDependencyOp = { op: 'add_dependency', id: ref, blockedBy };
        if (type !== undefined) entry.type = type as RelType;
        if (typeof lag === 'string') entry.lag = lag;
        operations.push(entry);
        resolved.push({ index, op: entry, path, targetPath });
        return;
      }

      case 'set_status': {
        const status = raw['status'];
        if (typeof status !== 'string') {
          errors.push({ operation: index, message: '`status` must be a string.' });
          return;
        }
        if (!statuses.has(status)) {
          errors.push({
            operation: index,
            message: `${JSON.stringify(status)} is not a status in this vault.`,
            hint: `Configured statuses: ${[...statuses].join(', ')}.`
          });
          return;
        }
        const entry: SetStatusOp = { op: 'set_status', id: ref, status };
        operations.push(entry);
        resolved.push({ index, op: entry, path });
        return;
      }

      case 'set_field': {
        const field = raw['field'];
        const value = raw['value'];
        if (typeof field !== 'string' || field.trim() === '') {
          errors.push({ operation: index, message: '`field` must name a frontmatter property.' });
          return;
        }
        const name = field.trim();
        // A plain property name only. Anything else is either a mistake or an attempt to
        // smuggle a second key past validation — `x\nstatus` writes `status: done`.
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
          errors.push({
            operation: index,
            message: `\`field\` must be a plain property name, got ${JSON.stringify(field)}.`,
            hint: 'Letters, digits, `_`, `-` and `.`, starting with a letter or `_`.'
          });
          return;
        }
        // TaskNotes' own fields have dedicated operations that validate their values.
        // Writing them through set_field would skip that: a status outside the catalog,
        // a date that does not parse, a dependency list in the wrong shape.
        const owned = new Set([...Object.values(catalog.fieldMapping), 'tags']);
        if (owned.has(name)) {
          errors.push({
            operation: index,
            message: `\`${name}\` is managed by TaskNotes and cannot be set with set_field.`,
            hint: 'Use set_dates, set_status, set_estimate, add_dependency or remove_dependency.'
          });
          return;
        }
        if (value !== null && typeof value !== 'string') {
          errors.push({
            operation: index,
            message: '`value` must be a string, or null to remove the property.'
          });
          return;
        }
         
        if (typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value)) {
          errors.push({
            operation: index,
            message: '`value` must be a single line with no control characters.'
          });
          return;
        }
        const entry: SetFieldOp = { op: 'set_field', id: ref, field: name, value };
        operations.push(entry);
        resolved.push({ index, op: entry, path });
        return;
      }
    }
  });

  const proposal: Proposal = { version: 1, operations };
  const rationale = input['rationale'];
  if (typeof rationale === 'string' && rationale.trim() !== '') {
    proposal.rationale = rationale.trim();
  }

  return { proposal, resolved, errors };
}
