import { describe, expect, it } from 'vitest';
import type { StatusDef } from '../src/types';
import { resolveProgress, withProgress, type ProgressSource } from '../src/model/progress';
import { makeTask as task } from './fixtures/build';
import { sumTimeEntries } from '../src/data/normalize';
import { CATALOG } from './fixtures/tasks';

const statuses: StatusDef[] = CATALOG.statuses;

describe('sumTimeEntries', () => {
  it('adds explicit durations', () => {
    expect(sumTimeEntries([{ duration: 30 }, { duration: 45 }])).toBe(75);
  });

  it('derives a duration from start and end when none is given', () => {
    expect(
      sumTimeEntries([{ startTime: '2026-04-13T09:00', endTime: '2026-04-13T10:30' }])
    ).toBe(90);
  });

  it('ignores a running session, whose duration is not yet known', () => {
    expect(sumTimeEntries([{ startTime: '2026-04-13T09:00' }])).toBeNull();
    expect(
      sumTimeEntries([{ duration: 30 }, { startTime: '2026-04-13T09:00' }])
    ).toBe(30);
  });

  it('returns null rather than zero when there are no entries at all', () => {
    // "None tracked" and "zero tracked" are different claims.
    expect(sumTimeEntries([])).toBeNull();
    expect(sumTimeEntries(undefined)).toBeNull();
    expect(sumTimeEntries('nonsense')).toBeNull();
  });
});

describe('resolveProgress', () => {
  it('reports a completed task as fully done', () => {
    const result = resolveProgress(task({ status: 'done', completed: true }), statuses);
    expect(result).toEqual({ ratio: 1, source: 'status' });
  });

  it('uses the checklist ratio, which is the signal this vault actually has', () => {
    const result = resolveProgress(task({ checklist: { done: 3, total: 9 } }), statuses);
    expect(result?.source).toBe('checklist');
    expect(result?.ratio).toBeCloseTo(1 / 3, 6);
  });

  it('uses tracked time against the estimate when there is no checklist', () => {
    const result = resolveProgress(
      task({ trackedMinutes: 60, timeEstimate: 240 }),
      statuses
    );
    expect(result).toEqual({ ratio: 0.25, source: 'tracked' });
  });

  it('caps tracked progress at 100%, since overrunning is not more than done', () => {
    const result = resolveProgress(
      task({ trackedMinutes: 600, timeEstimate: 240 }),
      statuses
    );
    expect(result?.ratio).toBe(1);
  });

  it('falls back to position in the status list', () => {
    const result = resolveProgress(task({ status: 'in-progress' }), statuses);
    expect(result?.source).toBe('statusOrder');
    expect(result?.ratio).toBeGreaterThan(0);
    expect(result?.ratio).toBeLessThan(1);
  });

  it('returns null when nothing can answer, rather than claiming zero', () => {
    // A task with no checklist and no tracking has not necessarily had no work done.
    const noSignal = task({ status: 'unknown-status' });
    expect(resolveProgress(noSignal, statuses, ['checklist', 'tracked'])).toBeNull();
  });

  it('respects a custom source order', () => {
    const t = task({
      status: 'in-progress',
      checklist: { done: 1, total: 2 },
      trackedMinutes: 240,
      timeEstimate: 240
    });
    const order: ProgressSource[] = ['tracked', 'checklist', 'status', 'statusOrder'];
    expect(resolveProgress(t, statuses, order)?.source).toBe('tracked');
    expect(resolveProgress(t, statuses, ['checklist', 'tracked'])?.source).toBe('checklist');
  });

  it('skips a source that cannot answer and tries the next', () => {
    const t = task({ checklist: { done: 0, total: 0 }, trackedMinutes: 120, timeEstimate: 240 });
    // An empty checklist is not an answer of zero.
    expect(resolveProgress(t, statuses)?.source).toBe('tracked');
  });

  it('completion wins over a half-finished checklist', () => {
    const t = task({ completed: true, checklist: { done: 1, total: 9 } });
    expect(resolveProgress(t, statuses)?.ratio).toBe(1);
  });
});

describe('withProgress', () => {
  it('fills the progress field without mutating the input', () => {
    const original = task({ checklist: { done: 1, total: 4 } });
    const [updated] = withProgress([original], statuses);
    expect(updated?.progress).toBe(0.25);
    expect(original.progress).toBeNull();
  });

  it('leaves progress null where nothing can answer', () => {
    const [updated] = withProgress([task({ status: 'unknown' })], statuses, ['checklist']);
    expect(updated?.progress).toBeNull();
  });
});
