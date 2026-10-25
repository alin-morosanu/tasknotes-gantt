import type { Edge } from '../types';
import {
  addWorkMinutes,
  subWorkMinutes,
  workMinutesBetween,
  type WorkingCalendar
} from './calendar';

/**
 * The four dependency relation types, expressed as bounds on a successor.
 *
 * Each edge constrains either where the successor may START or where it may FINISH.
 * Keeping that distinction explicit is what lets the same code handle all four types
 * without a special case per combination.
 */

export type BoundField = 'start' | 'finish';

export interface Bound {
  field: BoundField;
  ms: number;
}

/**
 * The earliest bound an edge places on its successor, given the predecessor's early
 * dates. `gapMinutes` is lag when positive and lead when negative.
 */
export function forwardBound(
  edge: Edge,
  predEarlyStart: number,
  predEarlyFinish: number,
  cal: WorkingCalendar
): Bound {
  switch (edge.reltype) {
    case 'FINISHTOSTART':
      return { field: 'start', ms: addWorkMinutes(cal, predEarlyFinish, edge.gapMinutes) };
    case 'STARTTOSTART':
      return { field: 'start', ms: addWorkMinutes(cal, predEarlyStart, edge.gapMinutes) };
    case 'FINISHTOFINISH':
      return { field: 'finish', ms: addWorkMinutes(cal, predEarlyFinish, edge.gapMinutes) };
    case 'STARTTOFINISH':
      return { field: 'finish', ms: addWorkMinutes(cal, predEarlyStart, edge.gapMinutes) };
  }
}

/**
 * The latest bound an edge places on its PREDECESSOR, given the successor's late dates.
 * This is the backward pass, and it mirrors `forwardBound` exactly.
 */
export function backwardBound(
  edge: Edge,
  succLateStart: number,
  succLateFinish: number,
  cal: WorkingCalendar
): Bound {
  switch (edge.reltype) {
    case 'FINISHTOSTART':
      return { field: 'finish', ms: subWorkMinutes(cal, succLateStart, edge.gapMinutes) };
    case 'STARTTOSTART':
      return { field: 'start', ms: subWorkMinutes(cal, succLateStart, edge.gapMinutes) };
    case 'FINISHTOFINISH':
      return { field: 'finish', ms: subWorkMinutes(cal, succLateFinish, edge.gapMinutes) };
    case 'STARTTOFINISH':
      return { field: 'start', ms: subWorkMinutes(cal, succLateFinish, edge.gapMinutes) };
  }
}

/**
 * Resolve forward bounds into an early start.
 *
 * A finish bound is converted by walking back the task's own duration, so both kinds
 * can be maximized together.
 */
export function resolveEarlyStart(
  bounds: readonly Bound[],
  durationMinutes: number,
  cal: WorkingCalendar
): number | null {
  let es: number | null = null;
  for (const bound of bounds) {
    const candidate =
      bound.field === 'start' ? bound.ms : subWorkMinutes(cal, bound.ms, durationMinutes);
    if (es === null || candidate > es) es = candidate;
  }
  return es;
}

/** Resolve backward bounds into a late finish, the mirror of `resolveEarlyStart`. */
export function resolveLateFinish(
  bounds: readonly Bound[],
  durationMinutes: number,
  cal: WorkingCalendar
): number | null {
  let lf: number | null = null;
  for (const bound of bounds) {
    const candidate =
      bound.field === 'finish' ? bound.ms : addWorkMinutes(cal, bound.ms, durationMinutes);
    if (lf === null || candidate < lf) lf = candidate;
  }
  return lf;
}

/** A plan that contradicts its own dependencies. */
export interface Violation {
  edge: Edge;
  /** Working minutes by which the successor is too early. Always positive. */
  overlapMinutes: number;
  message: string;
}

const REL_LABEL: Record<Edge['reltype'], string> = {
  FINISHTOSTART: 'must start after',
  STARTTOSTART: 'must start no earlier than the start of',
  FINISHTOFINISH: 'must finish after',
  STARTTOFINISH: 'must finish no earlier than the start of'
};

/**
 * Check one edge against the dates actually written in the notes.
 *
 * This is deliberately separate from the critical-path pass. That pass answers "what
 * does the network imply"; this one answers "does the plan as written contradict it",
 * which is the question a user can act on by moving a bar.
 */
export function checkEdge(
  edge: Edge,
  predStart: number,
  predFinish: number,
  succStart: number,
  succFinish: number,
  cal: WorkingCalendar,
  labelFor: (path: string) => string
): Violation | null {
  const bound = forwardBound(edge, predStart, predFinish, cal);
  const actual = bound.field === 'start' ? succStart : succFinish;
  if (actual >= bound.ms) return null;

  // WORKING minutes, not elapsed ones. Dividing wall-clock time by the length of a
  // working day inflated every overlap by roughly three: a task starting 40 elapsed
  // days early was reported as 40 working days early when the real figure was 28.
  //
  // Zero is a legitimate answer and not a reason to drop the violation. Two tasks
  // scheduled Saturday to Sunday, one waiting on the other, overlap by no WORK at all
  // — but the order is still contradictory, and staying silent about it would hide a
  // real problem behind an arithmetic accident.
  const overlapMinutes = Math.max(0, Math.round(workMinutesBetween(cal, actual, bound.ms)));

  return {
    edge,
    overlapMinutes,
    message: `${labelFor(edge.to)} ${REL_LABEL[edge.reltype]} ${labelFor(edge.from)}`
  };
}
