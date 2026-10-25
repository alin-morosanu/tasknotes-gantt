import type {
  FieldMapping,
  PriorityDef,
  StatusDef,
  TaskIdentification,
  TaskNotesCatalog
} from '../types';

/**
 * TaskNotes' shipped default field mapping, used only as a last resort when neither
 * the runtime API nor the plugin's `data.json` can be read. The user's mapping is
 * configurable, so this is a floor, not an assumption.
 */
export const DEFAULT_FIELD_MAPPING: FieldMapping = {
  title: 'title',
  status: 'status',
  priority: 'priority',
  due: 'due',
  scheduled: 'scheduled',
  contexts: 'contexts',
  projects: 'projects',
  timeEstimate: 'timeEstimate',
  completedDate: 'completedDate',
  dateCreated: 'dateCreated',
  dateModified: 'dateModified',
  recurrence: 'recurrence',
  timeEntries: 'timeEntries',
  blockedBy: 'blockedBy',
  archiveTag: 'archived',
  sortOrder: 'tasknotes_manual_order'
};

/** TaskNotes' shipped default statuses. Most vaults replace these entirely. */
export const DEFAULT_STATUSES: StatusDef[] = [
  { value: 'none', label: 'None', color: '#cccccc', isCompleted: false, order: 0 },
  { value: 'open', label: 'Open', color: '#808080', isCompleted: false, order: 1 },
  { value: 'in-progress', label: 'In Progress', color: '#0066cc', isCompleted: false, order: 2 },
  { value: 'done', label: 'Done', color: '#00aa00', isCompleted: true, order: 3 }
];

export const DEFAULT_IDENTIFICATION: TaskIdentification = {
  method: 'tag',
  tag: 'task',
  propertyName: 'isTask',
  propertyValue: 'true',
  excludedFolders: []
};

export const DEFAULT_PRIORITIES: PriorityDef[] = [
  { value: 'none', label: 'None', color: '#cccccc', weight: 0 },
  { value: 'low', label: 'Low', color: '#00aa00', weight: 1 },
  { value: 'normal', label: 'Normal', color: '#ffaa00', weight: 2 },
  { value: 'high', label: 'High', color: '#ff0000', weight: 3 }
];

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Coerce one raw status definition, tolerating the shape drift between versions. */
export function parseStatus(raw: unknown, index: number): StatusDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const value = r['value'];
  if (typeof value !== 'string' || value === '') return null;
  return {
    value,
    label: str(r['label'], value),
    color: str(r['color'], '#888888'),
    // 4.x writes both `isCompleted` and a legacy `completed`; either may be present.
    isCompleted: r['isCompleted'] === true || r['completed'] === true,
    order: num(r['order'], index)
  };
}

export function parsePriority(raw: unknown, index: number): PriorityDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const value = r['value'];
  if (typeof value !== 'string' || value === '') return null;
  return {
    value,
    label: str(r['label'], value),
    color: str(r['color'], '#888888'),
    weight: num(r['weight'], index)
  };
}

export function parseUserFields(raw: unknown): TaskNotesCatalog['userFields'] {
  if (!Array.isArray(raw)) return [];
  const fields: TaskNotesCatalog['userFields'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const key = r['key'];
    if (typeof key !== 'string' || key === '') continue;
    fields.push({
      id: str(r['id'], key),
      key,
      displayName: str(r['displayName'], key),
      type: str(r['type'], 'text')
    });
  }
  return fields;
}

/**
 * Read the task-identification rules.
 *
 * The API nests these under `taskIdentification`, while `data.json` keeps them as flat
 * top-level keys, so both layouts are accepted.
 */
export function parseIdentification(input: Record<string, unknown>): TaskIdentification {
  const nested = input['taskIdentification'];
  const src = (typeof nested === 'object' && nested !== null ? nested : input) as Record<
    string,
    unknown
  >;
  const method = src['method'] ?? input['taskIdentificationMethod'];
  const excluded = input['excludedFolders'];

  return {
    method: method === 'property' ? 'property' : 'tag',
    tag: str(src['tag'] ?? input['taskTag'], DEFAULT_IDENTIFICATION.tag),
    propertyName: str(
      src['propertyName'] ?? input['taskPropertyName'],
      DEFAULT_IDENTIFICATION.propertyName
    ),
    propertyValue: str(
      src['propertyValue'] ?? input['taskPropertyValue'],
      DEFAULT_IDENTIFICATION.propertyValue
    ),
    excludedFolders:
      typeof excluded === 'string'
        ? excluded
            .split(',')
            .map((f) => f.trim())
            .filter((f) => f !== '')
        : []
  };
}

export function parseFieldMapping(raw: unknown): FieldMapping {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_FIELD_MAPPING };
  const mapping: FieldMapping = { ...DEFAULT_FIELD_MAPPING };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') mapping[key] = value;
  }
  return mapping;
}

/**
 * Build a catalog from raw settings-shaped input.
 *
 * Accepts either the API's `catalog.*` output or the raw `data.json` of the TaskNotes
 * plugin, since the two carry the same definitions under different key names.
 */
export function buildCatalog(input: {
  statuses?: unknown;
  priorities?: unknown;
  fieldMapping?: unknown;
  userFields?: unknown;
  settings?: Record<string, unknown>;
}): TaskNotesCatalog {
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.map(parseStatus).filter((s): s is StatusDef => s !== null)
    : [];
  const priorities = Array.isArray(input.priorities)
    ? input.priorities.map(parsePriority).filter((p): p is PriorityDef => p !== null)
    : [];

  return {
    identification: parseIdentification(input.settings ?? {}),
    statuses: statuses.length > 0 ? statuses.sort((a, b) => a.order - b.order) : DEFAULT_STATUSES,
    priorities: priorities.length > 0 ? priorities : DEFAULT_PRIORITIES,
    fieldMapping: parseFieldMapping(input.fieldMapping),
    userFields: parseUserFields(input.userFields)
  };
}
