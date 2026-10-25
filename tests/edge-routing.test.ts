import { describe, expect, it } from 'vitest';
import type { Bar, Edge, RelType } from '../src/types';
import {
  anchorsFor,
  DEFAULT_METRICS,
  offscreenSide,
  routeEdge,
  type Anchor
} from '../src/render/canvas';

const metrics = DEFAULT_METRICS;

function bar(kind: Bar['kind'] = 'planned'): Bar {
  return { path: 'p', startMs: 0, endMs: 1, displayStartMs: 0, displayEndMs: 1, kind };
}

const rect = (x: number, width: number, y: number) => ({ x, width, y, height: metrics.barHeight });

function edge(reltype: RelType): Edge {
  return { from: 'a', uid: 'a', to: 'b', reltype, gapMinutes: 0 };
}

/** Every segment of a route must be either horizontal or vertical. */
function isOrthogonal(points: readonly { x: number; y: number }[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const horizontal = Math.abs(a.y - b.y) < 1e-9;
    const vertical = Math.abs(a.x - b.x) < 1e-9;
    if (!horizontal && !vertical) return false;
  }
  return true;
}

describe('anchorsFor', () => {
  it('leaves the finish and enters the start for finish-to-start', () => {
    const { from, to } = anchorsFor(
      edge('FINISHTOSTART'),
      bar(),
      bar(),
      rect(100, 50, 0),
      rect(300, 50, 28),
      metrics
    );
    expect(from.x).toBe(150);
    expect(from.dir).toBe(1);
    expect(to.x).toBe(300);
    expect(to.dir).toBe(1);
  });

  it('leaves the start and enters the start for start-to-start', () => {
    const { from, to } = anchorsFor(
      edge('STARTTOSTART'),
      bar(),
      bar(),
      rect(100, 50, 0),
      rect(300, 50, 28),
      metrics
    );
    expect(from.x).toBe(100);
    expect(from.dir).toBe(-1);
    expect(to.dir).toBe(1);
  });

  it('enters the finish for finish-to-finish', () => {
    const { from, to } = anchorsFor(
      edge('FINISHTOFINISH'),
      bar(),
      bar(),
      rect(100, 50, 0),
      rect(300, 50, 28),
      metrics
    );
    expect(from.x).toBe(150);
    expect(to.x).toBe(350);
    // The arrow arrives pointing left, into the target's right edge.
    expect(to.dir).toBe(-1);
  });

  it('spans both ends for start-to-finish', () => {
    const { from, to } = anchorsFor(
      edge('STARTTOFINISH'),
      bar(),
      bar(),
      rect(100, 50, 0),
      rect(300, 50, 28),
      metrics
    );
    expect(from.dir).toBe(-1);
    expect(to.dir).toBe(-1);
  });

  it('anchors a milestone on its diamond, not on a 2px box', () => {
    const { from } = anchorsFor(
      edge('FINISHTOSTART'),
      bar('milestone'),
      bar(),
      rect(200, 2, 0),
      rect(400, 50, 28),
      metrics
    );
    expect(from.x).toBeGreaterThan(200 + metrics.barHeight / 2 - 1);
  });

  it('centres both anchors vertically on their bars', () => {
    const { from, to } = anchorsFor(
      edge('FINISHTOSTART'),
      bar(),
      bar(),
      rect(100, 50, 10),
      rect(300, 50, 50),
      metrics
    );
    expect(from.y).toBe(10 + metrics.barHeight / 2);
    expect(to.y).toBe(50 + metrics.barHeight / 2);
  });
});

describe('routeEdge', () => {
  const from = (x: number, y: number, dir: 1 | -1 = 1): Anchor => ({ x, y, dir });

  it('produces only horizontal and vertical segments', () => {
    // The previous routing cut one long diagonal across the chart, which made five
    // arrows leaving one task indistinguishable from each other.
    const cases: [Anchor, Anchor][] = [
      [from(100, 10), from(400, 100, 1)],
      [from(400, 10), from(100, 100, 1)],
      [from(100, 100), from(400, 10, 1)],
      [from(100, 10, -1), from(400, 100, -1)],
      [from(400, 10, -1), from(100, 100, 1)]
    ];
    for (const [a, b] of cases) {
      expect(isOrthogonal(routeEdge(a, b))).toBe(true);
    }
  });

  it('starts exactly at the source and ends exactly at the target', () => {
    const a = from(150, 10);
    const b = from(400, 100);
    const points = routeEdge(a, b);
    expect(points[0]).toEqual({ x: 150, y: 10 });
    expect(points[points.length - 1]).toEqual({ x: 400, y: 100 });
  });

  it('uses a simple three-corner route when the target is ahead', () => {
    const points = routeEdge(from(150, 10), from(400, 100));
    expect(points).toHaveLength(4);
  });

  it('detours between the rows when the target sits behind the source', () => {
    // A successor scheduled before its predecessor ends: the line has to go back on
    // itself, and must not run along either bar while doing so.
    const points = routeEdge(from(400, 10), from(150, 100));
    expect(points).toHaveLength(6);
    expect(isOrthogonal(points)).toBe(true);
    const midY = points[2]?.y;
    expect(midY).toBeGreaterThan(10);
    expect(midY).toBeLessThan(100);
  });

  it('leaves a stub before turning, so arrows off one bar do not overlap', () => {
    const points = routeEdge(from(150, 10), from(400, 100));
    expect(points[1]?.x).toBeGreaterThan(150);
    expect(points[1]?.y).toBe(10);
  });

  it('routes leftward when the source anchor faces left', () => {
    const points = routeEdge(from(400, 10, -1), from(150, 100, 1));
    expect(points[1]?.x).toBeLessThan(400);
    expect(isOrthogonal(points)).toBe(true);
  });

  it('handles a target on the same row without producing a diagonal', () => {
    expect(isOrthogonal(routeEdge(from(150, 50), from(400, 50)))).toBe(true);
  });

  it('handles coincident anchors without failing', () => {
    const points = routeEdge(from(200, 50), from(200, 50));
    expect(isOrthogonal(points)).toBe(true);
    expect(points[points.length - 1]).toEqual({ x: 200, y: 50 });
  });
});

describe('routeEdge: staying clear of the target bar', () => {
  const from = (x: number, y: number, dir: 1 | -1 = 1): Anchor => ({ x, y, dir });

  /** How far along the target's own row the route travels before the arrowhead. */
  function approachLength(points: readonly { x: number; y: number }[], toY: number): number {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (Math.abs(a.y - toY) < 1e-9 && Math.abs(b.y - toY) < 1e-9) {
        total += Math.abs(b.x - a.x);
      }
    }
    return total;
  }

  it('runs along the source row, not the target row', () => {
    // Routing the long horizontal at the target's row made it cross the target bar and
    // its baseline before reaching the arrowhead. The source row is empty to the right
    // of its own bar, so the long run belongs there.
    const points = routeEdge(from(150, 10), from(900, 100));
    expect(approachLength(points, 100)).toBeLessThanOrEqual(12);
  });

  it('keeps the approach short however far apart the bars are', () => {
    for (const targetX of [300, 900, 5000, 40000]) {
      const points = routeEdge(from(150, 10), from(targetX, 100));
      expect(approachLength(points, 100)).toBeLessThanOrEqual(12);
    }
  });

  it('never doubles back over a target that starts just after the source ends', () => {
    // Adjacent bars — a task starting the day after its predecessor — used to produce
    // a six-point detour that hooked back across the target's left edge.
    const points = routeEdge(from(195, 10), from(197, 38));
    expect(points).toHaveLength(4);
    expect(isOrthogonal(points)).toBe(true);
    // Every corner sits between the two anchors, so nothing overshoots the target.
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(195);
      expect(point.x).toBeLessThanOrEqual(197);
    }
  });

  it('handles bars separated by a single pixel', () => {
    const points = routeEdge(from(200, 10), from(201, 38));
    expect(isOrthogonal(points)).toBe(true);
    expect(points[points.length - 1]).toEqual({ x: 201, y: 38 });
  });

  it('still detours when the target really does start before the source ends', () => {
    const points = routeEdge(from(400, 10), from(150, 100));
    expect(points).toHaveLength(6);
  });

  it('runs a detour along the gutter between the rows, not across a bar', () => {
    const rowHeight = 28;
    const points = routeEdge(from(400, 10), from(150, 10 + rowHeight));
    const midY = points[2]?.y;
    // Exactly halfway between two adjacent row centres is the row boundary, which is
    // the gap between the bars rather than either bar itself.
    expect(midY).toBe(10 + rowHeight / 2);
  });

  it('approaches a finish-to-finish target from beyond its right edge', () => {
    const points = routeEdge(from(150, 10), from(600, 100, -1));
    const beforeLast = points[points.length - 2];
    expect(beforeLast?.x).toBeGreaterThan(600);
    expect(approachLength(points, 100)).toBeLessThanOrEqual(12);
  });
});

describe('offscreenSide', () => {
  const scale = { originMs: 0, pxPerDay: 10, zoom: 'day' as const };
  const DAY = 86_400_000;
  /** A bar spanning `days` from `startDay`, in the scale above. */
  const span = (startDay: number, days: number): Bar => ({
    path: 'p',
    startMs: startDay * DAY,
    endMs: (startDay + days) * DAY,
    displayStartMs: startDay * DAY,
    displayEndMs: (startDay + days) * DAY,
    kind: 'planned'
  });

  it('reports nothing for a bar inside the viewport', () => {
    // Days 10-13 at 10px/day is x 100-130, well inside a viewport showing x 0-400.
    expect(offscreenSide(span(10, 3), scale, 0, 400)).toBeNull();
  });

  it('reports left for a bar entirely before the viewport', () => {
    expect(offscreenSide(span(10, 3), scale, 500, 400)).toBe('left');
  });

  it('reports right for a bar entirely after the viewport', () => {
    expect(offscreenSide(span(100, 3), scale, 0, 400)).toBe('right');
  });

  it('treats a bar wider than the viewport as visible', () => {
    // Its ends are both off screen, but the bar itself fills the view.
    expect(offscreenSide(span(0, 100), scale, 300, 200)).toBeNull();
  });

  it('treats a bar touching either edge as visible', () => {
    // Ends exactly at the left edge.
    expect(offscreenSide(span(10, 3), scale, 130, 400)).toBeNull();
    // Starts exactly at the right edge.
    expect(offscreenSide(span(10, 3), scale, 0, 100)).toBeNull();
  });

  it('handles a milestone, which has no width to be partly visible', () => {
    // Day 20 at 10px/day sits at x = 200.
    const milestone: Bar = {
      path: 'm',
      startMs: 20 * DAY,
      endMs: 20 * DAY,
      displayStartMs: 20 * DAY,
      displayEndMs: 20 * DAY,
      kind: 'milestone'
    };
    expect(offscreenSide(milestone, scale, 0, 400)).toBeNull();
    expect(offscreenSide(milestone, scale, 300, 400)).toBe('left');
    expect(offscreenSide(milestone, scale, 0, 100)).toBe('right');
  });
});
