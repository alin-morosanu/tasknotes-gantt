import { describe, expect, it } from 'vitest';
import type { Bar, Edge, RelType, TaskPath } from '../src/types';
import { DEFAULT_CALENDAR, workMinutesBetween } from '../src/model/calendar';
import { parseTaskDate, startOfNextDay, startOfDay } from '../src/model/dates';
import { computeSchedule, criticalEdges, violationsByTask } from '../src/model/schedule';

const at = (s: string) => parseTaskDate(s)!.ms;
const cal = DEFAULT_CALENDAR;
const MIN = 60_000;

/** A planned bar over whole days, matching what geometry produces for all-day dates. */
function bar(path: string, start: string, end: string): Bar {
  const startMs = at(`${start}T09:00`);
  const endMs = at(`${end}T17:00`);
  return {
    path,
    startMs,
    endMs,
    displayStartMs: startOfDay(startMs),
    displayEndMs: startOfNextDay(endMs - 1),
    kind: 'planned'
  };
}

function edge(from: string, to: string, reltype: RelType = 'FINISHTOSTART', gapMinutes = 0): Edge {
  return { from, uid: from, to, reltype, gapMinutes };
}

function schedule(bars: [string, Bar][], edges: Edge[]) {
  return computeSchedule({ bars: new Map(bars), edges, calendar: cal });
}

// 2026-04-13 is a Monday.
describe('forward pass', () => {
  it('anchors a task with no predecessors at its own planned start', () => {
    const result = schedule([['a', bar('a', '2026-04-13', '2026-04-14')]], []);
    expect(result.nodes.get('a')?.es).toBe(at('2026-04-13T09:00'));
  });

  it('pushes a finish-to-start successor to its predecessor’s finish', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-14')],
        ['b', bar('b', '2026-04-20', '2026-04-21')]
      ],
      [edge('a', 'b')]
    );
    // A finishes Tuesday 17:00, so B could start there even though it is planned later.
    expect(result.nodes.get('b')?.es).toBe(at('2026-04-14T17:00'));
  });

  it('applies a lag to a finish-to-start edge', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-20', '2026-04-20')]
      ],
      [edge('a', 'b', 'FINISHTOSTART', 480)]
    );
    // One working day of lag past Monday 17:00 lands at Tuesday 17:00.
    expect(result.nodes.get('b')?.es).toBe(at('2026-04-14T17:00'));
  });

  it('aligns starts for a start-to-start edge', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-17')],
        ['b', bar('b', '2026-04-20', '2026-04-21')]
      ],
      [edge('a', 'b', 'STARTTOSTART')]
    );
    expect(result.nodes.get('b')?.es).toBe(at('2026-04-13T09:00'));
  });

  it('constrains the finish for a finish-to-finish edge', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-17')],
        ['b', bar('b', '2026-04-13', '2026-04-14')]
      ],
      [edge('a', 'b', 'FINISHTOFINISH')]
    );
    // B is two days long and cannot finish before A does on Friday.
    expect(result.nodes.get('b')?.ef).toBe(at('2026-04-17T17:00'));
    expect(result.nodes.get('b')?.es).toBe(at('2026-04-16T09:00'));
  });

  it('takes the latest of several predecessors', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-13', '2026-04-16')],
        ['c', bar('c', '2026-04-20', '2026-04-20')]
      ],
      [edge('a', 'c'), edge('b', 'c')]
    );
    expect(result.nodes.get('c')?.es).toBe(at('2026-04-16T17:00'));
  });
});

describe('float and the critical path', () => {
  it('gives a single chain zero float throughout', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-14')],
        ['b', bar('b', '2026-04-15', '2026-04-16')]
      ],
      [edge('a', 'b')]
    );
    expect(result.nodes.get('a')?.totalFloat).toBe(0);
    expect(result.nodes.get('b')?.totalFloat).toBe(0);
    expect(result.critical.has('a')).toBe(true);
    expect(result.critical.has('b')).toBe(true);
  });

  it('gives the shorter branch of a diamond positive float', () => {
    const result = schedule(
      [
        ['start', bar('start', '2026-04-13', '2026-04-13')],
        ['long', bar('long', '2026-04-14', '2026-04-17')],
        ['short', bar('short', '2026-04-14', '2026-04-14')],
        ['end', bar('end', '2026-04-20', '2026-04-20')]
      ],
      [edge('start', 'long'), edge('start', 'short'), edge('long', 'end'), edge('short', 'end')]
    );
    expect(result.nodes.get('long')?.totalFloat).toBe(0);
    expect(result.nodes.get('short')?.totalFloat).toBeGreaterThan(0);
    expect(result.critical.has('long')).toBe(true);
    expect(result.critical.has('short')).toBe(false);
  });

  it('never reports negative float', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-17')],
        ['b', bar('b', '2026-04-13', '2026-04-14')],
        ['c', bar('c', '2026-04-15', '2026-04-16')]
      ],
      [edge('a', 'c'), edge('b', 'c')]
    );
    for (const node of result.nodes.values()) {
      expect(node.totalFloat).toBeGreaterThanOrEqual(0);
      expect(node.freeFloat).toBeGreaterThanOrEqual(0);
    }
  });

  it('makes the critical path span the whole project duration', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-14')],
        ['b', bar('b', '2026-04-15', '2026-04-16')],
        ['c', bar('c', '2026-04-17', '2026-04-17')]
      ],
      [edge('a', 'b'), edge('b', 'c')]
    );
    const criticalDuration = [...result.critical]
      .map((p) => result.nodes.get(p))
      .reduce((sum, n) => sum + (n ? workMinutesBetween(cal, n.es, n.ef) : 0), 0);
    expect(criticalDuration).toBe(
      workMinutesBetween(cal, result.projectStartMs, result.projectEndMs)
    );
  });

  it('reports free float separately from total float', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-14', '2026-04-14')],
        ['c', bar('c', '2026-04-13', '2026-04-17')],
        ['d', bar('d', '2026-04-20', '2026-04-20')]
      ],
      [edge('a', 'b'), edge('b', 'd'), edge('c', 'd')]
    );
    const b = result.nodes.get('b');
    expect(b).toBeDefined();
    expect(b!.freeFloat).toBeLessThanOrEqual(b!.totalFloat);
  });
});

describe('cycles', () => {
  it('excludes a cycle from the passes instead of looping', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-14', '2026-04-14')],
        ['c', bar('c', '2026-04-15', '2026-04-15')]
      ],
      [edge('a', 'b'), edge('b', 'a'), edge('a', 'c')]
    );
    expect(result.cycles).toHaveLength(1);
    expect(result.nodes.has('a')).toBe(false);
    expect(result.nodes.has('b')).toBe(false);
    // Everything outside the ring is still scheduled.
    expect(result.nodes.has('c')).toBe(true);
  });

  it('reports the edges it dropped', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-14', '2026-04-14')]
      ],
      [edge('a', 'b'), edge('b', 'a')]
    );
    expect(result.droppedEdges).toHaveLength(2);
  });
});

describe('violations', () => {
  it('flags a successor planned before its predecessor finishes', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-15', '2026-04-17')],
        ['b', bar('b', '2026-04-13', '2026-04-14')]
      ],
      [edge('a', 'b')]
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.edge.to).toBe('b');
    // b starts Monday; a does not finish until Friday. That is five working days of
    // overlap. Measured in wall-clock time it read as 7200 minutes — fifteen days
    // once divided by an eight-hour day.
    expect(result.violations[0]?.overlapMinutes).toBe(5 * 480);
  });

  it('measures an overlap that spans a weekend in working time only', () => {
    // Fri 09:00 to Mon 17:00 is two working days. Elapsed, it is four.
    const result = schedule(
      [
        ['a', bar('a', '2026-04-17', '2026-04-20')],
        ['b', bar('b', '2026-04-17', '2026-04-17')]
      ],
      [edge('a', 'b')]
    );
    expect(result.violations[0]?.overlapMinutes).toBe(2 * 480);
  });

  it('still flags an order that is wrong even when no work collides', () => {
    // Both tasks sit on the same closed weekend, so the overlap is zero working
    // minutes — but b is still planned to start before a finishes, and dropping the
    // violation would hide a real problem behind an arithmetic accident.
    const result = schedule(
      [
        ['a', bar('a', '2026-04-18', '2026-04-19')],
        ['b', bar('b', '2026-04-18', '2026-04-19')]
      ],
      [edge('a', 'b')]
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.overlapMinutes).toBe(0);
  });

  it('does not flag a plan that satisfies its dependencies', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-14')],
        ['b', bar('b', '2026-04-15', '2026-04-16')]
      ],
      [edge('a', 'b')]
    );
    expect(result.violations).toEqual([]);
  });

  it('checks the written dates, not the computed early dates', () => {
    // B could start on the 15th, and is planned for the 20th. That is slack, not a
    // violation: the forward pass moving it earlier must not be reported as an error.
    const result = schedule(
      [
        ['a', bar('a', '2026-04-13', '2026-04-14')],
        ['b', bar('b', '2026-04-20', '2026-04-21')]
      ],
      [edge('a', 'b')]
    );
    expect(result.violations).toEqual([]);
    expect(result.nodes.get('b')?.es).toBeLessThan(at('2026-04-20T09:00'));
  });

  it('groups violations by the task at fault', () => {
    const result = schedule(
      [
        ['a', bar('a', '2026-04-15', '2026-04-17')],
        ['b', bar('b', '2026-04-15', '2026-04-17')],
        ['c', bar('c', '2026-04-13', '2026-04-14')]
      ],
      [edge('a', 'c'), edge('b', 'c')]
    );
    const byTask = violationsByTask(result.violations);
    expect(byTask.get('c')).toHaveLength(2);
  });

  it('names both tasks in the message', () => {
    const result = computeSchedule({
      bars: new Map([
        ['x/a.md', bar('x/a.md', '2026-04-15', '2026-04-17')],
        ['x/b.md', bar('x/b.md', '2026-04-13', '2026-04-14')]
      ]),
      edges: [edge('x/a.md', 'x/b.md')],
      calendar: cal
    });
    expect(result.violations[0]?.message).toContain('a');
    expect(result.violations[0]?.message).toContain('b');
  });
});

describe('criticalEdges', () => {
  it('includes only edges with both ends critical', () => {
    const critical = new Set<TaskPath>(['a', 'b']);
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const result = criticalEdges(edges, critical);
    expect(result.size).toBe(1);
    expect([...result][0]?.to).toBe('b');
  });
});

describe('scale', () => {
  it('handles a long chain quickly', () => {
    const bars: [string, Bar][] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < 2000; i += 1) {
      bars.push([`n${i}`, bar(`n${i}`, '2026-04-13', '2026-04-13')]);
      if (i > 0) edges.push(edge(`n${i - 1}`, `n${i}`));
    }
    const started = Date.now();
    const result = computeSchedule({ bars: new Map(bars), edges, calendar: cal });
    expect(result.nodes.size).toBe(2000);
    // Generous bound; the point is that it is linear, not that it hits a exact figure.
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('empty input', () => {
  it('returns an empty result rather than failing', () => {
    const result = computeSchedule({ bars: new Map(), edges: [], calendar: cal });
    expect(result.nodes.size).toBe(0);
    expect(result.violations).toEqual([]);
  });
});

void MIN;

describe('independent plans', () => {
  it('measures float against each chain’s own end, not the latest task anywhere', () => {
    const result = schedule(
      [
        // An early two-task chain...
        ['a1', bar('a1', '2026-04-13', '2026-04-13')],
        ['a2', bar('a2', '2026-04-14', '2026-04-14')],
        // ...and an unrelated one finishing a year later.
        ['b1', bar('b1', '2027-04-13', '2027-04-13')],
        ['b2', bar('b2', '2027-04-14', '2027-04-14')]
      ],
      [edge('a1', 'a2'), edge('b1', 'b2')]
    );
    // Without per-component end dates, the April 2026 chain would show a year of
    // float against a deadline it has nothing to do with.
    expect(result.nodes.get('a1')?.totalFloat).toBe(0);
    expect(result.nodes.get('a2')?.totalFloat).toBe(0);
    expect(result.critical.has('a1')).toBe(true);
    expect(result.critical.has('b1')).toBe(true);
  });

  it('does not call a task with no dependencies critical', () => {
    const result = schedule(
      [
        ['lonely', bar('lonely', '2026-04-13', '2026-04-14')],
        ['a', bar('a', '2026-04-13', '2026-04-13')],
        ['b', bar('b', '2026-04-14', '2026-04-14')]
      ],
      [edge('a', 'b')]
    );
    // It is trivially critical in a network of one, which is noise, not information.
    expect(result.critical.has('lonely')).toBe(false);
    expect(result.critical.has('a')).toBe(true);
  });

  it('still finds slack inside a component that has some', () => {
    const result = schedule(
      [
        ['start', bar('start', '2026-04-13', '2026-04-13')],
        ['long', bar('long', '2026-04-14', '2026-04-17')],
        ['short', bar('short', '2026-04-14', '2026-04-14')],
        ['end', bar('end', '2026-04-20', '2026-04-20')]
      ],
      [edge('start', 'long'), edge('start', 'short'), edge('long', 'end'), edge('short', 'end')]
    );
    expect(result.nodes.get('short')?.totalFloat).toBeGreaterThan(0);
  });
});
