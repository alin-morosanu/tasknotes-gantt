import type { Bar, GanttTask, TaskPath } from '../types';
import { addDays } from './dates';
import { shortfallDays } from './autofix';
import { computeCapacity, planLevelling, type LevellingOptions } from './capacity';
import { planDrag, type ReversiblePatch } from './reschedule';
import { topologicalOrder, type Adjacency } from './graph';

/**
 * Resolve resource overload while keeping the plan the user made.
 *
 * `planLevelling` picks one victim per overloaded day and says how far to push it.
 * Running it once is not enough, and that is the whole reason this exists: pushing a
 * task off an overloaded day moves it past its successors, so a single pass trades an
 * overload for a set of dependency conflicts. The headless scheduler learned this the
 * same way — it loops, pinning what it moved and rescheduling around it.
 *
 * This one is **push-only**. It never pulls a task earlier to close a gap, because a
 * gap is usually deliberate and the problem being solved is that a day is too full.
 * Everything downstream of a moved task is pushed by the least amount that restores
 * its constraint, exactly as `planConflictFixes` does.
 */

export interface LevellingRunOptions extends LevellingOptions {
  adjacency: Adjacency;
  /** Tasks inside a dependency cycle, which have no meaningful earliest start. */
  excluded: ReadonlySet<TaskPath>;
  /** Rounds before giving up. Each one levels, then restores dependency order. */
  maxRounds?: number;
}

export interface LevellingRun {
  /** One patch per moved task, built against where it started. */
  patches: ReversiblePatch[];
  rounds: number;
  /** False when it ran out of rounds with work still on an over-capacity day. */
  settled: boolean;
  /** Tasks still sitting on an over-capacity day when it stopped. */
  remaining: number;
  /**
   * Resources with a real capacity limit.
   *
   * Zero means there was nothing to level: every task fell into the unassigned lane,
   * which is deliberately unlimited, so no day can ever be over capacity. Reported
   * rather than returned as success, because "levelled 0 tasks" and "the field you
   * are levelling against is empty" are different answers to the same click.
   */
  lanes: number;
}

/** Default rounds. Matches the headless scheduler; a round is cheap. */
export const DEFAULT_MAX_ROUNDS = 50;

export function planLevellingRun(
  tasks: readonly GanttTask[],
  bars: ReadonlyMap<TaskPath, Bar>,
  options: LevellingRunOptions
): LevellingRun {
  const { adjacency, excluded, calendar: cal } = options;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const byPath = new Map(tasks.map((t) => [t.path, t]));

  // Whole days each task has been pushed, always from where it started. Composing
  // intermediate patches instead would make `inverse` restore a position that never
  // existed, and undo would land somewhere the user had never seen.
  const delta = new Map<TaskPath, number>();
  const shiftOf = (path: TaskPath) => delta.get(path) ?? 0;

  const spanOf = (path: TaskPath): { startMs: number; endMs: number } | null => {
    const bar = bars.get(path);
    if (!bar) return null;
    const days = shiftOf(path);
    return days === 0
      ? { startMs: bar.startMs, endMs: bar.endMs }
      : { startMs: addDays(bar.startMs, days), endMs: addDays(bar.endMs, days) };
  };

  /** The bars as they currently stand, for the capacity and levelling passes. */
  const currentBars = (): Map<TaskPath, Bar> => {
    const out = new Map<TaskPath, Bar>();
    for (const [path, bar] of bars) {
      const days = shiftOf(path);
      if (days === 0) {
        out.set(path, bar);
        continue;
      }
      out.set(path, {
        ...bar,
        startMs: addDays(bar.startMs, days),
        endMs: addDays(bar.endMs, days),
        displayStartMs: addDays(bar.displayStartMs, days),
        displayEndMs: addDays(bar.displayEndMs, days)
      });
    }
    return out;
  };

  const lanes = [...computeCapacity(tasks, bars, options).resources.values()].filter(
    (lane) => !lane.unlimited
  ).length;
  if (lanes === 0) {
    return { patches: [], rounds: 0, settled: true, remaining: 0, lanes: 0 };
  }

  const { order } = topologicalOrder([...bars.keys()], adjacency, new Set(excluded));

  /**
   * Push every task that a levelling move has left starting too early.
   *
   * Only tasks whose predecessors actually moved. A task already in conflict before
   * any of this ran is somebody else's problem — the chart offers a separate
   * "Reschedule them" for exactly that — and quietly fixing it here would mean a
   * click labelled "level resources" rewrote dates that have nothing to do with
   * capacity. On the reference vault that was the difference between moving 45 tasks
   * and moving the handful the overload actually implicates.
   */
  const restoreDependencies = (): void => {
    for (const path of order) {
      const span = spanOf(path);
      if (!span) continue;
      const predecessors = adjacency.predecessors.get(path) ?? [];
      // Nothing upstream has moved, so whatever state this task is in, this pass did
      // not cause it.
      if (!predecessors.some((edge) => shiftOf(edge.from) > 0)) continue;

      let needed = 0;
      for (const edge of predecessors) {
        if (excluded.has(edge.from)) continue;
        const predSpan = spanOf(edge.from);
        if (!predSpan) continue;
        needed = Math.max(needed, shortfallDays(edge, predSpan, span, cal));
      }
      if (needed <= 0) continue;

      // Verify rather than trust the arithmetic: a day is not always 24 hours, and a
      // shift landing an hour short across a clock change leaves the conflict unfixed.
      let extra = needed;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const moved = {
          startMs: addDays(span.startMs, extra),
          endMs: addDays(span.endMs, extra)
        };
        const stillShort = predecessors.some((edge) => {
          if (excluded.has(edge.from)) return false;
          const predSpan = spanOf(edge.from);
          return predSpan ? shortfallDays(edge, predSpan, moved, cal) > 0 : false;
        });
        if (!stillShort) break;
        extra += 1;
      }

      delta.set(path, shiftOf(path) + extra);
    }
  };

  let rounds = 0;
  let settled = false;
  for (; rounds < maxRounds; rounds += 1) {
    const proposals = planLevelling(tasks, currentBars(), options);
    if (proposals.length === 0) {
      settled = true;
      break;
    }
    for (const proposal of proposals) {
      delta.set(proposal.path, shiftOf(proposal.path) + proposal.dayDelta);
    }
    // Levelling moved tasks without regard for what waits on them; put that right
    // before measuring capacity again, or the next round levels a plan that is
    // already self-contradictory.
    restoreDependencies();
  }

  const remaining = settled ? 0 : planLevelling(tasks, currentBars(), options).length;

  const patches: ReversiblePatch[] = [];
  for (const path of order) {
    const days = shiftOf(path);
    if (days <= 0) continue;
    const task = byPath.get(path);
    const bar = bars.get(path);
    if (!task || !bar) continue;
    // Against the ORIGINAL bar, so the patch is absolute and its inverse restores
    // exactly where the task was before any of this ran.
    const planned = planDrag(task, bar, 'move', days);
    if (planned) patches.push(planned);
  }

  return { patches, rounds, settled, remaining, lanes };
}
