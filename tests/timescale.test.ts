import { describe, expect, it } from 'vitest';
import {
  createTimescale,
  majorTicks,
  minorTicks,
  msOf,
  startOfWeek,
  weekendBands,
  widthOf,
  xOf,
  zoomIn,
  zoomOut,
  ZOOM_PX_PER_DAY
} from '../src/render/timescale';
import { DAY_MS, parseTaskDate } from '../src/model/dates';

const at = (s: string) => parseTaskDate(s)!.ms;

describe('coordinate mapping', () => {
  it('places the origin at x = 0', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    expect(xOf(scale, at('2026-04-13'))).toBe(0);
  });

  it('advances one day per pxPerDay', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    expect(xOf(scale, at('2026-04-14'))).toBeCloseTo(ZOOM_PX_PER_DAY.day, 6);
    expect(xOf(scale, at('2026-04-20'))).toBeCloseTo(ZOOM_PX_PER_DAY.day * 7, 6);
  });

  it('round-trips through msOf', () => {
    const scale = createTimescale(at('2026-04-13'), 'week');
    for (const ms of [at('2026-04-13'), at('2026-05-01'), at('2026-01-01')]) {
      expect(msOf(scale, xOf(scale, ms))).toBeCloseTo(ms, 0);
    }
  });

  it('handles instants before the origin as negative x', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    expect(xOf(scale, at('2026-04-12'))).toBeCloseTo(-ZOOM_PX_PER_DAY.day, 6);
  });

  it('measures a span independently of where it sits', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const a = widthOf(scale, at('2026-04-14'), at('2026-04-17'));
    const b = widthOf(scale, at('2026-06-14'), at('2026-06-17'));
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeCloseTo(3 * ZOOM_PX_PER_DAY.day, 6);
  });

  it('snaps the origin to local midnight so day boundaries stay aligned', () => {
    const scale = createTimescale(at('2026-04-13T14:37'), 'day');
    expect(new Date(scale.originMs).getHours()).toBe(0);
  });
});

describe('zoom stepping', () => {
  it('clamps at both ends instead of wrapping', () => {
    expect(zoomIn('day')).toBe('day');
    expect(zoomOut('quarter')).toBe('quarter');
  });

  it('steps one level at a time', () => {
    expect(zoomOut('day')).toBe('week');
    expect(zoomOut('week')).toBe('month');
    expect(zoomIn('month')).toBe('week');
  });
});

describe('startOfWeek', () => {
  it('returns the Monday of the containing week', () => {
    // 2026-04-15 is a Wednesday; its week began Monday the 13th.
    const monday = new Date(startOfWeek(at('2026-04-15')));
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(13);
  });

  it('treats Sunday as the end of the week it began, not the start of a new one', () => {
    // 2026-04-19 is a Sunday; its week began Monday the 13th.
    expect(new Date(startOfWeek(at('2026-04-19'))).getDate()).toBe(13);
  });

  it('is idempotent', () => {
    const monday = startOfWeek(at('2026-04-15'));
    expect(startOfWeek(monday)).toBe(monday);
  });
});

describe('ticks', () => {
  it('emits one minor tick per day at day zoom', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const ticks = minorTicks(scale, 0, ZOOM_PX_PER_DAY.day * 6);
    expect(ticks).toHaveLength(7);
    expect(ticks.map((t) => t.label)).toEqual(['13', '14', '15', '16', '17', '18', '19']);
  });

  it('marks weekends so the grid can shade them', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const ticks = minorTicks(scale, 0, ZOOM_PX_PER_DAY.day * 6);
    expect(ticks.filter((t) => t.weekend).map((t) => t.label)).toEqual(['18', '19']);
  });

  it('emits weekly ticks aligned to Mondays at week zoom', () => {
    const scale = createTimescale(at('2026-04-15'), 'week');
    const ticks = minorTicks(scale, 0, ZOOM_PX_PER_DAY.week * 21);
    for (const tick of ticks) expect(new Date(tick.ms).getDay()).toBe(1);
  });

  it('emits month names above the days', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const ticks = majorTicks(scale, 0, ZOOM_PX_PER_DAY.day * 40);
    expect(ticks.map((t) => t.label)).toContain('May 2026');
    expect(ticks.every((t) => t.major)).toBe(true);
  });

  it('only produces ticks intersecting the requested pixel range', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const near = minorTicks(scale, 0, 100);
    const far = minorTicks(scale, 10_000, 10_100);
    expect(near[0]?.ms).toBeLessThan(far[0]!.ms);
    expect(near.length).toBeLessThan(10);
  });

  it('stays bounded even when asked for an absurd range', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    // 500 years of days would be ~180k ticks without the cap.
    const ticks = minorTicks(scale, 0, ZOOM_PX_PER_DAY.day * 365 * 500);
    expect(ticks.length).toBeLessThanOrEqual(2000);
  });
});

describe('weekendBands', () => {
  it('produces a band per weekend day at day zoom', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const bands = weekendBands(scale, 0, ZOOM_PX_PER_DAY.day * 6);
    expect(bands).toHaveLength(2);
    expect(bands[0]?.width).toBe(ZOOM_PX_PER_DAY.day);
  });

  it('is suppressed at coarse zooms where a day is a few pixels', () => {
    const scale = createTimescale(at('2026-04-13'), 'quarter');
    expect(weekendBands(scale, 0, 1000)).toEqual([]);
  });

  it('places a band exactly over its day', () => {
    const scale = createTimescale(at('2026-04-13'), 'day');
    const bands = weekendBands(scale, 0, ZOOM_PX_PER_DAY.day * 6);
    const saturday = at('2026-04-18');
    expect(bands[0]?.x).toBeCloseTo(xOf(scale, saturday), 6);
    expect(msOf(scale, bands[0]!.x + bands[0]!.width)).toBeCloseTo(saturday + DAY_MS, 0);
  });
});
