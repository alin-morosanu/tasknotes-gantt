import type { Bar, Edge, StatusDef, TaskPath } from '../types';
import type { Row } from '../render/layout';
import { anchorsFor, routeEdge, type ChartMetrics } from '../render/canvas';
import { majorTicks, minorTicks, weekendBands, xOf, type Timescale } from '../render/timescale';
import type { Palette } from '../render/theme';

/**
 * The chart as vector graphics.
 *
 * Built from the same geometry the canvas painter uses, so an export matches what was
 * on screen rather than being a second, subtly different drawing. Unlike the PNG it
 * scales and prints cleanly, and the task names are real text.
 */

export interface SvgOptions {
  rows: readonly Row[];
  bars: ReadonlyMap<TaskPath, Bar>;
  edges: readonly Edge[];
  scale: Timescale;
  metrics: ChartMetrics;
  palette: Palette;
  statuses: readonly StatusDef[];
  critical: ReadonlySet<TaskPath>;
  /** Horizontal extent to draw, in timeline pixels. */
  startX: number;
  endX: number;
  /** Width of the task-name column. */
  labelWidth: number;
  todayMs: number;
  title?: string;
  /** Match the chart: heads are drawn only when the view is showing them. */
  showArrowheads?: boolean;
}

/** Escape text for inclusion in XML content or an attribute. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function statusColour(
  value: string,
  statuses: readonly StatusDef[],
  fallback: string
): string {
  return statuses.find((s) => s.value === value)?.color ?? fallback;
}


export function exportSvg(options: SvgOptions): string {
  const {
    rows,
    bars,
    edges,
    scale,
    metrics,
    palette,
    statuses,
    critical,
    startX,
    endX,
    labelWidth,
    todayMs
  } = options;

  const drawable = rows.filter((row) => row.kind !== 'capacity');
  const chartWidth = Math.max(1, endX - startX);
  const width = labelWidth + chartWidth;
  const height = metrics.headerHeight + drawable.length * metrics.rowHeight;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${palette.background}"/>`);
  if (options.title !== undefined && options.title !== '') {
    parts.push(`<title>${escapeXml(options.title)}</title>`);
  }

  // Everything on the timeline is drawn in a group shifted by the viewport origin, so
  // the same x maths as the canvas applies unchanged.
  const shift = labelWidth - startX;

  parts.push(`<g transform="translate(${shift} 0)">`);
  for (const band of weekendBands(scale, startX, endX)) {
    parts.push(
      `<rect x="${band.x}" y="${metrics.headerHeight}" width="${band.width}" ` +
        `height="${height - metrics.headerHeight}" fill="${palette.nonWorking}" opacity="0.35"/>`
    );
  }
  for (const tick of minorTicks(scale, startX, endX)) {
    parts.push(
      `<line x1="${tick.x}" y1="0" x2="${tick.x}" y2="${height}" ` +
        `stroke="${palette.gridLine}" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${tick.x + 3}" y="${metrics.headerHeight - 6}" fill="${palette.textMuted}">` +
        `${escapeXml(tick.label)}</text>`
    );
  }
  for (const tick of majorTicks(scale, startX, endX)) {
    parts.push(
      `<text x="${tick.x + 3}" y="14" fill="${palette.text}" font-weight="600">` +
        `${escapeXml(tick.label)}</text>`
    );
  }
  const todayX = xOf(scale, todayMs);
  if (todayX >= startX && todayX <= endX) {
    parts.push(
      `<line x1="${todayX}" y1="0" x2="${todayX}" y2="${height}" ` +
        `stroke="${palette.today}" stroke-width="1.5"/>`
    );
  }
  parts.push('</g>');

  const rowIndex = new Map<string, number>();
  drawable.forEach((row, i) => rowIndex.set(row.id, i));

  // Dependency arrows, using the identical routing as on screen.
  parts.push(`<g transform="translate(${shift} ${metrics.headerHeight})" fill="none">`);
  for (const edge of edges) {
    const fromIdx = rowIndex.get(edge.from);
    const toIdx = rowIndex.get(edge.to);
    if (fromIdx === undefined || toIdx === undefined) continue;
    const fromBar = bars.get(edge.from);
    const toBar = bars.get(edge.to);
    if (!fromBar || !toBar) continue;

    const rectOf = (bar: Bar, index: number) => ({
      x: xOf(scale, bar.displayStartMs),
      width: Math.max(xOf(scale, bar.displayEndMs) - xOf(scale, bar.displayStartMs), 2),
      y: index * metrics.rowHeight + (metrics.rowHeight - metrics.barHeight) / 2,
      height: metrics.barHeight
    });

    const { from, to } = anchorsFor(
      edge,
      fromBar,
      toBar,
      rectOf(fromBar, fromIdx),
      rectOf(toBar, toIdx),
      metrics
    );
    const points = routeEdge(from, to);
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    const isCritical = critical.has(edge.from) && critical.has(edge.to);
    parts.push(
      `<path d="${d}" stroke="${isCritical ? palette.critical : palette.textMuted}" ` +
        `stroke-width="${isCritical ? 1.75 : 1}" opacity="${isCritical ? 0.85 : 0.45}"/>`
    );
    if (options.showArrowheads !== false) {
      const head = 5;
      parts.push(
        `<path d="M${to.x} ${to.y} L${to.x - to.dir * head} ${to.y - head * 0.65} ` +
          `L${to.x - to.dir * head} ${to.y + head * 0.65} Z" ` +
          `fill="${isCritical ? palette.critical : palette.textMuted}" opacity="0.8"/>`
      );
    }
  }
  parts.push('</g>');

  // Rows: label on the left, bar on the timeline.
  drawable.forEach((row, i) => {
    const y = metrics.headerHeight + i * metrics.rowHeight;
    const textY = y + metrics.rowHeight / 2 + 4;

    if (row.kind === 'group') {
      parts.push(
        `<rect x="0" y="${y}" width="${width}" height="${metrics.rowHeight}" ` +
          `fill="${palette.textMuted}" opacity="0.07"/>`
      );
    }
    parts.push(
      `<line x1="0" y1="${y + metrics.rowHeight}" x2="${width}" y2="${y + metrics.rowHeight}" ` +
        `stroke="${palette.gridLine}" stroke-width="0.5"/>`
    );

    const indent = 6 + row.depth * 12;
    const label = row.label.length > 60 ? `${row.label.slice(0, 57)}…` : row.label;
    parts.push(
      `<text x="${indent}" y="${textY}" fill="${palette.text}" ` +
        `${row.kind === 'group' ? 'font-weight="600"' : ''}>${escapeXml(label)}</text>`
    );

    const bar = row.bar;
    if (!bar) return;
    const barX = xOf(scale, bar.displayStartMs) + shift;
    const barW = Math.max(xOf(scale, bar.displayEndMs) - xOf(scale, bar.displayStartMs), 2);
    const barY = y + (metrics.rowHeight - metrics.barHeight) / 2;
    const colour =
      row.kind === 'group'
        ? palette.textMuted
        : statusColour(row.task?.status ?? '', statuses, palette.accent);
    const inferred =
      bar.kind === 'inferred-start' || bar.kind === 'inferred-end' || bar.kind === 'unplanned';

    if (bar.kind === 'milestone') {
      const r = metrics.barHeight / 2;
      const cy = y + metrics.rowHeight / 2;
      parts.push(
        `<path d="M${barX} ${cy - r} L${barX + r} ${cy} L${barX} ${cy + r} L${barX - r} ${cy} Z" ` +
          `fill="${colour}"/>`
      );
      return;
    }

    parts.push(
      `<rect x="${barX}" y="${barY}" width="${barW}" height="${metrics.barHeight}" rx="3" ` +
        `fill="${colour}" fill-opacity="${inferred ? 0.15 : 1}" ` +
        `stroke="${colour}" stroke-width="1" ` +
        `${inferred ? 'stroke-dasharray="3 3"' : ''}/>`
    );
    if (critical.has(row.id)) {
      parts.push(
        `<rect x="${barX - 1}" y="${barY - 1}" width="${barW + 2}" height="${metrics.barHeight + 2}" ` +
          `rx="4" fill="none" stroke="${palette.critical}" stroke-width="2"/>`
      );
    }
  });

  parts.push(
    `<line x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}" ` +
      `stroke="${palette.border}" stroke-width="1"/>`
  );
  parts.push('</svg>');

  return parts.join('\n');
}
