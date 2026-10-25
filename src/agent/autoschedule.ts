import type { Bar, Edge, GanttTask, TaskNotesCatalog, TaskPath } from '../types';
import { calendarFrom, type GanttSettings } from '../settings/defaults';
import { addDays, formatTaskDate, startOfDay, startOfNextDay } from '../model/dates';
import {
  addWorkMinutes,
  endOfWorkday,
  normalizeCalendar,
  snapBackward,
  snapForward,
  startOfWorkday,
  subWorkMinutes,
  workDaysBetween,
  workMinutesBetween,
  type WorkingCalendar
} from '../model/calendar';
import { backwardBound, forwardBound, resolveEarlyStart, resolveLateFinish } from '../model/constraints';
import { buildAdjacency, buildEdges, detectCycles, topologicalOrder } from '../model/graph';
import { computeBars, isMilestone } from '../model/geometry';
import { computeSchedule } from '../model/schedule';
import { computeCapacity, planLevelling } from '../model/capacity';
import type { Operation } from './proposal';
import { idFor, type IdMap } from './ids';

/**
 * Lay a schedule out from scratch: forward from a start date, or back from a deadline.
 *
 * Everything here reuses the passes the chart already runs — `constraints.ts` for all
 * four relation types and their lag, `calendar.ts` for working-time arithmetic,
 * `capacity.ts` for levelling. What is new is only the direction of the question: the
 * chart asks "what do these dates imply", and this asks "what dates would satisfy the
 * network".
 *
 * It emits a proposal and writes nothing, so its output goes through `validate` and
 * `apply` like any other change.
 */

/**
 * Whole working days, throughout.
 *
 * Every date in the vault is all-day, and an all-day `scheduled` reads back as the
 * start of that working day while an inclusive `due` reads back as the end of one. A
 * schedule computed to the minute would therefore contradict itself the moment it was
 * written and read again: a task finishing Tuesday 13:00 is stored as "due Tuesday",
 * comes back as Tuesday 17:00, and its successor — placed at 13:00 — is now too early.
 * Rounding each span out to whole working days is the only granularity that survives
 * the round trip.
 */
function dayStart(cal: WorkingCalendar, ms: number): number {
  return startOfWorkday(cal, snapForward(cal, ms));
}

function dayEnd(cal: WorkingCalendar, ms: number): number {
  return endOfWorkday(cal, snapBackward(cal, ms));
}

export interface AutoscheduleInput {
  tasks: readonly GanttTask[];
  settings: GanttSettings;
  catalog: TaskNotesCatalog;
  now: number;
  /** Lay the work out forward from here. */
  startMs?: number;
  /** Or backward from here, so nothing finishes later than it must. */
  deadlineMs?: number;
  /** Also push work off days a resource is over capacity. */
  level?: boolean;
  /** Which field names the resource. Defaults to the chart's configured one. */
  resourceField?: string;
  /**
   * Rounds of levelling before giving up. Each round reschedules the whole network.
   *
   * Generous by default: the greedy pass moves one task per overloaded day per round,
   * so a hundred tasks sharing one lane genuinely need dozens. A real 108-task
   * initiative settles in 18 rounds and 0.1s, and a round is cheap — stopping early
   * would report failure on a plan that was about to converge.
   */
  levellingRounds?: number;
}

export interface ScheduledSpan {
  startMs: number;
  endMs: number;
}

export interface AutoscheduleResult {
  /** Where each task would run. Includes tasks left where they are. */
  spans: Map<TaskPath, ScheduledSpan>;
  /** Tasks deliberately not moved, and why. */
  skipped: { path: TaskPath; reason: string }[];
  /** What a reader needs to know about the result that the dates do not say. */
  notes: string[];
}

interface Prepared {
  cal: WorkingCalendar;
  edges: Edge[];
  adjacency: ReturnType<typeof buildAdjacency>;
  order: TaskPath[];
  byPath: Map<TaskPath, GanttTask>;
  bars: Map<TaskPath, Bar>;
  duration: Map<TaskPath, number>;
  fixed: Map<TaskPath, ScheduledSpan>;
  skipped: { path: TaskPath; reason: string }[];
  /** Tasks whose length nothing anchored, so the default duration was used. */
  guessed: number;
  /** Tasks whose authored span falls entirely on non-working days. */
  nonWorking: number;
}

function prepare(input: AutoscheduleInput): Prepared {
  const { tasks, settings } = input;
  const cal = normalizeCalendar(calendarFrom(settings));
  const byPath = new Map(tasks.map((t) => [t.path, t]));

  const bars = computeBars([...tasks], {
    calendar: cal,
    dueDateInclusive: settings.dueDateInclusive,
    defaultDurationMinutes: settings.defaultDurationMinutes,
    todayMs: input.now
  });

  const { edges } = buildEdges([...tasks]);
  const paths = tasks.map((t) => t.path);
  const adjacency = buildAdjacency(paths, edges);

  const cycles = detectCycles(paths, adjacency);
  const inCycle = new Set<TaskPath>();
  for (const cycle of cycles) for (const member of cycle.members) inCycle.add(member);

  const { order, unordered } = topologicalOrder(paths, adjacency, inCycle);

  const skipped: { path: TaskPath; reason: string }[] = [];
  for (const path of inCycle) {
    skipped.push({ path, reason: 'in a circular dependency, so it has no earliest start' });
  }
  for (const path of unordered) {
    skipped.push({ path, reason: 'could not be ordered against its dependencies' });
  }

  // A finished task is history. Rescheduling it would rewrite the record of when the
  // work actually happened, and its successors are better constrained by where it
  // really ran than by where a plan would have put it.
  const fixed = new Map<TaskPath, ScheduledSpan>();
  for (const path of order) {
    const task = byPath.get(path);
    const bar = bars.get(path);
    if (task === undefined || bar === undefined) continue;
    if (!task.completed) continue;
    fixed.set(path, { startMs: bar.startMs, endMs: bar.endMs });
    skipped.push({ path, reason: 'already done' });
  }

  // Duration is the working length of the task's CURRENT bar — exactly what
  // `computeSchedule` uses for the critical path. Taking it from `timeEstimate`
  // instead would quietly re-estimate the work: a task the user gave a three-day
  // window and a two-hour estimate would come back two hours long.
  //
  // The exception is a span that contains no working time at all. Several tasks in
  // the reference vault are scheduled Saturday to Sunday, which measures as zero
  // working minutes — and a zero-length task lets its finish-to-start successor begin
  // the same morning, silently reproducing the very conflict this pass exists to
  // remove. A span across a closed weekend says nothing about how long the work is,
  // so the estimate answers instead.
  const duration = new Map<TaskPath, number>();
  let guessed = 0;
  let nonWorking = 0;
  for (const path of order) {
    const task = byPath.get(path);
    const bar = bars.get(path);
    if (task === undefined || bar === undefined) continue;

    // Nothing anchors this task's length: geometry gave it the default duration, and
    // laying it out again does not make that any more real.
    const anchored = task.timeEstimate !== null || (task.scheduled !== null && task.due !== null);
    if (!anchored) guessed += 1;

    const spanMinutes = Math.max(0, workMinutesBetween(cal, bar.startMs, bar.endMs));
    if (isMilestone(task)) {
      duration.set(path, 0);
      continue;
    }
    if (spanMinutes > 0) {
      duration.set(path, spanMinutes);
      continue;
    }
    if (task.scheduled !== null || task.due !== null) nonWorking += 1;
    duration.set(path, task.timeEstimate ?? settings.defaultDurationMinutes);
  }

  return {
    cal, edges, adjacency, order, byPath, bars, duration, fixed, skipped, guessed, nonWorking
  };
}

/** One forward pass. `floor` is the earliest anything may start; `pinned` overrides it. */
function forwardPass(
  p: Prepared,
  floorMs: number,
  pinned: ReadonlyMap<TaskPath, number>
): Map<TaskPath, ScheduledSpan> {
  const spans = new Map<TaskPath, ScheduledSpan>();

  for (const path of p.order) {
    const already = p.fixed.get(path);
    if (already !== undefined) {
      spans.set(path, already);
      continue;
    }

    const minutes = p.duration.get(path) ?? 0;
    const bounds = [];
    for (const edge of p.adjacency.predecessors.get(path) ?? []) {
      const pred = spans.get(edge.from);
      if (pred === undefined) continue;
      bounds.push(forwardBound(edge, pred.startMs, pred.endMs, p.cal));
    }

    const fromNetwork = resolveEarlyStart(bounds, minutes, p.cal);
    const earliest = Math.max(fromNetwork ?? floorMs, floorMs, pinned.get(path) ?? floorMs);
    const startMs = dayStart(p.cal, earliest);
    const endMs = minutes === 0 ? startMs : dayEnd(p.cal, addWorkMinutes(p.cal, startMs, minutes));
    spans.set(path, { startMs, endMs });
  }

  return spans;
}

/** One backward pass. Nothing finishes later than `ceilingMs`. */
function backwardPass(p: Prepared, ceilingMs: number): Map<TaskPath, ScheduledSpan> {
  const spans = new Map<TaskPath, ScheduledSpan>();

  for (const path of [...p.order].reverse()) {
    const already = p.fixed.get(path);
    if (already !== undefined) {
      spans.set(path, already);
      continue;
    }

    const minutes = p.duration.get(path) ?? 0;
    const bounds = [];
    for (const edge of p.adjacency.successors.get(path) ?? []) {
      const succ = spans.get(edge.to);
      if (succ === undefined) continue;
      bounds.push(backwardBound(edge, succ.startMs, succ.endMs, p.cal));
    }

    const fromNetwork = resolveLateFinish(bounds, minutes, p.cal);
    const latest = Math.min(fromNetwork ?? ceilingMs, ceilingMs);
    const endMs = dayEnd(p.cal, latest);
    const startMs =
      minutes === 0 ? endMs : dayStart(p.cal, subWorkMinutes(p.cal, endMs, minutes));
    spans.set(path, { startMs, endMs });
  }

  return spans;
}

/** Spans as bars, so the capacity and schedule passes can read them. */
function spansToBars(spans: ReadonlyMap<TaskPath, ScheduledSpan>): Map<TaskPath, Bar> {
  const bars = new Map<TaskPath, Bar>();
  for (const [path, span] of spans) {
    bars.set(path, {
      path,
      startMs: span.startMs,
      endMs: span.endMs,
      displayStartMs: startOfDay(span.startMs),
      displayEndMs: startOfNextDay(span.endMs - 1),
      kind: 'planned'
    });
  }
  return bars;
}

/**
 * Lay out the schedule.
 *
 * Levelling runs as a loop rather than a single pass: pushing a task off an overloaded
 * day can break a dependency, so each round pins the pushed tasks to their new earliest
 * start and reschedules the whole network around them. It is bounded, and says so when
 * it does not converge — a levelling pass that quietly stopped short would look like a
 * solution.
 */
export function autoschedule(input: AutoscheduleInput): AutoscheduleResult {
  const p = prepare(input);
  const notes: string[] = [];
  const backward = input.deadlineMs !== undefined && input.startMs === undefined;

  const floorMs = dayStart(p.cal, input.startMs ?? input.now);
  // A deadline is read the way a due date is. `--deadline 2026-05-08` with inclusive
  // due dates means "finished by the end of the 8th"; taken as midnight it would
  // quietly mean the 7th, the classic Gantt off-by-one in its other direction.
  const rawDeadline = input.deadlineMs ?? input.now;
  const ceilingMs = dayEnd(
    p.cal,
    input.settings.dueDateInclusive ? endOfWorkday(p.cal, rawDeadline) : rawDeadline
  );
  let spans = backward ? backwardPass(p, ceilingMs) : forwardPass(p, floorMs, new Map());

  if (input.level === true && !backward) {
    const resourceField = input.resourceField ?? input.settings.resourceField;
    const capacityOptions = {
      calendar: p.cal,
      resourceField,
      defaultCapacityMinutes: input.settings.defaultCapacityMinutesPerDay,
      capacityOverrides: input.settings.capacityOverrides,
      includeCompleted: false
    };

    // Levelling against a field nobody fills in is a no-op that looks like a success:
    // every task lands in the unassigned pile, which is deliberately unlimited, so
    // nothing is ever over capacity. Say that plainly rather than reporting a clean
    // result the numbers do not support.
    const lanes = [...computeCapacity([...p.byPath.values()], spansToBars(spans), capacityOptions)
      .resources.values()].filter((lane) => !lane.unlimited);

    if (lanes.length === 0) {
      notes.push(
        `Nothing to level: no task in scope carries a value for \`${resourceField}\`, so all ` +
          `of them fall in the unassigned pile, which has no capacity limit. Pass ` +
          `\`--resource <field>\` to level against something this vault records.`
      );
    } else {
      const rounds = input.levellingRounds ?? 50;
      const pinned = new Map<TaskPath, number>();
      let outstanding = 0;

      for (let round = 0; round < rounds; round += 1) {
        const bars = spansToBars(spans);
        const schedule = computeSchedule({ bars, edges: p.edges, calendar: p.cal });
        const proposals = planLevelling([...p.byPath.values()], bars, {
          ...capacityOptions,
          priorityWeight: (task) =>
            input.catalog.priorities.find((def) => def.value === task.priority)?.weight ?? 0,
          floatMinutes: (path) => schedule.nodes.get(path)?.totalFloat ?? null,
          maxPushDays: 60
        });

        outstanding = proposals.length;
        if (outstanding === 0) {
          notes.push(
            `Levelled against \`${resourceField}\` over ${lanes.length} resource(s); settled ` +
              `after ${round} round${round === 1 ? '' : 's'}.`
          );
          break;
        }

        for (const proposal of proposals) {
          const span = spans.get(proposal.path);
          if (span === undefined) continue;
          // Pin the earliest start rather than the span: the next pass still has to
          // satisfy the dependencies, which may push it later still.
          pinned.set(proposal.path, addDays(span.startMs, proposal.dayDelta));
        }
        spans = forwardPass(p, floorMs, pinned);
      }

      if (outstanding > 0) {
        notes.push(
          `Levelling did not settle in ${rounds} rounds: ${outstanding} task(s) still sit on ` +
            `a day their resource is over capacity. The remaining work may not fit in the ` +
            `calendar at all.`
        );
      }
    }
  } else if (input.level === true) {
    notes.push('Levelling is a forward-pass idea and was not applied to a backward plan.');
  }

  if (backward) {
    let earliest: number | null = null;
    for (const [path, span] of spans) {
      if (p.fixed.has(path)) continue;
      if (earliest === null || span.startMs < earliest) earliest = span.startMs;
    }
    if (earliest !== null && earliest < floorMs) {
      const days = workDaysBetween(p.cal, earliest, floorMs);
      notes.push(
        `This deadline needs work to have started on ${formatTaskDate(startOfDay(earliest), true)}` +
          `, which is ${days} working day(s) before ${formatTaskDate(startOfDay(floorMs), true)}. ` +
          `The deadline cannot be met without cutting scope or shortening estimates.`
      );
    }
  }

  notes.push(
    'Each task keeps the length it has now — the span between its dates, or its ' +
      'estimate where it has no span. This lays the work out again; it does not ' +
      're-estimate it.'
  );
  if (p.nonWorking > 0) {
    notes.push(
      `${p.nonWorking} task(s) are currently scheduled entirely on non-working days, so ` +
        `their spans measure as zero working time. Their estimates were used instead.`
    );
  }
  if (p.guessed > 0) {
    const hours = Math.round((input.settings.defaultDurationMinutes / 60) * 10) / 10;
    notes.push(
      `${p.guessed} task(s) have neither an estimate nor a start and due date, so each was ` +
        `given ${hours}h. Their lengths are a placeholder, not a plan.`
    );
  }

  // Conflicts that survive a clean layout are the ones this pass deliberately could
  // not touch: a finished task is not moved, so a contradiction it is part of stays.
  // Reporting the count keeps "4 conflicts remain" from reading as a failure of the
  // scheduler when it is a fact about the plan's history.
  const untouchable = new Set([...p.fixed.keys(), ...p.skipped.map((s) => s.path)]);
  const finalBars = spansToBars(spans);
  const remaining = computeSchedule({
    bars: finalBars,
    edges: p.edges,
    calendar: p.cal
  }).violations.filter((v) => untouchable.has(v.edge.to) || untouchable.has(v.edge.from));
  if (remaining.length > 0) {
    notes.push(
      `${remaining.length} dependency conflict(s) remain, all involving a task this pass ` +
        `left alone. They were there before and cannot be fixed by rescheduling.`
    );
  }

  const inCycle = p.skipped.filter((s) => s.reason.startsWith('in a circular')).length;
  if (inCycle > 0) {
    notes.push(`${inCycle} task(s) are in a circular dependency and were not scheduled.`);
  }
  const done = p.skipped.filter((s) => s.reason === 'already done').length;
  if (done > 0) notes.push(`${done} finished task(s) were left where they are.`);

  return { spans, skipped: p.skipped, notes };
}

/**
 * Turn a layout into a proposal.
 *
 * Only tasks whose dates would actually change get an operation, so a schedule that
 * mostly agrees with the vault produces a short proposal rather than a hundred and
 * sixty no-ops for a reader to wade through.
 */
export function buildScheduleProposal(
  tasks: readonly GanttTask[],
  result: AutoscheduleResult,
  ids: IdMap,
  settings: GanttSettings
): Operation[] {
  const skippedPaths = new Set(result.skipped.map((s) => s.path));
  const operations: Operation[] = [];

  for (const task of tasks) {
    if (skippedPaths.has(task.path)) continue;
    const span = result.spans.get(task.path);
    if (span === undefined) continue;

    const scheduled = formatTaskDate(startOfDay(span.startMs), true);
    // An inclusive due date names the last day of work, which is the day the span's
    // end instant falls in. Without `dueDateInclusive` it names the day after.
    const dueMs = settings.dueDateInclusive ? span.endMs : startOfNextDay(span.endMs - 1);
    const due = formatTaskDate(startOfDay(dueMs), true);

    if (task.scheduled?.raw === scheduled && task.due?.raw === due) continue;
    operations.push({ op: 'set_dates', id: idFor(task.path, ids), scheduled, due });
  }

  return operations;
}
