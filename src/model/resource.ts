import type { GanttTask } from '../types';

/**
 * Read the values a task carries for a configurable field.
 *
 * The resource axis is a property name the user chooses, and three separate places
 * need to resolve it: the load histogram, the filter facet, and the `assignee`
 * grouping. Each used to read `task.extra[field]` on its own, which is right only for
 * properties TaskNotes does not map. Ask for `contexts` — the one field 141 of 166
 * tasks in the reference vault actually carry — and `extra` is empty, so capacity was
 * fixed to special-case it and the other two silently kept returning nothing: one
 * "Unassigned" lane, one empty facet, one ungrouped lump.
 *
 * One reader, so choosing a field either works everywhere or nowhere.
 */
export function resourceValuesOf(task: GanttTask, field: string): string[] {
  switch (field) {
    case 'contexts':
      return clean(task.contexts);
    case 'tags':
      return clean(task.tags);
    case 'projects':
      return clean(task.projects.map((p) => p.alias ?? p.target));
    case 'status':
      return clean([task.status]);
    case 'priority':
      return clean([task.priority]);
    default:
      break;
  }

  const raw = task.extra[field];
  if (Array.isArray(raw)) {
    return clean(raw.filter((v): v is string => typeof v === 'string'));
  }
  return typeof raw === 'string' ? clean([raw]) : [];
}

function clean(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== '');
}
