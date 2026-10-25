# Contributing

Thanks for wanting to improve TaskNotes Gantt. [Development](docs/development.md) has
the full setup; this page is what a pull request needs.

## Before you open a pull request

```sh
npm ci
npm run lint
npm test
npm run build
```

CI runs the same four, plus `npm audit`, on every push and pull request.

Try your change in a **scratch vault**, never one you care about — the plugin writes to
task notes. `OBSIDIAN_VAULT=/path/to/scratch npm run dev` builds and deploys on every
save.

## Record the change in the changelog

Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in the category
that fits: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed** or
**Security**. Write it for someone using the plugin, not for someone reading the diff:
what is different for them, as a sentence ending in a full stop. Internal changes with
no visible effect — refactors, test-only changes, CI — do not need an entry.

The test suite checks the changelog's format, so a malformed entry fails CI.

## What to test

- **Logic** in `src/model/`, `src/agent/`, `src/render/` and `src/data/` is pure and
  gets unit tests. A bug fix comes with a test that fails without it.
- **UI changes** need a look in a real Obsidian session. [Driving
  Obsidian](docs/development.md#driving-obsidian-for-screenshots) describes how to take
  screenshots and click through the chart from a script.
- **Never commit real vault data.** Fixtures in `tests/fixtures/` are made up; keep
  them that way. Names, projects and paths from your own vault would become public.

## Style

Follow the code around you. Comments explain *why*, not *what* — the bug a line
prevents, or the constraint it satisfies. See the conventions in
[Development](docs/development.md#conventions) and the invariants in
[Architecture](docs/architecture.md#load-bearing-invariants) before changing something
those sections describe.

## Releases

Maintainers cut releases; you do not need to bump versions in a pull request. The
process is in [Development → Releasing](docs/development.md#releasing).
