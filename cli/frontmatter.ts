/**
 * Surgical edits to a note's frontmatter.
 *
 * Only the keys named are touched. Everything else — key order, quoting, comments,
 * blank lines, the body — is left exactly as it was found, because a whole-block
 * rewrite would reorder every task's YAML and turn a two-line change into an
 * unreadable diff across a hundred and sixty notes.
 *
 * This is the line-level counterpart to Obsidian's `processFrontMatter`, which the
 * plugin uses inside the app. The CLI runs outside Obsidian and so must do it itself.
 */

export type YamlScalar = string | number | boolean;
export type YamlItem = YamlScalar | Record<string, YamlScalar>;

/**
 * A value to write. `null` — and an empty array — CLEAR the key.
 *
 * Clearing blanks the value and keeps the key where the note already has it, and does
 * nothing where it does not. That is how TaskNotes itself writes an empty date: the
 * reference vault is full of notes carrying a bare `scheduled:`.
 *
 * This is one of two rules that could be chosen, and it is chosen deliberately.
 * Neither is right in every case, because by the time a clear is applied the file no
 * longer records whether the key was blank before the change or created by it:
 *
 *   - blanking loses nothing when the key was already there and empty, and leaves an
 *     empty line behind when the change itself created the key;
 *   - deleting does the reverse, and destroys a blank key the author had.
 *
 * Blanking loses less on a real vault, where blank `scheduled:` and `due:` keys are
 * common and keys created by a change are not. An empty line reads back as absent, so
 * the difference is cosmetic either way — but only one of the two can lose a line the
 * author wrote, and it is not this one.
 */
export type FrontmatterValue = YamlScalar | null | readonly YamlItem[];

export interface KeyEdit {
  key: string;
  value: FrontmatterValue;
}

/** A top-level key and the lines it occupies. `end` is exclusive. */
interface Span {
  key: string;
  start: number;
  end: number;
}

// A key at indentation zero. Anything indented, or starting a list item or comment,
// belongs to the key above it — including the contents of a block scalar.
const TOP_LEVEL_KEY = /^([A-Za-z0-9_$][^:#]*?)\s*:(?:\s|$)/;

function topLevelSpans(lines: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const [i, line] of lines.entries()) {
    const match = TOP_LEVEL_KEY.exec(line);
    if (!match?.[1]) continue;
    const previous = spans[spans.length - 1];
    if (previous) previous.end = i;
    spans.push({ key: match[1].trim(), start: i, end: lines.length });
  }
  // Blank lines between keys belong to neither; leaving them inside a span would mean
  // replacing a key silently deleted the separator above the next one.
  for (const span of spans) {
    while (span.end > span.start + 1 && (lines[span.end - 1] ?? '').trim() === '') {
      span.end -= 1;
    }
  }
  return spans;
}

/**
 * Whether a plain scalar would be read back as something other than the string given.
 *
 * Erring towards quoting is safe; erring against it silently changes a value's type.
 */
function needsQuotes(value: string): boolean {
  if (value === '') return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/:\s/.test(value) || value.endsWith(':')) return true;
  if (value.includes(' #')) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  // A string that looks like a number must be quoted, or it comes back as one.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return true;
  return false;
}

 
const CONTROL = /[\u0000-\u001f\u007f]/;

function renderScalar(value: YamlScalar, preferQuotes = false): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A raw line break in a value would end the line, and `\n---\n` would end the whole
  // frontmatter block — so a single string could rewrite other keys or inject text into
  // the note body. Control characters are always escaped inside double quotes.
  if (!preferQuotes && !CONTROL.test(value) && !needsQuotes(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
     
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * A key is written verbatim at the start of a line, so it is the one thing that cannot
 * be escaped — only refused. A newline in it starts a second key of the caller's
 * choosing; `- ` or `#` turns the line into a list item or a comment.
 */
function assertSafeKey(key: string): void {
  if (key === '' || CONTROL.test(key) || /^[-#?&*!|>'"%@`\s]/.test(key) || /:(\s|$)/.test(key)) {
    throw new Error(`Refusing to write a frontmatter key that is not a plain name: ${JSON.stringify(key)}`);
  }
}

/** The quoting style of a value already in the file, so a replacement keeps it. */
function wasQuoted(line: string | undefined): boolean {
  if (line === undefined) return false;
  const colon = line.indexOf(':');
  if (colon === -1) return false;
  const value = line.slice(colon + 1).trim();
  return value.startsWith('"') || value.startsWith("'");
}

/** The indentation an existing block sequence uses, so a rewrite matches it. */
function listIndent(lines: readonly string[], span: Span | undefined): string {
  if (span === undefined) return '  ';
  for (let i = span.start + 1; i < span.end; i += 1) {
    const match = /^(\s+)-\s/.exec(lines[i] ?? '');
    if (match?.[1]) return match[1];
  }
  return '  ';
}

function renderList(key: string, items: readonly YamlItem[], indent: string): string[] {
  const out = [`${key}:`];
  for (const item of items) {
    if (typeof item === 'object') {
      const entries = Object.entries(item);
      const first = entries[0];
      if (first === undefined) continue;
      out.push(`${indent}- ${first[0]}: ${renderScalar(first[1])}`);
      for (const [k, v] of entries.slice(1)) {
        // Continuation keys line up under the first, past the "- ".
        out.push(`${indent}  ${k}: ${renderScalar(v)}`);
      }
    } else {
      out.push(`${indent}- ${renderScalar(item)}`);
    }
  }
  return out;
}

function renderEdit(edit: KeyEdit, lines: readonly string[], span: Span | undefined): string[] {
  if (Array.isArray(edit.value)) {
    return renderList(edit.key, edit.value as readonly YamlItem[], listIndent(lines, span));
  }
  const scalar = edit.value as YamlScalar;
  return [`${edit.key}: ${renderScalar(scalar, wasQuoted(span && lines[span.start]))}`];
}

export interface EditResult {
  text: string;
  /** False when every edit was already satisfied by the file as it stands. */
  changed: boolean;
}

/**
 * Apply key edits to a note's frontmatter block.
 *
 * A note with no frontmatter is refused rather than given one: a file that is not
 * shaped like a task note is not one this tool should be reshaping.
 */
export function editFrontmatter(text: string, edits: readonly KeyEdit[]): EditResult {
  for (const edit of edits) assertSafeKey(edit.key);
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!match || match[2] === undefined) {
    throw new Error('The note has no frontmatter block to edit.');
  }

  const [, open = '', block, close = ''] = match;
  const newline = block.includes('\r\n') || open.includes('\r\n') ? '\r\n' : '\n';
  const lines = block.split(/\r?\n/);

  // Spans are recomputed after each edit: replacing one key with a list of a different
  // length moves every line below it.
  let current = [...lines];
  for (const edit of edits) {
    const spans = topLevelSpans(current);
    const span = spans.find((s) => s.key === edit.key);
    const remove = edit.value === null || (Array.isArray(edit.value) && edit.value.length === 0);

    if (span === undefined) {
      if (remove) continue;
      current = [...current, ...renderEdit(edit, current, undefined)];
      continue;
    }

    const replacement = remove ? [`${edit.key}:`] : renderEdit(edit, current, span);
    current = [...current.slice(0, span.start), ...replacement, ...current.slice(span.end)];
  }

  const rebuilt = current.join(newline);
  if (rebuilt === block) return { text, changed: false };
  return {
    text: `${open}${rebuilt}${close}${text.slice(match[0].length)}`,
    changed: true
  };
}
