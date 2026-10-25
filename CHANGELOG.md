# Changelog

## Unreleased

### Security

- The MCP server no longer takes a file path from the agent. `gantt_apply` accepted
  `undoOut` and wrote the undo proposal there — any path the user could write, with
  content partly chosen through the proposal's rationale. The undo is still returned
  inline on every write.
- The MCP server is bound to the vault it was started with; a call naming another
  vault is refused rather than opened.
- `set_field` could write arbitrary frontmatter: a newline in the field name added a
  second key of the caller's choosing (`status: done`, past catalog validation), and a
  value containing `---` closed the frontmatter block and injected text into the note.
  Field names must now be plain, TaskNotes-managed fields are refused, values must be a
  single line, and the writer escapes control characters and refuses unsafe keys
  regardless of what reaches it.
- CSV export neutralises cells a spreadsheet would evaluate as a formula.
- CI and release workflows pin actions to full commit SHAs, run with read-only
  permissions except where the release is published, do not persist the checkout
  token, and run `npm audit`. Dependabot keeps the pins current.
- Dependencies updated: the bundled MCP SDK (2.0.0 → 2.4.0) and zod, plus vitest 5 and
  esbuild 0.28 for development. `npm audit` reports no vulnerabilities.

### Added

- **`tngantt` code block.** A fenced block renders a live, scoped chart inside any note
  — for the project notes that still carry hand-drawn ASCII timelines. Read-only unless
  the block says `editable: true`.
- **Resource levelling in the chart.** A banner offers to push work off days a resource
  cannot absorb. Push-only, dependency-safe, and reversible like every other write.
- **Headless CLI** (`bin/tng.mjs`): `snapshot`, `doctor`, `validate`, `apply` and
  `schedule` over the same scheduling engine the chart draws with.
- **MCP server** (`bin/tng-mcp.mjs`): `gantt_snapshot`, `gantt_validate`, `gantt_apply`
  and `gantt_schedule`, so an AI agent can plan against the vault directly.
- Proposals, simulation and a validation report that separates blockers from trade-offs;
  `apply` is a dry run by default and returns the proposal that undoes it.
- `schedule` lays work out forward from a start date or backward from a deadline, with
  optional resource levelling.
- [Agent guide](docs/agent-guide.md), written for the AI rather than the user, and a
  [tools reference](docs/tools-reference.md) covering every command, flag, tool
  argument, output shape and exit code.

### Changed

- **"Assignee property" is now "Resource property".** It has always driven the load
  chart, the resource grouping and now levelling, none of which need a person; three
  different names for it across the UI and the docs was a defect. Stored settings are
  migrated.

### Fixed

- Choosing a resource property that TaskNotes maps onto the task itself — `contexts`,
  `projects`, `status` — worked for the load chart and silently did nothing for the
  filter facet and the resource grouping, which read only unmapped properties. All
  three now share one reader. On the reference vault the `contexts` facet went from
  0 tasks to 166.
- The filter facet for the resource property was always labelled "Assignee", whatever
  property it was actually showing, and was offered a second time when the property was
  one the filter bar already lists — "Context" and "Contexts" side by side, the same
  values twice.
- The load chart now says which property it is measuring and how many tasks carry it.
  Previously "no resource is over capacity" and "the property you chose is empty" were
  both simply no banner at all.
- The facet sentinels were literal NUL bytes, which made `src/model/filter.ts` and
  `src/render/layout.ts` read as binary to grep, ripgrep and GitHub's diff view. Saved
  filter selections written with the old form are migrated on load.
- Durations, conflict overlaps and every figure derived from them were computed from
  elapsed time divided by the length of a working day, inflating them by roughly three:
  a Saturday-to-Monday task reported seven working days, and a task 10 working days
  early was reported as 40. All of these are now measured in working time.

## 0.1.0

Initial release.

- Gantt chart on two surfaces: a Bases view that inherits any `.base` file's filters,
  and a standalone tab covering the whole vault.
- Drag to reschedule, drag ends to resize, Shift-drag to create dependencies. All four
  ICS relation types.
- Critical path with float, dependency-conflict detection, and optional cascade.
- Daily load histogram against per-resource capacity.
- Baselines with variance, and progress from checklists, tracked time or status.
- Export to SVG, PNG, CSV or Mermaid.
- Safe mode, confirmation for bulk changes, and undo on every write path.
