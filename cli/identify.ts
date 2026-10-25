import type { TaskIdentification } from '../src/types';
import {
  frontmatterTags,
  inlineTags,
  isTaskNote as matchesIdentification
} from '../src/data/identify';

/**
 * The task-identification rule, applied to a note read from disk.
 *
 * Obsidian's metadata cache has already located inline tags for the plugin's reader;
 * here they have to be found in the body text, which is the only difference between
 * the two paths.
 */
export function isTaskNote(
  notePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  ident: TaskIdentification
): boolean {
  const tags = new Set([...frontmatterTags(frontmatter['tags']), ...inlineTags(body)]);
  return matchesIdentification(notePath, frontmatter, [...tags], ident);
}
