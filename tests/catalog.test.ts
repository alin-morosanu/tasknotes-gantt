import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  DEFAULT_FIELD_MAPPING,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  parseFieldMapping,
  parseIdentification,
  parsePriority,
  parseStatus,
  parseUserFields
} from '../src/bridge/catalog';

describe('parseStatus', () => {
  it('reads the shape TaskNotes writes for a custom status', () => {
    expect(
      parseStatus(
        {
          id: 'status_1788113576289',
          value: 'up-next',
          label: 'Up Next',
          color: '#6366f1',
          isCompleted: false,
          order: 1
        },
        0
      )
    ).toEqual({
      value: 'up-next',
      label: 'Up Next',
      color: '#6366f1',
      isCompleted: false,
      order: 1
    });
  });

  it('accepts the legacy `completed` key alongside `isCompleted`', () => {
    expect(parseStatus({ value: 'done', completed: true }, 0)?.isCompleted).toBe(true);
    expect(parseStatus({ value: 'done', isCompleted: true }, 0)?.isCompleted).toBe(true);
    expect(parseStatus({ value: 'open' }, 0)?.isCompleted).toBe(false);
  });

  it('falls back to the value and index when label and order are absent', () => {
    const parsed = parseStatus({ value: 'backlog' }, 3);
    expect(parsed?.label).toBe('backlog');
    expect(parsed?.order).toBe(3);
  });

  it('rejects entries with no usable value', () => {
    expect(parseStatus({ label: 'No value' }, 0)).toBeNull();
    expect(parseStatus(null, 0)).toBeNull();
    expect(parseStatus('done', 0)).toBeNull();
  });
});

describe('parsePriority', () => {
  it('keeps the weight, which is what ranks priorities', () => {
    expect(parsePriority({ value: 'high', label: 'High', color: '#ff0000', weight: 3 }, 0)).toEqual(
      { value: 'high', label: 'High', color: '#ff0000', weight: 3 }
    );
  });

  it('keeps a zero weight rather than treating it as missing', () => {
    expect(parsePriority({ value: 'none', weight: 0 }, 5)?.weight).toBe(0);
  });
});

describe('parseFieldMapping', () => {
  it('overlays user renames onto the defaults', () => {
    const mapping = parseFieldMapping({ due: 'deadline', timeEstimate: 'effort' });
    expect(mapping.due).toBe('deadline');
    expect(mapping.timeEstimate).toBe('effort');
    // Untouched keys keep their defaults.
    expect(mapping.blockedBy).toBe('blockedBy');
    expect(mapping.sortOrder).toBe('tasknotes_manual_order');
  });

  it('ignores blank renames instead of mapping a field to nothing', () => {
    expect(parseFieldMapping({ due: '', scheduled: '  ' }).due).toBe('due');
  });

  it('returns the defaults for unusable input', () => {
    expect(parseFieldMapping(null)).toEqual(DEFAULT_FIELD_MAPPING);
    expect(parseFieldMapping('nonsense')).toEqual(DEFAULT_FIELD_MAPPING);
  });
});

describe('parseIdentification', () => {
  it('reads the flat keys used by data.json', () => {
    expect(
      parseIdentification({
        taskIdentificationMethod: 'tag',
        taskTag: 'task',
        excludedFolders: 'templates, archive, root'
      })
    ).toEqual({
      method: 'tag',
      tag: 'task',
      propertyName: 'isTask',
      propertyValue: 'true',
      excludedFolders: ['templates', 'archive', 'root']
    });
  });

  it('reads the nested shape used by the runtime API', () => {
    const ident = parseIdentification({
      taskIdentification: { method: 'property', propertyName: 'isTask', propertyValue: 'yes' }
    });
    expect(ident.method).toBe('property');
    expect(ident.propertyValue).toBe('yes');
  });

  it('defaults to tag identification for anything unrecognized', () => {
    expect(parseIdentification({}).method).toBe('tag');
    expect(parseIdentification({ taskIdentificationMethod: 'folder' }).method).toBe('tag');
  });
});

describe('parseUserFields', () => {
  it('reads the vault’s `initiative` field definition', () => {
    expect(
      parseUserFields([
        {
          id: 'field_1775508443138',
          displayName: 'Initiative',
          key: 'initiative',
          type: 'text'
        }
      ])
    ).toEqual([
      { id: 'field_1775508443138', key: 'initiative', displayName: 'Initiative', type: 'text' }
    ]);
  });

  it('skips entries with no key', () => {
    expect(parseUserFields([{ displayName: 'Broken' }, null, 'x'])).toEqual([]);
  });
});

describe('buildCatalog', () => {
  it('falls back to shipped defaults when a vault defines nothing', () => {
    const catalog = buildCatalog({});
    expect(catalog.statuses).toEqual(DEFAULT_STATUSES);
    expect(catalog.priorities).toEqual(DEFAULT_PRIORITIES);
    expect(catalog.identification.tag).toBe('task');
  });

  it('sorts statuses by their configured order', () => {
    const catalog = buildCatalog({
      statuses: [
        { value: 'done', order: 4, isCompleted: true },
        { value: 'backlog', order: 0 },
        { value: 'in-progress', order: 2 }
      ]
    });
    expect(catalog.statuses.map((s) => s.value)).toEqual(['backlog', 'in-progress', 'done']);
  });

  it('drops unusable entries but keeps the rest rather than falling back wholesale', () => {
    const catalog = buildCatalog({ statuses: [{ value: 'backlog' }, null, { label: 'x' }] });
    expect(catalog.statuses.map((s) => s.value)).toEqual(['backlog']);
  });
});
