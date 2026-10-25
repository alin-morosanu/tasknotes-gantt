import type {
  GanttTask,
  LinkRef,
  RawDependency,
  RelType,
  ResolvedDependency,
  TaskNotesCatalog
} from '../types';
import { DEFAULT_REL_TYPE, REL_TYPES } from '../types';
import { parseTaskDate } from '../model/dates';

/** A task as it arrives from any adapter, before normalization. */
export interface RawTaskRecord {
  path: string;
  frontmatter: Record<string, unknown>;
  /** Body checkbox counts from the metadata cache, when the adapter can supply them. */
  checklist?: { done: number; total: number };
}

export interface NormalizeContext {
  catalog: TaskNotesCatalog;
  /** Resolve a link target relative to a source note. Returns null when dangling. */
  resolveLink: (target: string, sourcePath: string) => string | null;
}

const WIKILINK = /^\[\[([^\]]+)\]\]$/;
const MARKDOWN_LINK = /^\[([^\]]*)\]\(([^)]+)\)$/;

/** Strip a path down to its display name, used when a task has no `title`. */
export function basename(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}

/**
 * Coerce a frontmatter value to a string array.
 *
 * YAML lists arrive as arrays, a lone value arrives as a scalar, and a blank key
 * (`contexts:`) arrives as null. All three are common in the vault.
 */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : [trimmed];
  }
  return [];
}

/**
 * Parse a link value into its target and alias.
 *
 * Handles the wikilink form TaskNotes writes by default and the markdown form it
 * writes when `useFrontmatterMarkdownLinks` is on. A bare string is treated as a
 * target so that hand-written values are not silently dropped.
 */
export function parseLink(value: string): { target: string; alias?: string } | null {
  const raw = value.trim();
  if (raw === '') return null;

  const wiki = WIKILINK.exec(raw);
  if (wiki?.[1]) {
    const inner = wiki[1];
    const pipe = inner.indexOf('|');
    if (pipe === -1) return { target: inner.trim() };
    return { target: inner.slice(0, pipe).trim(), alias: inner.slice(pipe + 1).trim() };
  }

  const md = MARKDOWN_LINK.exec(raw);
  if (md?.[2]) {
    const target = decodeURIComponent(md[2].trim());
    const alias = md[1]?.trim();
    return alias ? { target, alias } : { target };
  }

  return { target: raw };
}

function resolveLinkRef(
  raw: string,
  sourcePath: string,
  ctx: NormalizeContext
): LinkRef | null {
  const parsed = parseLink(raw);
  if (!parsed) return null;
  const ref: LinkRef = {
    raw,
    target: parsed.target,
    path: ctx.resolveLink(parsed.target, sourcePath)
  };
  if (parsed.alias) ref.alias = parsed.alias;
  return ref;
}

function toRelType(value: unknown): RelType {
  if (typeof value !== 'string') return DEFAULT_REL_TYPE;
  const upper = value.trim().toUpperCase().replace(/[-_\s]/g, '');
  return (REL_TYPES as readonly string[]).includes(upper)
    ? (upper as RelType)
    : DEFAULT_REL_TYPE;
}

/**
 * Normalize a single `blockedBy` entry.
 *
 * The vault contains both authored shapes side by side: BEL-0003 uses a bare list of
 * `"[[link]]"` strings, BEL-0002 uses `{uid, reltype}` mappings. TaskNotes accepts
 * both, so both must survive a round trip through the Gantt.
 */
export function normalizeDependency(entry: unknown): RawDependency | null {
  if (typeof entry === 'string') {
    const parsed = parseLink(entry);
    if (!parsed) return null;
    return { uid: parsed.target, reltype: DEFAULT_REL_TYPE };
  }
  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>;
    const uidValue = record['uid'] ?? record['id'] ?? record['task'];
    if (typeof uidValue !== 'string') return null;
    const parsed = parseLink(uidValue);
    if (!parsed) return null;
    const dep: RawDependency = { uid: parsed.target, reltype: toRelType(record['reltype']) };
    const gap = record['gap'];
    if (typeof gap === 'string' && gap.trim() !== '') dep.gap = gap.trim();
    return dep;
  }
  return null;
}

/**
 * Sum the minutes recorded in a `timeEntries` array.
 *
 * Entries carry an explicit `duration` when TaskNotes has computed one, and otherwise
 * a start and end. An entry with no `endTime` is a running session and contributes
 * nothing, since its duration is not yet known.
 */
export function sumTimeEntries(value: unknown): number | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let total = 0;
  let counted = 0;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const duration = record['duration'];
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      total += duration;
      counted += 1;
      continue;
    }
    const start = parseTaskDate(record['startTime']);
    const end = parseTaskDate(record['endTime']);
    if (start === null || end === null || end.ms < start.ms) continue;
    total += (end.ms - start.ms) / 60_000;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

/** Coerce a numeric frontmatter value, preserving a meaningful 0 and rejecting blanks. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Turn a raw task record into the normalized shape every model module consumes.
 *
 * Property names come from the TaskNotes field mapping in `ctx.catalog`, never from
 * literals, because the mapping is user-configurable.
 */
export function normalizeTask(record: RawTaskRecord, ctx: NormalizeContext): GanttTask {
  const fm = record.frontmatter;
  const map = ctx.catalog.fieldMapping;

  const titleValue = fm[map.title];
  const title =
    typeof titleValue === 'string' && titleValue.trim() !== ''
      ? titleValue.trim()
      : basename(record.path);

  const status = typeof fm[map.status] === 'string' ? (fm[map.status] as string) : '';
  const priority = typeof fm[map.priority] === 'string' ? (fm[map.priority] as string) : '';
  const statusDef = ctx.catalog.statuses.find((s) => s.value === status);

  const tags = toStringArray(fm['tags']);

  const projects = toStringArray(fm[map.projects])
    .map((raw) => resolveLinkRef(raw, record.path, ctx))
    .filter((ref): ref is LinkRef => ref !== null);

  const dependencyValue = fm[map.blockedBy];
  const dependencies: ResolvedDependency[] = (
    Array.isArray(dependencyValue) ? dependencyValue : toStringArray(dependencyValue)
  )
    .map(normalizeDependency)
    .filter((dep): dep is RawDependency => dep !== null)
    .map((dep) => ({ ...dep, path: ctx.resolveLink(dep.uid, record.path) }));

  const known = new Set<string>([
    ...Object.values(map),
    'tags',
    'position',
    ctx.catalog.fieldMapping.archiveTag
  ]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!known.has(key)) extra[key] = value;
  }

  const sortOrderValue = fm[map.sortOrder];

  return {
    path: record.path,
    title,
    status,
    priority,
    // `isCompleted` on the status definition is the only correct completion signal;
    // the literal "done" is this vault's convention, not TaskNotes' contract.
    completed: statusDef?.isCompleted ?? false,
    // TaskNotes models the archive as a TAG, not a boolean property.
    archived: tags.includes(map.archiveTag),
    scheduled: parseTaskDate(fm[map.scheduled]),
    due: parseTaskDate(fm[map.due]),
    completedDate: parseTaskDate(fm[map.completedDate]),
    timeEstimate: toNumber(fm[map.timeEstimate]),
    trackedMinutes: sumTimeEntries(fm[map.timeEntries]),
    projects,
    contexts: toStringArray(fm[map.contexts]),
    tags,
    dependencies,
    checklist: record.checklist ?? null,
    progress: null,
    extra,
    sortOrder: typeof sortOrderValue === 'string' ? sortOrderValue : null
  };
}
