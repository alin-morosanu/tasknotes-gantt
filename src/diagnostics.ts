import type { GanttTask } from './types';
import type { BridgeStatus } from './bridge/tasknotes';
import type { TaskNotesCatalog } from './types';
import { buildAdjacency, buildEdges, detectCycles } from './model/graph';
import { buildFacets } from './model/filter';
import type { SlippageSummary } from './model/baseline';

/**
 * Builds a plain-text report of what the Gantt sees in a vault.
 *
 * This is the Phase 0 acceptance artifact: it proves the bridge, the normalizer and
 * the graph agree with the real data before any pixels are drawn, and it doubles as
 * the fastest way to diagnose "why is my task missing" reports later.
 */
export function buildDiagnosticsReport(
  tasks: GanttTask[],
  catalog: TaskNotesCatalog,
  status: BridgeStatus,
  slippage?: SlippageSummary,
  resourceField = 'assignee'
): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('# TaskNotes Gantt — data report');
  push();
  push(`Generated: ${new Date().toISOString()}`);
  push();

  push('## Connection');
  push();
  push(`- Mode: \`${status.mode}\``);
  push(`- Writable: ${status.writable ? 'yes' : 'no'}`);
  push(`- TaskNotes version: ${status.taskNotesVersion ?? 'unknown'}`);
  push(`- API version: ${status.apiVersion ?? 'n/a'}`);
  push(`- Detail: ${status.reason}`);
  push();

  push('## Catalog');
  push();
  push(
    `- Identification: \`${catalog.identification.method}\` ` +
      (catalog.identification.method === 'tag'
        ? `(#${catalog.identification.tag})`
        : `(${catalog.identification.propertyName} = ${catalog.identification.propertyValue})`)
  );
  push(`- Excluded folders: ${catalog.identification.excludedFolders.join(', ') || 'none'}`);
  push(
    `- Statuses: ${catalog.statuses
      .map((s) => `${s.value}${s.isCompleted ? ' (completed)' : ''}`)
      .join(', ')}`
  );
  push(`- Priorities: ${catalog.priorities.map((p) => `${p.value}=${p.weight}`).join(', ')}`);
  push(`- User fields: ${catalog.userFields.map((f) => f.key).join(', ') || 'none'}`);
  push(`- Resource property: \`${resourceField}\``);
  push();

  // The filter bar is built from these. When someone asks why a filter for their own
  // field is missing, this is the answer, and it is faster than reading the catalog
  // and inferring what `buildFacets` would have done with it.
  push('## Filter facets');
  push();
  push('These are the chips the filter bar renders, in order.');
  push();
  const facets = buildFacets(catalog, resourceField);
  push('| Facet | Id | Values in this vault |');
  push('| --- | --- | --- |');
  for (const facet of facets) {
    const values = new Set<string>();
    for (const task of tasks) for (const value of facet.valuesOf(task)) values.add(value);
    push(`| ${facet.label} | \`${facet.id}\` | ${values.size} |`);
  }
  push();

  const withScheduled = tasks.filter((t) => t.scheduled !== null).length;
  const withDue = tasks.filter((t) => t.due !== null).length;
  const dueOnly = tasks.filter((t) => t.due !== null && t.scheduled === null).length;
  const undated = tasks.filter((t) => t.due === null && t.scheduled === null).length;
  const withEstimate = tasks.filter((t) => t.timeEstimate !== null).length;
  const zeroEstimate = tasks.filter((t) => t.timeEstimate === 0).length;
  const withChecklist = tasks.filter((t) => (t.checklist?.total ?? 0) > 0).length;

  push('## Tasks');
  push();
  push(`- Total: ${tasks.length}`);
  push(`- Completed: ${tasks.filter((t) => t.completed).length}`);
  push(`- Archived: ${tasks.filter((t) => t.archived).length}`);
  push(`- With \`scheduled\`: ${withScheduled}`);
  push(`- With \`due\`: ${withDue}`);
  push(`- Due only (bar needs an inferred start): ${dueOnly}`);
  push(`- No dates at all (unscheduled rail): ${undated}`);
  push(`- With \`timeEstimate\`: ${withEstimate} (${zeroEstimate} of them zero, i.e. milestones)`);
  push(`- With body checklists: ${withChecklist}`);
  push();

  if (slippage && slippage.baselined > 0) {
    push('## Baseline');
    push();
    push(`- Tasks with a baseline: ${slippage.baselined}`);
    push(`- Slipped: ${slippage.slipped}`);
    push(`- Ahead of plan: ${slippage.ahead}`);
    push(`- On plan: ${slippage.onPlan}`);
    if (slippage.worstPath !== null) {
      push(`- Worst slip: ${slippage.worstDays.toFixed(1)} working days (${slippage.worstPath})`);
    }
    push();
  }

  const { edges, dangling, selfLinks } = buildEdges(tasks);
  const paths = tasks.map((t) => t.path);
  const adjacency = buildAdjacency(paths, edges);
  const cycles = detectCycles(paths, adjacency);

  push('## Dependencies');
  push();
  push(`- Tasks with dependencies: ${tasks.filter((t) => t.dependencies.length > 0).length}`);
  push(`- Resolved edges: ${edges.length}`);
  const byType = new Map<string, number>();
  for (const edge of edges) byType.set(edge.reltype, (byType.get(edge.reltype) ?? 0) + 1);
  for (const [type, count] of byType) push(`  - ${type}: ${count}`);
  push(`- Edges carrying a gap: ${edges.filter((e) => e.gapMinutes !== 0).length}`);
  push(`- Dangling dependency links: ${dangling.length}`);
  for (const d of dangling.slice(0, 10)) push(`  - ${d.from} -> missing \`${d.uid}\``);
  if (dangling.length > 10) push(`  - ...and ${dangling.length - 10} more`);
  push(`- Self-links (authoring errors): ${selfLinks.length}`);
  push(`- Circular dependencies: ${cycles.length}`);
  for (const cycle of cycles) push(`  - ${cycle.members.join(' -> ')} -> ${cycle.members[0]}`);
  push();

  const projectCounts = new Map<string, number>();
  const danglingProjects = new Map<string, number>();
  let noProject = 0;
  for (const task of tasks) {
    if (task.projects.length === 0) noProject += 1;
    for (const ref of task.projects) {
      const key = ref.path ?? ref.target;
      projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
      if (ref.path === null) danglingProjects.set(ref.target, (danglingProjects.get(ref.target) ?? 0) + 1);
    }
  }

  push('## Projects');
  push();
  push(`- Distinct project links: ${projectCounts.size}`);
  push(`- Tasks with no project: ${noProject}`);
  push(`- Dangling project links: ${danglingProjects.size}`);
  for (const [target, count] of danglingProjects) push(`  - \`${target}\` (${count} tasks)`);
  push();
  push('| Project | Tasks |');
  push('| --- | --- |');
  for (const [project, count] of [...projectCounts].sort((a, b) => b[1] - a[1])) {
    push(`| ${project} | ${count} |`);
  }
  push();

  return lines.join('\n');
}
