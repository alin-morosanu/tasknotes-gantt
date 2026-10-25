import type { Bar, Edge, StatusDef } from '../types';
import type { Row } from './layout';
import { visibleRows, type Viewport } from './layout';
import {
  majorTicks,
  minorTicks,
  weekendBands,
  xOf,
  type Timescale
} from './timescale';
import { statusColor, withAlpha, type Palette } from './theme';

/** What a capacity row needs in order to draw its histogram. */
export interface CapacityRowData {
  /** Local midnight to allocated working minutes. */
  days: ReadonlyMap<number, number>;
  /** Working minutes per day this lane can absorb, or Infinity when unbounded. */
  capacity: number;
  /** The tallest bar in the lane, used to scale the histogram. */
  peakMinutes: number;
}

/**
 * Paints the chart to a canvas.
 *
 * Everything is culled to the viewport and drawn in one pass per frame, which is what
 * keeps thousands of rows interactive where a DOM node per bar would not be.
 */

export interface ChartMetrics {
  rowHeight: number;
  barHeight: number;
  headerHeight: number;
  /** Left inset before the first pixel of timeline. */
  gutter: number;
}

export const DEFAULT_METRICS: ChartMetrics = {
  rowHeight: 28,
  barHeight: 16,
  headerHeight: 44,
  gutter: 0
};

export interface RenderInput {
  rows: readonly Row[];
  edges: readonly Edge[];
  scale: Timescale;
  palette: Palette;
  metrics: ChartMetrics;
  statuses: readonly StatusDef[];
  viewport: Viewport;
  scrollLeft: number;
  width: number;
  height: number;
  todayMs: number;
  hoveredId: string | null;
  selectedIds: ReadonlySet<string>;
  showDependencies: boolean;
  showArrowheads: boolean;
  /** Paths on the critical path. Empty when the overlay is off. */
  critical: ReadonlySet<string>;
  /** Edges with both ends critical, drawn more prominently. */
  criticalEdges: ReadonlySet<Edge>;
  /** Tasks whose plan contradicts a dependency, and by how many working minutes. */
  violations: ReadonlyMap<string, number>;
  /** Daily load per capacity row, keyed by row id. */
  loads: ReadonlyMap<string, CapacityRowData>;
  /** Baselined extents per task, drawn as a ghost bar beneath the live one. */
  baselines: ReadonlyMap<string, { startMs: number; endMs: number }>;
  /** In-progress dependency link, drawn as a rubber band. */
  linkLine: { fromX: number; fromY: number; toX: number; toY: number; valid: boolean } | null;
}

/** Width of the clickable strip at each edge that holds off-screen markers. */
export const OFFSCREEN_ZONE = 18;

/**
 * Is this bar outside the horizontal viewport, and if so which way?
 *
 * The task grid always shows the name, so without this a row reads as present but
 * blank, with nothing to say whether its bar is a week off-screen or a year.
 */
export function offscreenSide(
  bar: Bar,
  scale: Timescale,
  scrollLeft: number,
  width: number
): 'left' | 'right' | null {
  const left = xOf(scale, bar.displayStartMs) - scrollLeft;
  const right = xOf(scale, bar.displayEndMs) - scrollLeft;
  // A bar wider than the viewport still counts as visible.
  if (right >= 0 && left <= width) return null;
  return right < 0 ? 'left' : 'right';
}

/** Prepare a canvas for crisp painting on a HiDPI display. */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(width * dpr));
  const h = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function barRectFor(
  bar: Bar,
  scale: Timescale,
  y: number,
  metrics: ChartMetrics
): { x: number; width: number; y: number; height: number } {
  const x = xOf(scale, bar.displayStartMs);
  const rawWidth = xOf(scale, bar.displayEndMs) - x;
  return {
    x,
    // A sub-pixel bar is invisible; give every real span a minimum grabbable width.
    width: Math.max(rawWidth, 2),
    y: y + (metrics.rowHeight - metrics.barHeight) / 2,
    height: metrics.barHeight
  };
}

/** Which part of a bar a pointer is over. */
export type HitZone = 'start' | 'body' | 'end';

/** Width of the resize grab area at each end of a bar. */
export const HANDLE_PX = 7;

/**
 * Hit-test a bar against a timeline x coordinate.
 *
 * Narrow bars are all body: a one-day bar at month zoom is under 5px wide, and
 * splitting that into three zones would make it impossible to grab reliably.
 */
export function hitZone(
  bar: Bar,
  scale: Timescale,
  x: number
): HitZone | null {
  const left = xOf(scale, bar.displayStartMs);
  const right = xOf(scale, bar.displayEndMs);
  const width = Math.max(right - left, 2);
  // Milestones are a diamond centred on their instant, so they get a fixed target.
  if (bar.kind === 'milestone') {
    return Math.abs(x - left) <= HANDLE_PX + 2 ? 'body' : null;
  }
  if (x < left - 2 || x > left + width + 2) return null;
  if (width < HANDLE_PX * 3) return 'body';
  if (x <= left + HANDLE_PX) return 'start';
  if (x >= left + width - HANDLE_PX) return 'end';
  return 'body';
}

/** Where a bar sits on screen, for hit-testing and for the DOM overlay. */
export function barRect(
  bar: Bar,
  rowIndex: number,
  scale: Timescale,
  metrics: ChartMetrics
): { x: number; width: number; y: number; height: number } {
  return barRectFor(bar, scale, rowIndex * metrics.rowHeight, metrics);
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function drawRuler(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { palette, metrics, scale, scrollLeft, width, height } = input;
  const fromX = scrollLeft;
  const toX = scrollLeft + width;
  const half = metrics.headerHeight / 2;

  ctx.save();
  ctx.fillStyle = palette.backgroundAlt;
  ctx.fillRect(0, 0, width, metrics.headerHeight);

  ctx.translate(-scrollLeft, 0);
  ctx.font = '11px var(--font-interface), sans-serif';
  ctx.textBaseline = 'middle';

  const majors = majorTicks(scale, fromX, toX);
  for (let i = 0; i < majors.length; i += 1) {
    const tick = majors[i];
    if (!tick) continue;
    ctx.strokeStyle = palette.gridLineStrong;
    ctx.beginPath();
    ctx.moveTo(Math.round(tick.x) + 0.5, 0);
    ctx.lineTo(Math.round(tick.x) + 0.5, metrics.headerHeight);
    ctx.stroke();

    // Pin the label to the viewport's left edge while its span is still on screen.
    // Drawn at `tick.x` it would scroll away, leaving the ruler with no year or month
    // context at all once the user scrolls past the boundary.
    const labelX = Math.max(tick.x + 6, fromX + 6);
    const nextX = majors[i + 1]?.x ?? Number.POSITIVE_INFINITY;
    const labelWidth = ctx.measureText(tick.label).width;
    if (labelX + labelWidth < nextX) {
      ctx.fillStyle = palette.text;
      ctx.fillText(tick.label, labelX, half / 2);
    }
  }

  for (const tick of minorTicks(scale, fromX, toX)) {
    ctx.strokeStyle = palette.gridLine;
    ctx.beginPath();
    ctx.moveTo(Math.round(tick.x) + 0.5, half);
    ctx.lineTo(Math.round(tick.x) + 0.5, metrics.headerHeight);
    ctx.stroke();
    // At tight zooms the labels would collide into an unreadable smear.
    if (scale.pxPerDay >= 12 || scale.zoom !== 'day') {
      ctx.fillStyle = tick.weekend ? palette.textFaint : palette.textMuted;
      ctx.fillText(tick.label, tick.x + 4, half + half / 2);
    }
  }

  ctx.restore();

  ctx.strokeStyle = palette.border;
  ctx.beginPath();
  ctx.moveTo(0, metrics.headerHeight + 0.5);
  ctx.lineTo(width, metrics.headerHeight + 0.5);
  ctx.stroke();
  void height;
}

function drawGrid(ctx: CanvasRenderingContext2D, input: RenderInput, contentHeight: number): void {
  const { palette, scale, scrollLeft, width } = input;
  const fromX = scrollLeft;
  const toX = scrollLeft + width;

  ctx.save();
  ctx.translate(-scrollLeft, 0);

  ctx.fillStyle = withAlpha(palette.nonWorking, 0.5);
  for (const band of weekendBands(scale, fromX, toX)) {
    ctx.fillRect(band.x, 0, band.width, contentHeight);
  }

  ctx.strokeStyle = palette.gridLine;
  for (const tick of minorTicks(scale, fromX, toX)) {
    ctx.beginPath();
    ctx.moveTo(Math.round(tick.x) + 0.5, 0);
    ctx.lineTo(Math.round(tick.x) + 0.5, contentHeight);
    ctx.stroke();
  }

  ctx.restore();
}

function drawToday(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  contentHeight: number
): void {
  const { palette, scale, scrollLeft, todayMs } = input;
  const x = xOf(scale, todayMs) - scrollLeft;
  if (x < 0 || x > input.width) return;
  ctx.save();
  ctx.strokeStyle = palette.today;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, contentHeight);
  ctx.stroke();
  ctx.restore();
}

function fillFor(bar: Bar, row: Row, input: RenderInput): string {
  const { palette, statuses } = input;
  if (bar.kind === 'invalid') return palette.error;
  if (row.kind === 'group') return palette.textMuted;
  const status = row.task?.status ?? '';
  return statusColor(status, statuses, palette.accent);
}

/**
 * The baselined extent, as a thin bar tucked under the live one.
 *
 * Drawn first and muted, so the comparison is available at a glance without competing
 * with the plan as it stands now.
 */
function drawBaseline(
  ctx: CanvasRenderingContext2D,
  baseline: { startMs: number; endMs: number },
  y: number,
  input: RenderInput
): void {
  const { palette, metrics, scale } = input;
  const x = xOf(scale, baseline.startMs);
  const width = Math.max(xOf(scale, baseline.endMs) - x, 2);
  const barY = y + (metrics.rowHeight + metrics.barHeight) / 2 - 1;
  ctx.save();
  ctx.fillStyle = withAlpha(palette.textMuted, 0.55);
  ctx.fillRect(x, barY, width, 3);
  ctx.restore();
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  row: Row,
  bar: Bar,
  y: number,
  input: RenderInput
): void {
  const { palette, metrics, scale } = input;
  const rect = barRectFor(bar, scale, y, metrics);
  const inferred =
    bar.kind === 'inferred-start' || bar.kind === 'inferred-end' || bar.kind === 'unplanned';
  const color = fillFor(bar, row, input);
  const selected = input.selectedIds.has(row.id);
  const hovered = input.hoveredId === row.id;

  ctx.save();

  if (row.kind === 'group') {
    // A summary bar reads as a bracket spanning its children, not as work itself.
    const barY = rect.y + rect.height / 2 - 3;
    ctx.fillStyle = withAlpha(color, 0.55);
    ctx.fillRect(rect.x, barY, rect.width, 6);
    ctx.beginPath();
    ctx.moveTo(rect.x, barY);
    ctx.lineTo(rect.x + 6, barY + 10);
    ctx.lineTo(rect.x, barY + 10);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(rect.x + rect.width, barY);
    ctx.lineTo(rect.x + rect.width - 6, barY + 10);
    ctx.lineTo(rect.x + rect.width, barY + 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return;
  }

  if (bar.kind === 'milestone') {
    const cy = rect.y + rect.height / 2;
    diamond(ctx, rect.x, cy, metrics.barHeight / 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (selected || hovered) {
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // An inferred bar is a guess, and must never read as a commitment: it is drawn
  // hollow with a dashed outline rather than filled like a planned bar.
  if (inferred) {
    ctx.fillStyle = withAlpha(color, 0.14);
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 3);
    ctx.fill();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(color, 0.85);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = color;
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 3);
    ctx.fill();
  }

  const progress = row.task?.progress ?? null;
  if (progress !== null && progress > 0 && !inferred) {
    ctx.save();
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 3);
    ctx.clip();
    ctx.fillStyle = withAlpha(palette.barText, 0.35);
    ctx.fillRect(rect.x, rect.y + rect.height - 4, rect.width * Math.min(progress, 1), 4);
    ctx.restore();
  }

  // Critical bars keep their status colour — the status is still the useful fact —
  // and gain an outline, so criticality reads as an extra property rather than
  // replacing information the user already relies on.
  if (input.critical.has(row.id)) {
    roundedRect(ctx, rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2, 4);
    ctx.strokeStyle = palette.critical;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (selected || hovered) {
    roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 3);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.stroke();
  }

  if (input.violations.has(row.id)) {
    drawViolationBadge(ctx, rect.x, rect.y + rect.height / 2, palette);
  }

  ctx.restore();
}

/** A small warning marker on a task whose plan contradicts a dependency. */
function drawViolationBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  palette: Palette
): void {
  const r = 5;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - r - 3, cy - r);
  ctx.lineTo(x - 3, cy);
  ctx.lineTo(x - r - 3, cy + r);
  ctx.closePath();
  ctx.fillStyle = palette.error;
  ctx.fill();
  ctx.restore();
}

/** One end of a dependency arrow: where it attaches, and which way it points. */
export interface Anchor {
  x: number;
  y: number;
  /** +1 when the line runs rightward away from (or into) the bar, -1 when leftward. */
  dir: 1 | -1;
}

/**
 * Where an arrow meets a bar.
 *
 * A milestone is a diamond centred on its instant rather than a rectangle, so its
 * anchors sit on the diamond's points, not on a 2px box.
 */
function anchorOn(
  bar: Bar,
  rect: { x: number; width: number; y: number; height: number },
  side: 'start' | 'finish',
  metrics: ChartMetrics
): { x: number; y: number } {
  const y = rect.y + rect.height / 2;
  if (bar.kind === 'milestone') {
    const r = metrics.barHeight / 2 + 1;
    return { x: side === 'start' ? rect.x - r : rect.x + r, y };
  }
  return { x: side === 'start' ? rect.x : rect.x + rect.width, y };
}

/**
 * The two ends of an edge, derived from its relation type.
 *
 * The line always leaves a FINISH end rightward and a START end leftward, and enters a
 * START end from the left and a FINISH end from the right. That is what makes the
 * relation type readable from the picture alone.
 */
export function anchorsFor(
  edge: Edge,
  fromBar: Bar,
  toBar: Bar,
  fromRect: { x: number; width: number; y: number; height: number },
  toRect: { x: number; width: number; y: number; height: number },
  metrics: ChartMetrics
): { from: Anchor; to: Anchor } {
  const fromSide = edge.reltype === 'STARTTOSTART' || edge.reltype === 'STARTTOFINISH'
    ? 'start'
    : 'finish';
  const toSide = edge.reltype === 'FINISHTOFINISH' || edge.reltype === 'STARTTOFINISH'
    ? 'finish'
    : 'start';

  const a = anchorOn(fromBar, fromRect, fromSide, metrics);
  const b = anchorOn(toBar, toRect, toSide, metrics);

  return {
    from: { ...a, dir: fromSide === 'finish' ? 1 : -1 },
    to: { ...b, dir: toSide === 'start' ? 1 : -1 }
  };
}

/**
 * An orthogonal route between two anchors.
 *
 * Right angles only. The previous version cut one long diagonal from the source across
 * to the target's row, which at these distances made it impossible to tell which bar a
 * line belonged to — five arrows leaving one task fanned out as five near-parallel
 * diagonals with no distinguishable start or end.
 */
export function routeEdge(from: Anchor, to: Anchor): { x: number; y: number }[] {
  const stub = 11;
  // Enough to read as a corner, small enough to fit between two adjacent bars.
  const minStub = 3;

  // The vertical run sits just BEFORE the target, not just after the source. That puts
  // the long horizontal on the source's row — empty to the right of its own bar —
  // instead of along the target's row, where it would run over the target bar and any
  // baseline beneath it before finally reaching the arrowhead.
  const preferred = to.x - to.dir * stub;
  const clearsSource =
    from.dir > 0 ? preferred >= from.x + minStub : preferred <= from.x - minStub;

  if (clearsSource) {
    return [
      { x: from.x, y: from.y },
      { x: preferred, y: from.y },
      { x: preferred, y: to.y },
      { x: to.x, y: to.y }
    ];
  }

  // Not enough room for a full stub. Back-to-back bars are the common case here — a
  // task starting the day after its predecessor ends — and they still deserve a clean
  // step rather than a loop that doubles back over the target.
  const mid = (from.x + to.x) / 2;
  const midClearsSource = from.dir > 0 ? mid > from.x : mid < from.x;
  const midClearsTarget = to.dir > 0 ? mid < to.x : mid > to.x;
  if (midClearsSource && midClearsTarget) {
    return [
      { x: from.x, y: from.y },
      { x: mid, y: from.y },
      { x: mid, y: to.y },
      { x: to.x, y: to.y }
    ];
  }

  // The target genuinely sits behind the source, so the line has to double back.
  // The detour runs along the boundary between the two rows, which is the gutter
  // between bars rather than across either of them.
  const exit = from.x + from.dir * stub;
  const approach = to.x - to.dir * stub;
  const midY = (from.y + to.y) / 2;
  return [
    { x: from.x, y: from.y },
    { x: exit, y: from.y },
    { x: exit, y: midY },
    { x: approach, y: midY },
    { x: approach, y: to.y },
    { x: to.x, y: to.y }
  ];
}

/** Stroke a polyline with rounded corners, clamped so short segments stay square. */
function strokeRoutedPath(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  radius = 4
): void {
  if (points.length < 2) return;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    if (!prev || !corner || !next) continue;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    ctx.arcTo(
      corner.x,
      corner.y,
      next.x,
      next.y,
      Math.max(0, Math.min(radius, inLen / 2, outLen / 2))
    );
  }
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** A filled arrowhead at the target, pointing the way the line arrives. */
function drawArrowhead(ctx: CanvasRenderingContext2D, to: Anchor): void {
  const size = 5;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - to.dir * size, to.y - size * 0.65);
  ctx.lineTo(to.x - to.dir * size, to.y + size * 0.65);
  ctx.closePath();
  ctx.fill();
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  rowIndexById: Map<string, number>,
  firstRow: number,
  lastRow: number
): void {
  const { palette, metrics, scale, rows } = input;
  ctx.save();
  ctx.lineJoin = 'round';

  // Hovering or selecting a task brings ITS OWN dependencies forward. Everything else
  // keeps its usual weight: fading the rest made the surrounding arrows harder to read
  // at exactly the moment the user was studying that part of the chart.
  const focus = input.hoveredId ?? (input.selectedIds.size === 1
    ? [...input.selectedIds][0] ?? null
    : null);

  const visible = input.edges.filter((edge) => {
    const fromIndex = rowIndexById.get(edge.from);
    const toIndex = rowIndexById.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined) return false;
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    // One end on screen is enough; both off screen means the line cannot be seen.
    return hi >= firstRow && lo <= lastRow;
  });

  // Draw in order of prominence so an emphasised arrow is never buried under a faint
  // one: background first, then critical, then whatever is focused.
  const rank = (edge: Edge): number => {
    if (focus !== null && (edge.from === focus || edge.to === focus)) return 2;
    return input.criticalEdges.has(edge) ? 1 : 0;
  };
  const ordered = [...visible].sort((a, b) => rank(a) - rank(b));

  for (const edge of ordered) {
    const fromIndex = rowIndexById.get(edge.from);
    const toIndex = rowIndexById.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined) continue;
    const fromBar = rows[fromIndex]?.bar;
    const toBar = rows[toIndex]?.bar;
    if (!fromBar || !toBar) continue;

    const fromRect = barRectFor(fromBar, scale, fromIndex * metrics.rowHeight, metrics);
    const toRect = barRectFor(toBar, scale, toIndex * metrics.rowHeight, metrics);
    const { from, to } = anchorsFor(edge, fromBar, toBar, fromRect, toRect, metrics);

    const emphasised = rank(edge) === 2;
    const isCritical = input.criticalEdges.has(edge);

    const base = emphasised
      ? palette.accent
      : isCritical
        ? palette.critical
        : palette.textMuted;
    // Emphasis is added, never subtracted: an unrelated arrow looks the same whether
    // or not something else is hovered.
    const alpha = emphasised ? 1 : isCritical ? 0.85 : 0.45;

    ctx.strokeStyle = withAlpha(base, alpha);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = emphasised ? 2 : isCritical ? 1.75 : 1;

    strokeRoutedPath(ctx, routeEdge(from, to));
    if (input.showArrowheads) drawArrowhead(ctx, to);
  }

  ctx.restore();
}

function drawLinkLine(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  line: { fromX: number; fromY: number; toX: number; toY: number; valid: boolean }
): void {
  const { palette } = input;
  ctx.save();
  // Red while the drop target is invalid, so a link that would form a cycle or point
  // at itself is rejected visibly before the pointer is released.
  ctx.strokeStyle = line.valid ? palette.accent : palette.error;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(line.fromX, line.fromY);
  ctx.lineTo(line.toX, line.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(line.toX, line.toY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = line.valid ? palette.accent : palette.error;
  ctx.fill();
  ctx.restore();
}

/**
 * A daily load histogram.
 *
 * Scaled to the greater of the lane's peak and its capacity, so the capacity line is
 * always visible and a lane running comfortably under capacity does not look full.
 */
function drawCapacityRow(
  ctx: CanvasRenderingContext2D,
  data: CapacityRowData,
  y: number,
  input: RenderInput
): void {
  const { palette, metrics, scale } = input;
  const top = y + 3;
  const height = metrics.rowHeight - 6;
  if (height <= 0) return;

  const bounded = Number.isFinite(data.capacity);
  const ceiling = Math.max(data.peakMinutes, bounded ? data.capacity : 0, 1);
  const dayWidth = Math.max(scale.pxPerDay, 1);

  ctx.save();
  for (const [dayMs, minutes] of data.days) {
    if (minutes <= 0) continue;
    const x = xOf(scale, dayMs);
    const h = Math.max(1, (minutes / ceiling) * height);
    const over = bounded && minutes > data.capacity;
    ctx.fillStyle = over ? withAlpha(palette.error, 0.75) : withAlpha(palette.accent, 0.5);
    // Inset by a fraction of a day so adjacent bars read as separate columns.
    ctx.fillRect(x + dayWidth * 0.1, top + height - h, Math.max(dayWidth * 0.8, 1), h);
  }

  if (bounded) {
    const lineY = top + height - (data.capacity / ceiling) * height;
    ctx.strokeStyle = withAlpha(palette.textMuted, 0.8);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(input.scrollLeft, Math.round(lineY) + 0.5);
    ctx.lineTo(input.scrollLeft + input.width, Math.round(lineY) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/**
 * Markers for bars that lie outside the horizontal viewport.
 *
 * Pinned to the timeline edge on the row the task occupies, coloured by its status and
 * pointing the way you would scroll to reach it. Clicking one scrolls it into view.
 */
function drawOffscreenMarkers(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  fromRow: number,
  toRow: number
): void {
  const { rows, metrics, scale, palette, scrollLeft, width } = input;

  ctx.save();
  for (let i = fromRow; i < toRow; i += 1) {
    const row = rows[i];
    if (!row?.bar || row.kind === 'capacity') continue;
    const side = offscreenSide(row.bar, scale, scrollLeft, width);
    if (side === null) continue;

    const cy = i * metrics.rowHeight + metrics.rowHeight / 2;
    const color = fillFor(row.bar, row, input);
    const size = 5;
    const x = side === 'left' ? 6 : width - 6;
    const dir = side === 'left' ? -1 : 1;

    // A backing pill keeps the marker legible over the grid lines and weekend bands.
    ctx.fillStyle = withAlpha(palette.background, 0.85);
    roundedRect(ctx, x - 7, cy - 7, 14, 14, 4);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + dir * size, cy);
    ctx.lineTo(x - dir * size * 0.7, cy - size);
    ctx.lineTo(x - dir * size * 0.7, cy + size);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Paint one frame. */
export function renderChart(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { palette, metrics, rows, viewport, width, height, scrollLeft } = input;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);

  const bodyHeight = Math.max(0, height - metrics.headerHeight);
  const slice = visibleRows(rows.length, { ...viewport, height: bodyHeight });

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, metrics.headerHeight, width, bodyHeight);
  ctx.clip();
  ctx.translate(0, metrics.headerHeight - viewport.scrollTop);

  drawGrid(ctx, input, slice.totalHeight);
  drawToday(ctx, input, slice.totalHeight);

  ctx.save();
  ctx.translate(-scrollLeft, 0);

  const rowIndexById = new Map<string, number>();
  for (let i = slice.start; i < slice.end; i += 1) {
    const row = rows[i];
    if (row) rowIndexById.set(row.id, i);
  }
  // Edges need positions for rows just outside the viewport too, or an arrow into the
  // first visible row would vanish.
  const edgePad = 200;
  const edgeFrom = Math.max(0, slice.start - edgePad);
  const edgeTo = Math.min(rows.length, slice.end + edgePad);
  for (let i = edgeFrom; i < edgeTo; i += 1) {
    const row = rows[i];
    if (row) rowIndexById.set(row.id, i);
  }

  for (let i = slice.start; i < slice.end; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const y = i * metrics.rowHeight;

    if (row.kind === 'group') {
      ctx.fillStyle = withAlpha(palette.textMuted, 0.06);
      ctx.fillRect(scrollLeft, y, width, metrics.rowHeight);
    } else if (row.kind === 'capacity') {
      ctx.fillStyle = withAlpha(palette.textMuted, 0.03);
      ctx.fillRect(scrollLeft, y, width, metrics.rowHeight);
    } else if (input.hoveredId === row.id) {
      ctx.fillStyle = withAlpha(palette.accent, 0.06);
      ctx.fillRect(scrollLeft, y, width, metrics.rowHeight);
    }

    ctx.strokeStyle = withAlpha(palette.gridLine, 0.6);
    ctx.beginPath();
    ctx.moveTo(scrollLeft, Math.round(y + metrics.rowHeight) + 0.5);
    ctx.lineTo(scrollLeft + width, Math.round(y + metrics.rowHeight) + 0.5);
    ctx.stroke();
  }

  if (input.showDependencies) {
    drawEdges(ctx, input, rowIndexById, edgeFrom, edgeTo);
  }

  for (let i = slice.start; i < slice.end; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.kind === 'capacity') {
      const data = input.loads.get(row.id);
      if (data) drawCapacityRow(ctx, data, i * metrics.rowHeight, input);
      continue;
    }
    if (!row.bar) continue;
    const baseline = input.baselines.get(row.id);
    if (baseline) drawBaseline(ctx, baseline, i * metrics.rowHeight, input);
    drawBar(ctx, row, row.bar, i * metrics.rowHeight, input);
  }

  if (input.linkLine) drawLinkLine(ctx, input, input.linkLine);

  ctx.restore();

  // Drawn outside the horizontal translation: these are pinned to the viewport edge,
  // not to a position on the timeline.
  drawOffscreenMarkers(ctx, input, slice.start, slice.end);

  ctx.restore();

  drawRuler(ctx, input);
}
