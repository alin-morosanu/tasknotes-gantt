import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatDurationMinutes,
  formatTaskDate,
  parseDurationMinutes,
  parseTaskDate,
  startOfDay
} from '../src/model/dates';

describe('parseTaskDate', () => {
  it('anchors a date-only value to local midnight, not UTC', () => {
    const parsed = parseTaskDate('2026-04-15');
    expect(parsed).not.toBeNull();
    const d = new Date(parsed!.ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(parsed!.dateOnly).toBe(true);
  });

  it('parses a zoneless datetime as local time', () => {
    const parsed = parseTaskDate('2025-11-10T13:38');
    expect(parsed?.dateOnly).toBe(false);
    const d = new Date(parsed!.ms);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(38);
  });

  it('honours an explicit offset', () => {
    const parsed = parseTaskDate('2026-04-07T18:00:00.000+01:00');
    expect(parsed?.ms).toBe(Date.parse('2026-04-07T18:00:00.000+01:00'));
    expect(parsed?.dateOnly).toBe(false);
  });

  it('treats the vault’s blank values as absent, not as errors', () => {
    expect(parseTaskDate('')).toBeNull();
    expect(parseTaskDate('   ')).toBeNull();
    expect(parseTaskDate(null)).toBeNull();
    expect(parseTaskDate(undefined)).toBeNull();
  });

  it('rejects values that are not dates', () => {
    expect(parseTaskDate('not a date')).toBeNull();
    expect(parseTaskDate('2026-13-45')).not.toBeNull(); // rolls over, but stays a date
    expect(parseTaskDate({})).toBeNull();
    expect(parseTaskDate(true)).toBeNull();
  });

  it('round-trips through formatTaskDate', () => {
    const parsed = parseTaskDate('2026-04-15')!;
    expect(formatTaskDate(parsed.ms, true)).toBe('2026-04-15');
    const dt = parseTaskDate('2025-11-10T13:38')!;
    expect(formatTaskDate(dt.ms, false)).toBe('2025-11-10T13:38');
  });
});

describe('day arithmetic', () => {
  it('adds days across a DST boundary without drifting', () => {
    const start = parseTaskDate('2026-03-28')!.ms;
    const later = addDays(start, 3);
    expect(new Date(later).getDate()).toBe(31);
    expect(new Date(later).getHours()).toBe(0);
  });

  it('counts whole days regardless of time of day', () => {
    const from = parseTaskDate('2026-04-13T22:00')!.ms;
    const to = parseTaskDate('2026-04-15T01:00')!.ms;
    expect(daysBetween(from, to)).toBe(2);
  });

  it('startOfDay is idempotent', () => {
    const ms = parseTaskDate('2026-04-15T13:38')!.ms;
    expect(startOfDay(startOfDay(ms))).toBe(startOfDay(ms));
  });
});

describe('parseDurationMinutes', () => {
  it('parses the gap forms TaskNotes documents', () => {
    expect(parseDurationMinutes('PT4H')).toBe(240);
    expect(parseDurationMinutes('P1D')).toBe(1440);
    expect(parseDurationMinutes('PT15M')).toBe(15);
    expect(parseDurationMinutes('P1DT2H30M')).toBe(1590);
  });

  it('parses the negative offsets used by reminders', () => {
    expect(parseDurationMinutes('-P1D')).toBe(-1440);
    expect(parseDurationMinutes('-PT5M')).toBe(-5);
    expect(parseDurationMinutes('PT0M')).toBe(0);
  });

  it('rejects malformed and component-less durations', () => {
    expect(parseDurationMinutes('P')).toBeNull();
    expect(parseDurationMinutes('PT')).toBeNull();
    expect(parseDurationMinutes('4H')).toBeNull();
    expect(parseDurationMinutes('')).toBeNull();
    expect(parseDurationMinutes(null)).toBeNull();
  });

  it('round-trips through formatDurationMinutes', () => {
    for (const minutes of [0, 15, 240, 1440, 1590, -1440]) {
      expect(parseDurationMinutes(formatDurationMinutes(minutes))).toBe(minutes);
    }
  });
});
