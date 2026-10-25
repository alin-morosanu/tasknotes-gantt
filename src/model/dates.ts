import type { TaskDate } from '../types';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Parse a frontmatter date value.
 *
 * Date-only values are anchored to LOCAL midnight, not UTC. `new Date('2026-04-15')`
 * would parse as UTC and shift the bar a day for anyone west of Greenwich, which is
 * the classic off-by-one in date handling — so the components are applied explicitly.
 *
 * Returns null for anything that is not a usable date, including the empty-string
 * values (`scheduled:`) that appear throughout the vault and arrive here as null or ''.
 */
export function parseTaskDate(value: unknown): TaskDate | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { ms: value.getTime(), dateOnly: false, raw: value.toISOString() };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ms: value, dateOnly: false, raw: String(value) } : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (raw === '') return null;

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const ms = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
    return Number.isNaN(ms) ? null : { ms, dateOnly: true, raw };
  }

  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    const [, y, mo, d, h, mi, s, frac, zone] = dateTime;
    if (zone) {
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? null : { ms, dateOnly: false, raw };
    }
    // No zone means the author meant local time.
    const ms = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? 0),
      Number((frac ?? '0').padEnd(3, '0'))
    ).getTime();
    return Number.isNaN(ms) ? null : { ms, dateOnly: false, raw };
  }

  return null;
}

/** Format epoch milliseconds back to the shape TaskNotes expects. */
export function formatTaskDate(ms: number, dateOnly: boolean): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dateOnly) return date;
  return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local midnight at the start of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight at the start of the following day. */
export function startOfNextDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Add whole calendar days, DST-safe (unlike adding `n * DAY_MS`). */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Whole calendar days between two instants, ignoring time of day. */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
}

const DURATION =
  /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parse an ISO-8601 duration into minutes, as used by dependency `gap` and reminder
 * offsets. Years and months are approximated (365/30 days) because a lag expressed in
 * months has no exact minute count; dependency gaps in practice are hours or days.
 *
 * Returns null when the string is not a valid duration.
 */
export function parseDurationMinutes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;

  const m = DURATION.exec(raw);
  if (!m) return null;
  const [, sign, years, months, weeks, days, hours, minutes, seconds] = m;
  // `P` alone, or `PT` alone, matches the regex but carries no components.
  if (!years && !months && !weeks && !days && !hours && !minutes && !seconds) return null;

  const num = (v: string | undefined) => (v === undefined ? 0 : Number(v));
  const total =
    num(years) * 365 * 24 * 60 +
    num(months) * 30 * 24 * 60 +
    num(weeks) * 7 * 24 * 60 +
    num(days) * 24 * 60 +
    num(hours) * 60 +
    num(minutes) +
    num(seconds) / 60;

  return sign === '-' ? -total : total;
}

/** Render minutes back to an ISO-8601 duration, for writing a dependency gap. */
export function formatDurationMinutes(minutes: number): string {
  if (minutes === 0) return 'PT0M';
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const days = Math.floor(abs / (24 * 60));
  const hours = Math.floor((abs % (24 * 60)) / 60);
  const mins = Math.round(abs % 60);
  const date = days > 0 ? `${days}D` : '';
  const time = [hours > 0 ? `${hours}H` : '', mins > 0 ? `${mins}M` : ''].join('');
  return `${sign}P${date}${time ? `T${time}` : ''}`;
}
