import type { TaskIdentification } from '../types';

/**
 * Whether a note counts as a TaskNotes task.
 *
 * Pure, and shared by both readers. The rule is configurable — the reference vault
 * identifies tasks by the `#task` TAG rather than by folder — so getting it wrong in
 * one reader and right in the other would give the agent and the chart different
 * task lists for the same vault.
 */

/** Normalize a tag for comparison: no leading hash, case-insensitive. */
function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').trim().toLowerCase();
}

/** Frontmatter `tags` accepts a list, a lone scalar, or a comma-separated string. */
export function frontmatterTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string').map(normalizeTag);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(normalizeTag)
      .filter((t) => t !== '');
  }
  return [];
}

/**
 * Inline `#tags` in a note body.
 *
 * Deliberately conservative: a tag must start at a boundary and cannot be part of a
 * URL fragment or a markdown heading, both of which contain a hash without meaning one.
 */
export function inlineTags(body: string): string[] {
  const withoutCode = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const matches = withoutCode.matchAll(/(^|[\s([{])#([A-Za-z0-9_/-]+)/g);
  return [...matches]
    .map((m) => normalizeTag(m[2] ?? ''))
    .filter((t) => t !== '' && !/^\d+$/.test(t));
}

export function isTaskNote(
  notePath: string,
  frontmatter: Record<string, unknown>,
  tags: readonly string[],
  ident: TaskIdentification
): boolean {
  for (const folder of ident.excludedFolders) {
    if (folder !== '' && notePath.split('/').includes(folder)) return false;
  }

  if (ident.method === 'property') {
    const value = frontmatter[ident.propertyName];
    if (value === undefined || value === null) return false;
    return String(value).toLowerCase() === ident.propertyValue.toLowerCase();
  }

  return tags.includes(normalizeTag(ident.tag));
}
