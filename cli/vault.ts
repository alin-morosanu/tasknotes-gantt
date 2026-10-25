import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GanttTask, TaskNotesCatalog } from '../src/types';
import { buildCatalog } from '../src/bridge/catalog';
import { normalizeTask, type NormalizeContext, type RawTaskRecord } from '../src/data/normalize';
import { isTaskNote } from './identify';
import { DEFAULT_SETTINGS, mergeSettings, type GanttSettings } from '../src/settings/defaults';

/**
 * Reads an Obsidian vault from disk.
 *
 * The counterpart to `src/data/adapter-vault.ts`, which reads the same vault through
 * Obsidian's metadata cache. Both hand the identical raw records to `normalizeTask`,
 * so the agent's view of a task and the chart's view are the same object — a parity
 * test over the shared fixtures holds them to that.
 */

const TASKNOTES_DATA = '.obsidian/plugins/tasknotes/data.json';
const GANTT_DATA = '.obsidian/plugins/tasknotes-gantt/data.json';

export interface VaultData {
  vaultPath: string;
  catalog: TaskNotesCatalog;
  settings: GanttSettings;
  tasks: GanttTask[];
  /** Files that looked like tasks but could not be parsed, with the reason. */
  unreadable: { path: string; error: string }[];
}

/** Walk up from a directory looking for a vault root. */
export function findVault(from: string): string | null {
  let current = path.resolve(from);
  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(path.join(current, '.obsidian'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Split a note into its frontmatter block and body. */
export function splitNote(text: string): { frontmatter: string | null; body: string } {
  // Only a block at the very start of the file counts, and `---` must be alone on its
  // line: a horizontal rule further down the note is not frontmatter.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1] ?? '', body: text.slice(match[0].length) };
}

/**
 * Parse a frontmatter block.
 *
 * Obsidian is tolerant of YAML it cannot fully parse, and so is this: a malformed
 * block yields an empty record rather than aborting the read, so one bad note does
 * not hide the other hundred and sixty.
 */
export function parseFrontmatter(block: string | null): Record<string, unknown> {
  if (block === null || block.trim() === '') return {};
  try {
    // Silent: a vault contains template notes with unrendered placeholders like
    // `date: {{date:DD-MM-YYYY}}`, which YAML reads as a nested map and warns about.
    // Those notes are not tasks, and a warning about one has no business appearing in
    // output an agent is reading.
    const parsed = parseYaml(block, { logLevel: 'silent' });
    // An array is also an object, and YAML recovers from malformed input by producing
    // one — `- [}` parses to `[[]]`. Handed downstream as frontmatter it would break
    // every field lookup after it, silently.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Count body checkboxes, matching what Obsidian's metadata cache reports. */
export function countChecklist(body: string): { done: number; total: number } {
  const items = [...body.matchAll(/^[ \t]*[-*+]\s+\[(.)\]/gm)];
  return {
    done: items.filter((m) => (m[1] ?? ' ') !== ' ').length,
    total: items.length
  };
}

/** Every markdown file in the vault, excluding Obsidian's own directory. */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Resolve a link the way Obsidian's `getFirstLinkpathDest` does.
 *
 * Obsidian matches a link to the shortest unambiguous path, so a bare `BEL-0001`
 * resolves to `TaskNotes/Tasks/BEL-0001….md`. Half the links in the reference vault
 * are bare and half are full paths, so both must work.
 */
export function makeResolver(relativePaths: readonly string[]): (target: string) => string | null {
  const exact = new Set(relativePaths);
  const byName = new Map<string, string[]>();

  for (const p of relativePaths) {
    const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const list = byName.get(name.toLowerCase());
    if (list) list.push(p);
    else byName.set(name.toLowerCase(), [p]);
  }

  return (target: string) => {
    const clean = target.replace(/\\/g, '/').trim();
    if (clean === '') return null;

    const withExt = clean.endsWith('.md') ? clean : `${clean}.md`;
    if (exact.has(withExt)) return withExt;
    if (exact.has(clean)) return clean;

    const name = withExt.slice(withExt.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const matches = byName.get(name.toLowerCase());
    if (!matches || matches.length === 0) return null;
    // Obsidian prefers the shortest path when a name is ambiguous.
    return [...matches].sort((a, b) => a.length - b.length)[0] ?? null;
  };
}

/** Read a vault: settings, catalog and every task note. */
export function readVault(vaultPath: string): VaultData {
  const root = path.resolve(vaultPath);
  if (!fs.existsSync(path.join(root, '.obsidian'))) {
    throw new Error(`Not an Obsidian vault (no .obsidian directory): ${root}`);
  }

  const taskNotesData = readJson(path.join(root, TASKNOTES_DATA));
  if (taskNotesData === null) {
    throw new Error(
      `TaskNotes settings not found at ${TASKNOTES_DATA}. Is TaskNotes installed in this vault?`
    );
  }

  const catalog = buildCatalog({
    statuses: taskNotesData['customStatuses'],
    priorities: taskNotesData['customPriorities'],
    userFields: taskNotesData['userFields'],
    fieldMapping: taskNotesData['fieldMapping'],
    settings: taskNotesData
  });

  // The plugin's own settings, so the agent reasons with the user's working calendar
  // and capacity rather than defaults.
  const ganttData = readJson(path.join(root, GANTT_DATA));
  const settings = ganttData === null ? { ...DEFAULT_SETTINGS } : mergeSettings(ganttData);

  const absolute = markdownFiles(root);
  const relative = absolute.map((p) => path.relative(root, p).split(path.sep).join('/'));
  const resolve = makeResolver(relative);
  const context: NormalizeContext = { catalog, resolveLink: (target) => resolve(target) };

  const tasks: GanttTask[] = [];
  const unreadable: VaultData['unreadable'] = [];

  for (let i = 0; i < absolute.length; i += 1) {
    const file = absolute[i];
    const rel = relative[i];
    if (file === undefined || rel === undefined) continue;

    try {
      const text = fs.readFileSync(file, 'utf8');
      const { frontmatter, body } = splitNote(text);
      const parsed = parseFrontmatter(frontmatter);
      if (!isTaskNote(rel, parsed, body, catalog.identification)) continue;

      const record: RawTaskRecord = {
        path: rel,
        frontmatter: parsed,
        checklist: countChecklist(body)
      };
      tasks.push(normalizeTask(record, context));
    } catch (error) {
      unreadable.push({
        path: rel,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { vaultPath: root, catalog, settings, tasks, unreadable };
}
