import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GanttWriter, type WriterHost } from '../src/bridge/writer';
import type { ReversiblePatch } from '../src/model/reschedule';
import { clearNotices, notices } from './stubs/obsidian';

/** A patch shaped like one `planDrag` would produce. */
function patch(path: string, scheduled = '2026-04-15'): ReversiblePatch {
  return {
    patch: { path, scheduled },
    inverse: { path, scheduled: '2026-04-14' },
    description: `${path}: start 2026-04-14 to ${scheduled}`
  };
}

interface Harness {
  writer: GanttWriter;
  updates: { path: string; fields: Record<string, unknown>; correlationId?: string }[];
  setSafeMode: (on: boolean) => void;
  setThreshold: (n: number) => void;
  setConfirmResult: (approve: boolean) => void;
  confirmCalls: { label: string; descriptions: string[] }[];
  failOn: (path: string | null) => void;
}

function harness(over: { writable?: boolean } = {}): Harness {
  const updates: Harness['updates'] = [];
  const confirmCalls: Harness['confirmCalls'] = [];
  let safeMode = false;
  let threshold = 10;
  let approve = true;
  let failPath: string | null = null;

  const api = {
    tasks: {
      update: vi.fn(async (path: string, fields: Record<string, unknown>, ctx?: { correlationId?: string }) => {
        if (path === failPath) throw new Error('write failed');
        const entry: Harness['updates'][number] = { path, fields };
        if (ctx?.correlationId !== undefined) entry.correlationId = ctx.correlationId;
        updates.push(entry);
      }),
      addDependency: vi.fn(async () => undefined),
      removeDependency: vi.fn(async () => undefined)
    }
  };

  const host: WriterHost = {
     
    bridge: {
      api,
      isWritable: over.writable ?? true,
      status: { reason: 'TaskNotes is not connected.' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    isSafeMode: () => safeMode,
    confirmThreshold: () => threshold,
    confirm: async (label, descriptions) => {
      confirmCalls.push({ label, descriptions });
      return approve;
    }
  };

  return {
    writer: new GanttWriter(host),
    updates,
    confirmCalls,
    setSafeMode: (on) => {
      safeMode = on;
    },
    setThreshold: (n) => {
      threshold = n;
    },
    setConfirmResult: (a) => {
      approve = a;
    },
    failOn: (p) => {
      failPath = p;
    }
  };
}

beforeEach(clearNotices);

describe('write gating', () => {
  it('writes only the fields the patch names', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.fields).toEqual({ scheduled: '2026-04-15' });
    // `due` was untouched, so it must not be sent as undefined and cleared.
    expect('due' in (h.updates[0]?.fields ?? {})).toBe(false);
  });

  it('refuses every write in safe mode, and says why', async () => {
    const h = harness();
    h.setSafeMode(true);
    const result = await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(result).toEqual({ written: 0, failed: [], cancelled: true });
    expect(h.updates).toHaveLength(0);
    expect(notices.join(' ')).toContain('Safe mode');
  });

  it('refuses to write when the bridge is not writable', async () => {
    const h = harness({ writable: false });
    const result = await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(result.cancelled).toBe(true);
    expect(h.updates).toHaveLength(0);
  });

  it('does not record an undo entry for a write that never happened', async () => {
    const h = harness();
    h.setSafeMode(true);
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(h.writer.canUndo).toBe(false);
  });
});

describe('confirmation', () => {
  it('applies a small change without asking', async () => {
    const h = harness();
    h.setThreshold(10);
    await h.writer.apply([patch('a.md'), patch('b.md')], { label: 'Reschedule' });
    expect(h.confirmCalls).toHaveLength(0);
    expect(h.updates).toHaveLength(2);
  });

  it('asks before a change that exceeds the threshold', async () => {
    const h = harness();
    h.setThreshold(2);
    const patches = ['a.md', 'b.md', 'c.md'].map((p) => patch(p));
    await h.writer.apply(patches, { label: 'Cascade' });
    expect(h.confirmCalls).toHaveLength(1);
    expect(h.confirmCalls[0]?.descriptions).toHaveLength(3);
    expect(h.updates).toHaveLength(3);
  });

  it('writes nothing when the user declines', async () => {
    const h = harness();
    h.setThreshold(1);
    h.setConfirmResult(false);
    const result = await h.writer.apply([patch('a.md'), patch('b.md')], { label: 'Cascade' });
    expect(result.cancelled).toBe(true);
    expect(h.updates).toHaveLength(0);
    expect(h.writer.canUndo).toBe(false);
  });

  it('skips the prompt when the caller already confirmed', async () => {
    const h = harness();
    h.setThreshold(1);
    await h.writer.apply([patch('a.md'), patch('b.md')], {
      label: 'Cascade',
      preconfirmed: true
    });
    expect(h.confirmCalls).toHaveLength(0);
    expect(h.updates).toHaveLength(2);
  });
});

describe('undo', () => {
  it('restores the previous values', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md', '2026-04-20')], { label: 'Reschedule T' });
    expect(h.writer.canUndo).toBe(true);
    expect(h.writer.nextUndoLabel).toBe('Reschedule T');

    await h.writer.undo();
    expect(h.updates).toHaveLength(2);
    expect(h.updates[1]?.fields).toEqual({ scheduled: '2026-04-14' });
    expect(h.writer.canUndo).toBe(false);
  });

  it('unwinds several changes in reverse order', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'first' });
    await h.writer.apply([patch('b.md')], { label: 'second' });
    expect(h.writer.nextUndoLabel).toBe('second');
    await h.writer.undo();
    expect(h.writer.nextUndoLabel).toBe('first');
  });

  it('keeps the entry when undo is blocked, so the change stays reversible later', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    h.setSafeMode(true);
    const result = await h.writer.undo();
    expect(result.cancelled).toBe(true);
    expect(h.writer.canUndo).toBe(true);
  });

  it('does nothing when there is nothing to undo', async () => {
    const h = harness();
    expect((await h.writer.undo()).cancelled).toBe(true);
  });
});

describe('echo suppression', () => {
  it('recognises an event carrying its own correlation id', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    const correlationId = h.updates[0]?.correlationId;
    expect(correlationId).toBeTruthy();
    expect(h.writer.isOwnEcho(correlationId, undefined)).toBe(true);
  });

  it('recognises an event by path when no context comes back', async () => {
    // TaskNotes is not guaranteed to echo our context, so the path is a fallback.
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(h.writer.isOwnEcho(undefined, 'a.md')).toBe(true);
  });

  it('does not claim a change someone else made', async () => {
    const h = harness();
    await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
    expect(h.writer.isOwnEcho('someone-else', 'other.md')).toBe(false);
  });

  it('stops claiming a path once the echo window has passed', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.writer.apply([patch('a.md')], { label: 'Reschedule' });
      expect(h.writer.isOwnEcho(undefined, 'a.md')).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(h.writer.isOwnEcho(undefined, 'a.md')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failures', () => {
  it('reports which writes failed while keeping the ones that worked', async () => {
    const h = harness();
    h.failOn('b.md');
    const result = await h.writer.apply([patch('a.md'), patch('b.md'), patch('c.md')], {
      label: 'Cascade'
    });
    expect(result.written).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('b.md');
    expect(notices.join(' ')).toContain('failed');
  });

  it('still records an undo entry when some writes succeeded', async () => {
    const h = harness();
    h.failOn('b.md');
    await h.writer.apply([patch('a.md'), patch('b.md')], { label: 'Cascade' });
    expect(h.writer.canUndo).toBe(true);
  });
});
