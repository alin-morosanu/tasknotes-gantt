# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release tags are bare versions (`0.1.0`, not `v0.1.0`), because Obsidian installs from
the release whose tag matches `manifest.json` exactly.

## [Unreleased]

## [0.1.1] - 2026-11-02

### Added

- Screenshots in the README, taken from a vault of made-up projects that
  `scripts/demo-vault.mjs` builds.

### Changed

- The grouping that follows the resource property is named after it — "Resource
  (contexts)" — instead of always reading "Assignee", whatever the property was.

### Fixed

- A `tngantt` block could show its task list beside a blank timeline. The chart now
  redraws when its size changes, and when Obsidian's reading view briefly detaches a
  note's sections during layout.
- A `tngantt` block inherited the main view's switched-off groups, so a block with
  `groupBy: none` showed no tasks when the main view had hidden the ungrouped bucket.
- Error messages in a `tngantt` block show quoted options as code instead of literal
  backticks.
- Switching the load chart on from the toolbar now shows its banner and the **Level
  them** button straight away, instead of only after the next change to a note. The
  banners also follow filter changes.

## [0.1.0] - 2026-10-25

First public release.

### Added

- Gantt chart on two surfaces: a Bases view that inherits any `.base` file's filters,
  and a standalone tab covering the whole vault.
- `tngantt` code block that draws a live, scoped chart inside any note. Read-only
  unless the block says `editable: true`; a misspelt option is reported in place of
  the chart.
- Drag to reschedule, drag either end to resize, and Shift-drag to create a
  dependency, across all four ICS relation types.
- Critical path with float, dependency-conflict detection, cycle reporting and
  optional cascade, with one-click fixes for conflicts and circular chains.
- Daily load histogram per group against per-resource capacity, with a banner stating
  which property is being measured and how many tasks carry it.
- Resource levelling from the chart: push-only, dependency-safe, and undoable.
- Baselines with variance, and progress from checklists, tracked time or status.
- Filtering by project, status, priority, context, tag, the resource property and
  every TaskNotes user field — ANDed across facets, ORed within them.
- Export to SVG, PNG, CSV or Mermaid. CSV cells a spreadsheet would run as a formula
  are written as text.
- Safe mode, confirmation for bulk changes, and undo on every write path.
- Data report command listing what the plugin can see, including the filter facets it
  will offer.
- Headless CLI (`snapshot`, `doctor`, `validate`, `apply`, `schedule`) and an MCP
  server (`gantt_snapshot`, `gantt_validate`, `gantt_apply`, `gantt_schedule`) over the
  same scheduling engine, so an AI agent can read the plan, check a proposed change and
  write it. Writes are a dry run by default and return the proposal that undoes them;
  the MCP server is bound to one vault and never writes outside it.
- User guide, agent guide, tools reference, and architecture and development docs.

[unreleased]: https://github.com/alin-morosanu/tasknotes-gantt/compare/0.1.1...HEAD
[0.1.1]: https://github.com/alin-morosanu/tasknotes-gantt/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/alin-morosanu/tasknotes-gantt/releases/tag/0.1.0
