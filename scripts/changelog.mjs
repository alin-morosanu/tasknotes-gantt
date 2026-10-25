import fs from 'node:fs';
import process from 'node:process';

/**
 * Keep a Changelog, mechanically.
 *
 * `npm version` runs `release` so the changelog moves in the same commit as the
 * version, and the release workflow runs `notes` to publish that version's section as
 * the GitHub release notes. Doing either by hand is how a changelog falls behind.
 *
 * One deliberate departure from the Keep a Changelog examples: tags are bare versions
 * (`0.1.1`, not `v0.1.1`), because Obsidian downloads from the release whose tag equals
 * manifest.json's version exactly. The compare links follow the tags.
 */

export const REPO = 'https://github.com/alin-morosanu/tasknotes-gantt';
export const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})( \[YANKED\])?$/;

/** Split the file into its sections, keyed by heading line. */
function sections(text) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (line.startsWith('## ') ? [i] : []));
  const linksAt = lines.findIndex((line) => /^\[[^\]]+\]: /.test(line));
  return { lines, starts, linksAt: linksAt === -1 ? lines.length : linksAt };
}

/** The body of `## [Unreleased]`, trimmed. Empty string when there is nothing in it. */
export function unreleasedBody(text) {
  const { lines, starts, linksAt } = sections(text);
  const at = lines.findIndex((line) => line === '## [Unreleased]');
  if (at === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  const next = starts.find((i) => i > at) ?? linksAt;
  return lines.slice(at + 1, next).join('\n').trim();
}

/** The body of one released version's section, for release notes. */
export function versionBody(text, version) {
  const { lines, starts, linksAt } = sections(text);
  const at = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
  if (at === -1) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const next = starts.find((i) => i > at) ?? linksAt;
  return lines.slice(at + 1, next).join('\n').trim();
}

/**
 * Move everything under [Unreleased] into a new version section.
 *
 * Refuses an empty release: every version should say what changed, and a release with
 * nothing in Unreleased is usually a forgotten changelog rather than a real no-op.
 */
export function releaseChangelog(text, version, date, repo = REPO) {
  if (!SEMVER.test(version)) throw new Error(`Not a x.y.z version: ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not an ISO date: ${date}`);
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has ${version}.`);

  const body = unreleasedBody(text);
  if (body === '') {
    throw new Error(
      'Nothing under [Unreleased]. Record what changed before releasing — every version ' +
        'should have an entry.'
    );
  }

  const previous = text.match(/^## \[(\d+\.\d+\.\d+)\] - /m)?.[1] ?? null;
  const { lines, starts, linksAt } = sections(text);
  const at = lines.findIndex((line) => line === '## [Unreleased]');
  const next = starts.find((i) => i > at) ?? linksAt;

  const released = [
    ...lines.slice(0, at + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    body,
    '',
    ...lines.slice(next)
  ];

  // Link references: Unreleased compares from the new version; the new version compares
  // from the previous one, or links to its release when it is the first.
  const links = released
    .join('\n')
    .replace(/^\[unreleased\]: .*$/m, `[unreleased]: ${repo}/compare/${version}...HEAD`);
  const entry = previous
    ? `[${version}]: ${repo}/compare/${previous}...${version}`
    : `[${version}]: ${repo}/releases/tag/${version}`;
  return links.replace(/^(\[unreleased\]: .*)$/m, `$1\n${entry}`).replace(/\n{3,}/g, '\n\n');
}

/**
 * Problems with the file's shape, as readable messages. Empty when it conforms.
 *
 * Run by the test suite, so a malformed changelog fails CI rather than a release.
 */
export function lint(text) {
  const problems = [];
  const lines = text.split('\n');
  if (lines[0] !== '# Changelog') problems.push('The first line must be "# Changelog".');
  if (!text.includes('Keep a Changelog')) problems.push('The header must say it follows Keep a Changelog.');
  if (!text.includes('Semantic Versioning')) problems.push('The header must say it follows Semantic Versioning.');

  const headings = lines.filter((line) => line.startsWith('## '));
  if (headings[0] !== '## [Unreleased]') problems.push('"## [Unreleased]" must be the first section.');

  const versions = [];
  for (const heading of headings.slice(1)) {
    const match = VERSION_HEADING.exec(heading);
    if (!match) problems.push(`Malformed version heading: "${heading}" — expected "## [x.y.z] - YYYY-MM-DD".`);
    else versions.push(match);
  }
  for (let i = 1; i < versions.length; i += 1) {
    if (versions[i - 1][2] < versions[i][2]) problems.push(`${versions[i - 1][1]} is dated before ${versions[i][1]}; newest first.`);
  }

  for (const line of lines.filter((l) => l.startsWith('### '))) {
    const name = line.slice(4);
    if (!CATEGORIES.includes(name)) problems.push(`Unknown category "${name}". Use ${CATEGORIES.join(', ')}.`);
  }
  // An empty category heading is noise.
  lines.forEach((line, i) => {
    if (line.startsWith('### ') && !(lines.slice(i + 1).find((l) => l.trim() !== '') ?? '').startsWith('- ')) {
      problems.push(`"${line}" has no entries.`);
    }
  });

  if (!/^\[unreleased\]: /m.test(text)) problems.push('Missing the [unreleased] link reference.');
  for (const match of versions) {
    if (!new RegExp(`^\\[${match[1].replace(/\./g, '\\.')}\\]: `, 'm').test(text)) {
      problems.push(`Missing the link reference for ${match[1]}.`);
    }
  }
  return problems;
}

// Command line: `release` during `npm version`, `notes <version>` in the release job.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, arg] = process.argv.slice(2);
  const file = 'CHANGELOG.md';
  const text = fs.readFileSync(file, 'utf8');
  try {
    if (command === 'release') {
      const version = arg ?? process.env.npm_package_version;
      const date = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(file, releaseChangelog(text, version, date));
      console.log(`CHANGELOG.md: released ${version} (${date}).`);
    } else if (command === 'notes') {
      process.stdout.write(`${versionBody(text, arg)}\n`);
    } else if (command === 'check') {
      // Run before `npm version` touches anything, so a refusal leaves no half-bumped files.
      const problems = lint(text);
      if (unreleasedBody(text) === '') {
        problems.push('Nothing under [Unreleased]. Record what changed before releasing — every version should have an entry.');
      }
      for (const p of problems) console.error(`CHANGELOG.md: ${p}`);
      process.exitCode = problems.length === 0 ? 0 : 1;
    } else if (command === 'lint') {
      const problems = lint(text);
      for (const p of problems) console.error(`CHANGELOG.md: ${p}`);
      process.exitCode = problems.length === 0 ? 0 : 1;
    } else {
      console.error('Usage: node scripts/changelog.mjs check | release [version] | notes <version> | lint');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
