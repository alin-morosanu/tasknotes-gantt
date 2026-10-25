import type { TaskNotesCatalog } from '../../src/types';
import { DEFAULT_FIELD_MAPPING, DEFAULT_IDENTIFICATION } from '../../src/bridge/catalog';
import type { RawTaskRecord } from '../../src/data/normalize';

/**
 * Fixtures drawn from the real vault at a real working vault.
 *
 * Each one exists to pin down a shape that actually occurs in the wild, so the
 * normalizer is tested against the data it will really meet rather than an idealized
 * version of it. Titles and bodies are trimmed; frontmatter is verbatim in shape.
 */

/** The user's real catalog: custom statuses, not TaskNotes' shipped defaults. */
export const CATALOG: TaskNotesCatalog = {
  identification: { ...DEFAULT_IDENTIFICATION, excludedFolders: ['templates', 'archive'] },
  statuses: [
    { value: 'backlog', label: 'Backlog', color: '#808080', isCompleted: false, order: 0 },
    { value: 'up-next', label: 'Up Next', color: '#6366f1', isCompleted: false, order: 1 },
    { value: 'in-progress', label: 'In Progress', color: '#0066cc', isCompleted: false, order: 2 },
    { value: 'on-hold', label: 'On Hold', color: '#6366f1', isCompleted: false, order: 3 },
    { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true, order: 4 },
    { value: 'delegate', label: 'Delegate', color: '#6366f1', isCompleted: false, order: 5 }
  ],
  priorities: [
    { value: 'none', label: 'None', color: '#cccccc', weight: 0 },
    { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
    { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
    { value: 'high', label: 'High', color: '#ff0000', weight: 3 }
  ],
  fieldMapping: { ...DEFAULT_FIELD_MAPPING },
  userFields: [
    { id: 'field_1775508443138', key: 'initiative', displayName: 'Initiative', type: 'text' }
  ]
};

const TASKS = 'TaskNotes/Tasks';

/** Dependencies as `{uid, reltype}` objects — BEL-0002's shape. */
export const OBJECT_DEPS: RawTaskRecord = {
  path: `${TASKS}/BEL-0002 Build page templates in the CMS.md`,
  frontmatter: {
    title: 'BEL-0002: Build page templates in the CMS',
    status: 'in-progress',
    priority: 'high',
    scheduled: '2026-04-14',
    due: '2026-04-15',
    dateCreated: '2026-04-07T18:00:00.000+01:00',
    tags: ['task'],
    contexts: ['business'],
    projects: ['[[PRJ-01 Website Relaunch]]'],
    initiative: 'Company Growth',
    timeEstimate: 180,
    blockedBy: [
      {
        uid: '[[TaskNotes/Tasks/BEL-0001 Draft homepage copy for review]]',
        reltype: 'FINISHTOSTART'
      }
    ],
    tasknotes_manual_order: '0|hzzzzz:'
  }
};

/** Dependencies as bare wikilink strings — BEL-0003's shape, in the same vault. */
export const STRING_DEPS: RawTaskRecord = {
  path: `${TASKS}/BEL-0003 Test the full site end-to-end.md`,
  frontmatter: {
    title: 'BEL-0003: Test the full site end-to-end',
    status: 'backlog',
    priority: 'high',
    scheduled: '2026-04-15',
    due: '2026-04-16',
    tags: ['task'],
    contexts: ['business'],
    projects: ['[[PRJ-01 Website Relaunch]]'],
    timeEstimate: 60,
    blockedBy: [
      '[[TaskNotes/Tasks/BEL-0002 Build page templates in the CMS]]',
      '[[TaskNotes/Tasks/BEL-0004 Migrate archive pages into the CMS]]'
    ]
  },
  checklist: { done: 0, total: 9 }
};

/** Blank frontmatter values and dangling project links — TASK-0610's shape. */
export const BLANK_VALUES: RawTaskRecord = {
  path: `${TASKS}/TASK-0610 Side Project Neighbourhood Directory - Phase 1.md`,
  frontmatter: {
    title: 'TASK-0610: Side Project: Neighbourhood Directory - Phase 1',
    status: 'in-progress',
    priority: 'high',
    scheduled: '',
    due: null,
    tags: ['task', 'side-project'],
    contexts: ['business', 'learning'],
    projects: ['[[Side Project]]', '[[Neighbourhood Directory]]'],
    initiative: '',
    timeEstimate: '',
    blockedBy: []
  }
};

/** Due but no scheduled, and no `title` key at all — every BOA-* task's shape. */
export const DUE_ONLY_NO_TITLE: RawTaskRecord = {
  path: `${TASKS}/BOA-0002 Build one-page moving checklist.md`,
  frontmatter: {
    status: 'backlog',
    priority: 'high',
    scheduled: '',
    due: '2026-08-21',
    tags: ['task'],
    contexts: ['business', 'new-business'],
    projects: ['[[BOA-01 Office Move]]'],
    timeEstimate: 120,
    blockedBy: []
  }
};

/** A completed task, plus the vault's non-TaskNotes `assignee` field. */
export const COMPLETED: RawTaskRecord = {
  path: `${TASKS}/BEL-0005 Upload brand assets to the shared drive.md`,
  frontmatter: {
    title: 'BEL-0005: Upload brand assets to the shared drive',
    status: 'done',
    priority: 'normal',
    scheduled: '2026-04-13',
    due: '2026-04-14',
    tags: ['task'],
    contexts: ['business'],
    projects: ['[[PRJ-01 Website Relaunch]]'],
    assignee: 'Avery',
    timeEstimate: 30,
    completedDate: '2026-04-11'
  },
  checklist: { done: 5, total: 5 }
};

/** A zero-estimate task, which the geometry pass treats as a milestone. */
export const MILESTONE: RawTaskRecord = {
  path: `${TASKS}/TLS-0009 Ship skills ladder.md`,
  frontmatter: {
    title: 'TLS-0009: Ship skills ladder',
    status: 'backlog',
    priority: 'high',
    due: '2026-06-30',
    tags: ['task'],
    projects: ['[[PRJ-TL-01 Team Skills Development]]'],
    assignee: 'Team',
    timeEstimate: 0
  }
};

/** A datetime-valued `due` and an archive tag, from the bakery test vault. */
export const DATETIME_AND_ARCHIVED: RawTaskRecord = {
  path: `${TASKS}/testing.md`,
  frontmatter: {
    status: 'open',
    priority: 'normal',
    scheduled: '2025-11-10',
    due: '2025-11-10T13:38',
    tags: ['task', 'archived'],
    recurrence: 'DTSTART:20251110;FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
  }
};

export const ALL_RECORDS: RawTaskRecord[] = [
  OBJECT_DEPS,
  STRING_DEPS,
  BLANK_VALUES,
  DUE_ONLY_NO_TITLE,
  COMPLETED,
  MILESTONE,
  DATETIME_AND_ARCHIVED
];

/**
 * A link resolver standing in for Obsidian's metadata cache.
 *
 * It resolves short and full-path forms alike (both appear in the vault) and returns
 * null for the project links that genuinely dangle, so tests exercise that path.
 */
export function makeResolver(knownPaths: string[]): (target: string) => string | null {
  const byPath = new Set(knownPaths);
  const byName = new Map<string, string>();
  for (const path of knownPaths) {
    const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
    byName.set(name, path);
  }
  return (target: string) => {
    const withExt = target.endsWith('.md') ? target : `${target}.md`;
    if (byPath.has(withExt)) return withExt;
    if (byPath.has(target)) return target;
    return byName.get(target) ?? null;
  };
}

export const KNOWN_PATHS = [
  `${TASKS}/BEL-0001 Draft homepage copy for review.md`,
  OBJECT_DEPS.path,
  STRING_DEPS.path,
  `${TASKS}/BEL-0004 Migrate archive pages into the CMS.md`,
  BLANK_VALUES.path,
  DUE_ONLY_NO_TITLE.path,
  COMPLETED.path,
  MILESTONE.path,
  DATETIME_AND_ARCHIVED.path,
  'TaskNotes/Projects/PRJ-01 Website Relaunch.md',
  'TaskNotes/Projects/BOA-01 Office Move.md',
  'TaskNotes/Projects/PRJ-TL-01 Team Skills Development.md'
];
