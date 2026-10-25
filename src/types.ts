/**
 * Pure data contracts for the Gantt model. No Obsidian imports live in this file,
 * so every module that only depends on it can be unit tested in isolation.
 */

/** Vault-relative path of a task note. Used as the identity of a task everywhere. */
export type TaskPath = string;

/**
 * Dependency relation types. These are the iCalendar RELATED-TO relation types that
 * TaskNotes stores and validates natively, so they round-trip without loss.
 */
export type RelType = 'FINISHTOSTART' | 'FINISHTOFINISH' | 'STARTTOSTART' | 'STARTTOFINISH';

export const REL_TYPES: readonly RelType[] = [
  'FINISHTOSTART',
  'FINISHTOFINISH',
  'STARTTOSTART',
  'STARTTOFINISH'
];

export const DEFAULT_REL_TYPE: RelType = 'FINISHTOSTART';

/**
 * A `blockedBy` entry exactly as authored, before link resolution.
 * TaskNotes accepts both a bare `"[[link]]"` string and a `{uid, reltype}` mapping;
 * both normalize into this shape.
 */
export interface RawDependency {
  /** Link text with `[[ ]]` stripped, e.g. `TaskNotes/Tasks/BEL-0001 Draft...`. */
  uid: string;
  reltype: RelType;
  /** ISO-8601 duration for lag (positive) or lead (negative), e.g. `PT4H`, `-P1D`. */
  gap?: string;
}

/** A dependency whose `uid` has been resolved against the vault. */
export interface ResolvedDependency extends RawDependency {
  /** Resolved task path, or null when the link is dangling. */
  path: TaskPath | null;
}

/** A dependency edge between two tasks that both exist in the current data set. */
export interface Edge {
  /** The blocking task (predecessor). */
  from: TaskPath;
  /**
   * The `blockedBy` uid exactly as authored, brackets stripped.
   *
   * Kept alongside the resolved path because TaskNotes matches dependencies on this
   * string, not on the file it resolves to. A vault writes links both as bare names
   * and as full paths, and rarely with a `.md` suffix, so the resolved path is very
   * often not what is stored.
   */
  uid: string;
  /** The blocked task (successor). */
  to: TaskPath;
  reltype: RelType;
  /** Lag in minutes; negative means lead. Resolved from `RawDependency.gap`. */
  gapMinutes: number;
}

/**
 * A date drawn from frontmatter. TaskNotes writes either `YYYY-MM-DD` (all-day) or a
 * full ISO datetime, and the distinction changes how a bar is drawn — an all-day `due`
 * means "end of that working day", not midnight at its start.
 */
export interface TaskDate {
  /** Epoch milliseconds, interpreted in local time for date-only values. */
  ms: number;
  /** True when the source value carried no time component. */
  dateOnly: boolean;
  /** The original frontmatter string, preserved for round-tripping. */
  raw: string;
}

/** A wikilink reference, resolved where possible. */
export interface LinkRef {
  /** Original frontmatter value, e.g. `"[[PRJ-01 Website Relaunch]]"`. */
  raw: string;
  /** Link target with brackets and any `|alias` stripped. */
  target: string;
  /** Resolved vault path, or null when the link points at nothing. */
  path: string | null;
  /** Display alias when the link used `|`. */
  alias?: string;
}

/** A normalized task, the single input shape for every model module. */
export interface GanttTask {
  path: TaskPath;
  title: string;
  status: string;
  priority: string;
  /** True when the task's status is flagged `isCompleted` in the TaskNotes catalog. */
  completed: boolean;
  archived: boolean;
  scheduled: TaskDate | null;
  due: TaskDate | null;
  completedDate: TaskDate | null;
  /** Effort in minutes. Null when absent or blank; 0 is meaningful (a milestone). */
  timeEstimate: number | null;
  /**
   * Minutes recorded against the task in TaskNotes' `timeEntries`.
   *
   * Null when the task has no entries at all, which is every task in the reference
   * vault — distinguishing "none tracked" from "zero tracked" keeps the progress
   * chain from treating an untracked task as one that has had no work done.
   */
  trackedMinutes: number | null;
  projects: LinkRef[];
  contexts: string[];
  tags: string[];
  dependencies: ResolvedDependency[];
  /**
   * Body checkbox counts. The real progress signal in this vault: `timeEntries` is
   * unused, but 113 of 166 tasks carry checklists.
   */
  checklist: { done: number; total: number } | null;
  /** Ratio in [0, 1], or null when no progress signal is available. */
  progress: number | null;
  /** Values of user-defined and non-TaskNotes fields, keyed by frontmatter property. */
  extra: Record<string, unknown>;
  /** TaskNotes' LexoRank manual sort key, when the task carries one. */
  sortOrder: string | null;
}

/** How a bar's extent was arrived at. Drives its visual treatment. */
export type BarKind =
  | 'planned'
  | 'inferred-start'
  | 'inferred-end'
  | 'unplanned'
  | 'milestone'
  | 'invalid';

/**
 * A task's horizontal extent on the timeline.
 *
 * Two extents, deliberately. `startMs`/`endMs` are the true instants, in working time,
 * and every duration and float calculation uses them. `displayStartMs`/`displayEndMs`
 * are snapped out to whole days for drawing, because a task scheduled and due on the
 * same date occupies 09:00-17:00 — 8/24 of a day column — and would otherwise render
 * as an invisible sliver rather than as the one day it is.
 */
export interface Bar {
  path: TaskPath;
  startMs: number;
  endMs: number;
  displayStartMs: number;
  displayEndMs: number;
  kind: BarKind;
  /** Set when `kind` is `invalid`, explaining what is wrong. */
  problem?: string;
}

/** Critical-path results for a single task. */
export interface ScheduleNode {
  path: TaskPath;
  /** Early start / early finish, in epoch milliseconds. */
  es: number;
  ef: number;
  /** Late start / late finish, in epoch milliseconds. */
  ls: number;
  lf: number;
  /** Total float in working minutes. */
  totalFloat: number;
  /** Free float in working minutes. */
  freeFloat: number;
  critical: boolean;
}

/** A set of tasks that depend on each other circularly. */
export interface Cycle {
  members: TaskPath[];
}

export interface ScheduleResult {
  nodes: Map<TaskPath, ScheduleNode>;
  /** Circular dependencies, excluded from the passes above and surfaced to the user. */
  cycles: Cycle[];
  /** Edges dropped because they sat inside a cycle. */
  droppedEdges: Edge[];
  projectStartMs: number;
  projectEndMs: number;
}

/** A status as defined in the user's TaskNotes settings. Never hardcoded. */
export interface StatusDef {
  value: string;
  label: string;
  color: string;
  isCompleted: boolean;
  order: number;
}

/** A priority as defined in the user's TaskNotes settings. Higher weight ranks higher. */
export interface PriorityDef {
  value: string;
  label: string;
  color: string;
  weight: number;
}

/** The subset of TaskNotes' field mapping the Gantt reads. Values are property names. */
export interface FieldMapping {
  title: string;
  status: string;
  priority: string;
  due: string;
  scheduled: string;
  contexts: string;
  projects: string;
  timeEstimate: string;
  completedDate: string;
  timeEntries: string;
  blockedBy: string;
  archiveTag: string;
  sortOrder: string;
  [key: string]: string;
}

/**
 * How TaskNotes decides whether a note is a task. Configurable, and this vault uses
 * the `tag` method with `#task`, so folder-based assumptions would be wrong.
 */
export interface TaskIdentification {
  method: 'tag' | 'property';
  tag: string;
  propertyName: string;
  propertyValue: string;
  /** Folder names TaskNotes excludes from indexing. */
  excludedFolders: string[];
}

/** Everything the Gantt needs to know about the host TaskNotes install. */
export interface TaskNotesCatalog {
  identification: TaskIdentification;
  statuses: StatusDef[];
  priorities: PriorityDef[];
  fieldMapping: FieldMapping;
  /** User-defined fields, e.g. this vault's `initiative`. */
  userFields: { id: string; key: string; displayName: string; type: string }[];
}
