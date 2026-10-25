import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG } from './tasks';

/**
 * A real vault on disk, for tests that have to go through the file layer.
 *
 * Shared by the writer tests and the MCP tests: both need the headless reader to see
 * a genuine `.obsidian/plugins/tasknotes/data.json`, and neither should be inventing
 * its own idea of what a task note looks like.
 */

/** A note in the shape TaskNotes writes: a blank value is a bare key, not `key: `. */
export function note(id: string, body: Record<string, string>): string {
  const lines = Object.entries(body).map(([k, v]) => (v === '' ? `${k}:` : `${k}: ${v}`));
  return [
    '---',
    `title: "${id}: Something"`,
    ...lines,
    'tags:',
    '  - task',
    '---',
    '',
    '## What needs doing',
    'Something.',
    '',
    '- [ ] not done',
    ''
  ].join('\n');
}

const created: string[] = [];

export function scratchVault(notes: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tng-vault-'));
  created.push(root);
  fs.mkdirSync(path.join(root, '.obsidian/plugins/tasknotes'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.obsidian/plugins/tasknotes/data.json'),
    JSON.stringify({ customStatuses: CATALOG.statuses, customPriorities: CATALOG.priorities })
  );
  fs.mkdirSync(path.join(root, 'TaskNotes/Tasks'), { recursive: true });
  for (const [name, text] of Object.entries(notes)) {
    fs.writeFileSync(path.join(root, 'TaskNotes/Tasks', name), text);
  }
  return root;
}

/** Every note in the vault, so a byte comparison can cover all of them. */
export function readAll(root: string): Record<string, string> {
  const dir = path.join(root, 'TaskNotes/Tasks');
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

/** Call from `afterEach`. */
export function removeScratchVaults(): void {
  for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
