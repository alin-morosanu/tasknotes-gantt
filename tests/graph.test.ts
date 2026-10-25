import { describe, expect, it } from 'vitest';
import type { GanttTask, RelType } from '../src/types';
import {
  buildAdjacency,
  buildEdges,
  connectedComponents,
  detectCycles,
  topologicalOrder,
  wouldCreateCycle
} from '../src/model/graph';
import { normalizeTask, type NormalizeContext } from '../src/data/normalize';
import { makeTask } from './fixtures/build';
import { CATALOG, KNOWN_PATHS, makeResolver, OBJECT_DEPS, STRING_DEPS } from './fixtures/tasks';

/** A task carrying only dependencies, which is all the graph pass reads. */
function task(
  path: string,
  deps: { path: string; reltype?: RelType; gap?: string }[] = []
): GanttTask {
  return makeTask({
    path,
    title: path,
    dependencies: deps.map((d) => ({
      uid: d.path,
      path: d.path,
      reltype: d.reltype ?? 'FINISHTOSTART',
      ...(d.gap === undefined ? {} : { gap: d.gap })
    }))
  });
}

function graphOf(tasks: GanttTask[]) {
  const built = buildEdges(tasks);
  const paths = tasks.map((t) => t.path);
  return { ...built, paths, adjacency: buildAdjacency(paths, built.edges) };
}

describe('buildEdges', () => {
  it('orients an edge from the blocker to the blocked task', () => {
    const { edges } = graphOf([task('a'), task('b', [{ path: 'a' }])]);
    expect(edges).toEqual([
      { from: 'a', uid: 'a', to: 'b', reltype: 'FINISHTOSTART', gapMinutes: 0 }
    ]);
  });

  it('carries the authored uid, not just the resolved path', () => {
    // TaskNotes matches a dependency on the string that was written, so an edge that
    // knew only the resolved file could never be removed again.
    const resolve = makeResolver(KNOWN_PATHS);
    const ctx: NormalizeContext = { catalog: CATALOG, resolveLink: (t) => resolve(t) };
    const tasks = [
      task('TaskNotes/Tasks/BEL-0001 Draft homepage copy for review.md'),
      normalizeTask(OBJECT_DEPS, ctx)
    ];
    const { edges } = buildEdges(tasks);
    // The link was authored without a `.md` suffix; the resolved path has one.
    expect(edges[0]?.uid).toBe('TaskNotes/Tasks/BEL-0001 Draft homepage copy for review');
    expect(edges[0]?.from).toBe('TaskNotes/Tasks/BEL-0001 Draft homepage copy for review.md');
    expect(edges[0]?.uid).not.toBe(edges[0]?.from);
  });

  it('resolves a gap into minutes', () => {
    const { edges } = graphOf([task('a'), task('b', [{ path: 'a', gap: 'PT4H' }])]);
    expect(edges[0]?.gapMinutes).toBe(240);
  });

  it('reports dependencies pointing outside the data set instead of dropping them', () => {
    const { edges, dangling } = graphOf([task('b', [{ path: 'missing' }])]);
    expect(edges).toHaveLength(0);
    expect(dangling).toEqual([{ from: 'b', uid: 'missing' }]);
  });

  it('reports a self-link rather than creating a self-edge', () => {
    const { edges, selfLinks } = graphOf([task('a', [{ path: 'a' }])]);
    expect(edges).toHaveLength(0);
    expect(selfLinks).toEqual(['a']);
  });

  it('collapses a predecessor listed twice under the same relation type', () => {
    const { edges } = graphOf([task('a'), task('b', [{ path: 'a' }, { path: 'a' }])]);
    expect(edges).toHaveLength(1);
  });

  it('keeps two different relation types between the same pair', () => {
    const { edges } = graphOf([
      task('a'),
      task('b', [{ path: 'a' }, { path: 'a', reltype: 'STARTTOSTART' }])
    ]);
    expect(edges).toHaveLength(2);
  });

  it('builds the same edge from either authored dependency shape', () => {
    const resolve = makeResolver(KNOWN_PATHS);
    const ctx: NormalizeContext = { catalog: CATALOG, resolveLink: (t) => resolve(t) };
    const tasks = [
      task('TaskNotes/Tasks/BEL-0001 Draft homepage copy for review.md'),
      normalizeTask(OBJECT_DEPS, ctx),
      normalizeTask(STRING_DEPS, ctx),
      task('TaskNotes/Tasks/BEL-0004 Migrate archive pages into the CMS.md')
    ];
    const { edges, dangling } = buildEdges(tasks);
    expect(dangling).toHaveLength(0);
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.reltype === 'FINISHTOSTART')).toBe(true);
  });
});

describe('detectCycles', () => {
  it('finds nothing in an acyclic graph', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('c', [{ path: 'b' }])]);
    expect(detectCycles(g.paths, g.adjacency)).toEqual([]);
  });

  it('finds a three-node ring and names every member', () => {
    const g = graphOf([
      task('a', [{ path: 'c' }]),
      task('b', [{ path: 'a' }]),
      task('c', [{ path: 'b' }])
    ]);
    const cycles = detectCycles(g.paths, g.adjacency);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0]?.members ?? [])].sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds two independent rings', () => {
    const g = graphOf([
      task('a', [{ path: 'b' }]),
      task('b', [{ path: 'a' }]),
      task('c', [{ path: 'd' }]),
      task('d', [{ path: 'c' }])
    ]);
    expect(detectCycles(g.paths, g.adjacency)).toHaveLength(2);
  });

  it('does not mistake a diamond for a cycle', () => {
    const g = graphOf([
      task('a'),
      task('b', [{ path: 'a' }]),
      task('c', [{ path: 'a' }]),
      task('d', [{ path: 'b' }, { path: 'c' }])
    ]);
    expect(detectCycles(g.paths, g.adjacency)).toEqual([]);
  });

  it('handles a long chain without recursing', () => {
    const size = 20000;
    const tasks: GanttTask[] = [task('n0')];
    for (let i = 1; i < size; i += 1) tasks.push(task(`n${i}`, [{ path: `n${i - 1}` }]));
    const g = graphOf(tasks);
    expect(detectCycles(g.paths, g.adjacency)).toEqual([]);
    expect(topologicalOrder(g.paths, g.adjacency).order).toHaveLength(size);
  });
});

describe('topologicalOrder', () => {
  it('places every predecessor before its successor', () => {
    const g = graphOf([
      task('d', [{ path: 'b' }, { path: 'c' }]),
      task('b', [{ path: 'a' }]),
      task('c', [{ path: 'a' }]),
      task('a')
    ]);
    const { order, unordered } = topologicalOrder(g.paths, g.adjacency);
    expect(unordered).toEqual([]);
    const at = (p: string) => order.indexOf(p);
    expect(at('a')).toBeLessThan(at('b'));
    expect(at('a')).toBeLessThan(at('c'));
    expect(at('b')).toBeLessThan(at('d'));
    expect(at('c')).toBeLessThan(at('d'));
  });

  it('reports the members of a cycle as unordered rather than looping', () => {
    const g = graphOf([task('a', [{ path: 'b' }]), task('b', [{ path: 'a' }]), task('c')]);
    const { order, unordered } = topologicalOrder(g.paths, g.adjacency);
    expect(order).toEqual(['c']);
    expect([...unordered].sort()).toEqual(['a', 'b']);
  });

  it('excludes the nodes it is told to skip', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }])]);
    const { order } = topologicalOrder(g.paths, g.adjacency, new Set(['a']));
    expect(order).toEqual(['b']);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects a self-link', () => {
    const g = graphOf([task('a')]);
    expect(wouldCreateCycle('a', 'a', g.adjacency)).toBe(true);
  });

  it('rejects an edge that closes an existing chain', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('c', [{ path: 'b' }])]);
    // c already depends on a transitively, so a depending on c closes the ring.
    expect(wouldCreateCycle('c', 'a', g.adjacency)).toBe(true);
  });

  it('allows an edge that keeps the graph acyclic', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('c')]);
    expect(wouldCreateCycle('b', 'c', g.adjacency)).toBe(false);
    expect(wouldCreateCycle('c', 'b', g.adjacency)).toBe(false);
  });
});

describe('connectedComponents', () => {
  it('separates unrelated chains', () => {
    const g = graphOf([
      task('a1'),
      task('a2', [{ path: 'a1' }]),
      task('b1'),
      task('b2', [{ path: 'b1' }])
    ]);
    const components = connectedComponents(g.paths, g.adjacency);
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.length).sort()).toEqual([2, 2]);
  });

  it('joins tasks that only share a predecessor', () => {
    // Neither b nor c depends on the other, but they are part of the same plan.
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('c', [{ path: 'a' }])]);
    expect(connectedComponents(g.paths, g.adjacency)).toHaveLength(1);
  });

  it('gives a task with no dependencies a component of its own', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('lonely')]);
    const components = connectedComponents(g.paths, g.adjacency);
    expect(components).toHaveLength(2);
    expect(components.some((c) => c.length === 1 && c[0] === 'lonely')).toBe(true);
  });

  it('covers every task exactly once', () => {
    const g = graphOf([task('a'), task('b', [{ path: 'a' }]), task('c'), task('d')]);
    const components = connectedComponents(g.paths, g.adjacency);
    const all = components.flat();
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });
});
