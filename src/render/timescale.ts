import { DAY_MS, addDays, startOfDay } from '../model/dates';

/**
 * Horizontal mapping between time and pixels, plus the ruler ticks that label it.
 *
 * Pure and viewport-agnostic: the canvas painter asks for the ticks intersecting a
 * pixel range and gets back exactly those, so nothing off-screen is ever built.
 */

export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter';

export const ZOOM_LEVELS: readonly ZoomLevel[] = ['day', 'week', 'month', 'quarter'];

/** Default pixels per day at each zoom. Chosen so a bar stays legible at every level. */
export const ZOOM_PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 36,
  week: 14,
  month: 4.5,
  quarter: 1.6
};

export interface Timescale {
  /** Instant at x = 0. Always local midnight, so day boundaries land on whole pixels. */
  originMs: number;
  pxPerDay: number;
  zoom: ZoomLevel;
}

export function createTimescale(originMs: number, zoom: ZoomLevel, pxPerDay?: number): Timescale {
  return {
    originMs: startOfDay(originMs),
    zoom,
    pxPerDay: pxPerDay ?? ZOOM_PX_PER_DAY[zoom]
  };
}

export function xOf(scale: Timescale, ms: number): number {
  return ((ms - scale.originMs) / DAY_MS) * scale.pxPerDay;
}

export function msOf(scale: Timescale, x: number): number {
  return scale.originMs + (x / scale.pxPerDay) * DAY_MS;
}

/** Total width needed to draw a time range at this scale. */
export function widthOf(scale: Timescale, startMs: number, endMs: number): number {
  return xOf(scale, endMs) - xOf(scale, startMs);
}

export interface Tick {
  ms: number;
  x: number;
  label: string;
  /** Major ticks get a heavier rule and a bolder label. */
  major: boolean;
  /** True for Saturdays and Sundays, so the grid can shade them. */
  weekend: boolean;
}

/** Zoom out one step, or stay at the coarsest level. */
export function zoomOut(zoom: ZoomLevel): ZoomLevel {
  const i = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[Math.min(i + 1, ZOOM_LEVELS.length - 1)] ?? zoom;
}

/** Zoom in one step, or stay at the finest level. */
export function zoomIn(zoom: ZoomLevel): ZoomLevel {
  const i = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[Math.max(i - 1, 0)] ?? zoom;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** Monday of the ISO week containing `ms`. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  // getDay() is 0 for Sunday, so Sunday belongs to the week that began 6 days earlier.
  const offset = (d.getDay() + 6) % 7;
  return addDays(d.getTime(), -offset);
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function startOfQuarter(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
}

/**
 * Guard against a pathological viewport (a huge range at a tiny scale) producing
 * millions of ticks and locking the UI thread.
 */
const MAX_TICKS = 2000;

/**
 * Ticks for the lower ruler row: the unit the user actually reads at this zoom.
 * Only ticks intersecting [fromX, toX] are produced.
 */
export function minorTicks(scale: Timescale, fromX: number, toX: number): Tick[] {
  const fromMs = msOf(scale, fromX);
  const toMs = msOf(scale, toX);
  const ticks: Tick[] = [];

  let cursor: number;
  let step: (ms: number) => number;
  let label: (d: Date) => string;

  switch (scale.zoom) {
    case 'day':
      cursor = startOfDay(fromMs);
      step = (ms) => addDays(ms, 1);
      label = (d) => String(d.getDate());
      break;
    case 'week':
      cursor = startOfWeek(fromMs);
      step = (ms) => addDays(ms, 7);
      label = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
      break;
    case 'month':
      cursor = startOfMonth(fromMs);
      step = (ms) => {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      };
      label = (d) => MONTHS[d.getMonth()] ?? '';
      break;
    case 'quarter':
      cursor = startOfQuarter(fromMs);
      step = (ms) => {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth() + 3, 1).getTime();
      };
      label = (d) => `Q${Math.floor(d.getMonth() / 3) + 1}`;
      break;
  }

  while (cursor <= toMs && ticks.length < MAX_TICKS) {
    const d = new Date(cursor);
    ticks.push({
      ms: cursor,
      x: xOf(scale, cursor),
      label: label(d),
      major: false,
      weekend: isWeekend(d)
    });
    const next = step(cursor);
    // A step that fails to advance would spin forever; bail rather than hang.
    if (next <= cursor) break;
    cursor = next;
  }

  return ticks;
}

/** Ticks for the upper ruler row: the coarser unit that gives the lower row context. */
export function majorTicks(scale: Timescale, fromX: number, toX: number): Tick[] {
  const fromMs = msOf(scale, fromX);
  const toMs = msOf(scale, toX);
  const ticks: Tick[] = [];

  const monthly = scale.zoom === 'day' || scale.zoom === 'week';
  let cursor = monthly ? startOfMonth(fromMs) : new Date(new Date(fromMs).getFullYear(), 0, 1).getTime();

  while (cursor <= toMs && ticks.length < MAX_TICKS) {
    const d = new Date(cursor);
    ticks.push({
      ms: cursor,
      x: xOf(scale, cursor),
      label: monthly ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : String(d.getFullYear()),
      major: true,
      weekend: false
    });
    const next = monthly
      ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
      : new Date(d.getFullYear() + 1, 0, 1).getTime();
    if (next <= cursor) break;
    cursor = next;
  }

  return ticks;
}

/**
 * Day-wide bands to shade as non-working time.
 *
 * Only produced at day and week zoom; below that a single day is a few pixels and the
 * shading turns the chart into noise.
 */
export function weekendBands(
  scale: Timescale,
  fromX: number,
  toX: number
): { x: number; width: number }[] {
  if (scale.zoom !== 'day' && scale.zoom !== 'week') return [];
  const bands: { x: number; width: number }[] = [];
  let cursor = startOfDay(msOf(scale, fromX));
  const toMs = msOf(scale, toX);

  while (cursor <= toMs && bands.length < MAX_TICKS) {
    if (isWeekend(new Date(cursor))) {
      bands.push({ x: xOf(scale, cursor), width: scale.pxPerDay });
    }
    cursor = addDays(cursor, 1);
  }
  return bands;
}
