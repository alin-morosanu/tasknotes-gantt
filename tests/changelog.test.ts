import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint, releaseChangelog, unreleasedBody, versionBody } from '../scripts/changelog.mjs';

/**
 * The changelog follows Keep a Changelog, and the release commit moves it mechanically.
 * These hold the real file to the format in CI, so a malformed entry fails a pull
 * request rather than a release.
 */

const REPO = 'https://example.test/repo';
const FIRST = `# Changelog

All notable changes. Based on Keep a Changelog; adheres to Semantic Versioning.

## [Unreleased]

### Fixed

- A thing.

[unreleased]: ${REPO}/compare/HEAD
`;

describe('the real CHANGELOG.md', () => {
  it('conforms to Keep a Changelog', () => {
    expect(lint(readFileSync('CHANGELOG.md', 'utf8'))).toEqual([]);
  });

  it('has a section for the version in manifest.json', () => {
    // A release whose version has no entry would publish empty release notes.
    const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version as string;
    expect(() => versionBody(readFileSync('CHANGELOG.md', 'utf8'), version)).not.toThrow();
  });
});

describe('releaseChangelog', () => {
  it('moves Unreleased into a dated section and leaves Unreleased empty', () => {
    const out = releaseChangelog(FIRST, '0.1.0', '2026-10-25', REPO);
    expect(unreleasedBody(out)).toBe('');
    expect(versionBody(out, '0.1.0')).toBe('### Fixed\n\n- A thing.');
    expect(out).toContain('## [Unreleased]\n\n## [0.1.0] - 2026-10-25');
  });

  it('links the first release to its tag, and later ones to a comparison', () => {
    const first = releaseChangelog(FIRST, '0.1.0', '2026-10-25', REPO);
    expect(first).toContain(`[0.1.0]: ${REPO}/releases/tag/0.1.0`);
    expect(first).toContain(`[unreleased]: ${REPO}/compare/0.1.0...HEAD`);

    const withMore = first.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- More.\n');
    const second = releaseChangelog(withMore, '0.2.0', '2026-11-01', REPO);
    expect(second).toContain(`[0.2.0]: ${REPO}/compare/0.1.0...0.2.0`);
    expect(second).toContain(`[unreleased]: ${REPO}/compare/0.2.0...HEAD`);
    // Bare tags: Obsidian installs from the release whose tag equals the version.
    expect(second).not.toMatch(/compare\/v\d/);
  });

  it('refuses to release with nothing recorded', () => {
    const empty = releaseChangelog(FIRST, '0.1.0', '2026-10-25', REPO);
    expect(() => releaseChangelog(empty, '0.1.1', '2026-10-26', REPO)).toThrow(/Nothing under/);
  });

  it('refuses a version it already has, or one that is not x.y.z', () => {
    const once = releaseChangelog(FIRST, '0.1.0', '2026-10-25', REPO);
    expect(() => releaseChangelog(once, '0.1.0', '2026-10-25', REPO)).toThrow(/already/);
    expect(() => releaseChangelog(FIRST, 'v0.1.0', '2026-10-25', REPO)).toThrow(/x\.y\.z/);
  });

  it('produces a file the linter accepts', () => {
    expect(lint(releaseChangelog(FIRST, '0.1.0', '2026-10-25', REPO))).toEqual([]);
  });
});

describe('lint', () => {
  it('rejects the shapes that break the convention', () => {
    const bad = FIRST.replace('## [Unreleased]', '## Unreleased')
      .replace('### Fixed', '### Bugfixes')
      .concat('\n## 0.1.0\n');
    const problems = lint(bad).join(' | ');
    expect(problems).toContain('"## [Unreleased]" must be the first section');
    expect(problems).toContain('Unknown category "Bugfixes"');
    expect(problems).toContain('Malformed version heading');
  });

  it('rejects an empty category, which is noise', () => {
    expect(lint(FIRST.replace('- A thing.', '')).join(' ')).toContain('has no entries');
  });
});
