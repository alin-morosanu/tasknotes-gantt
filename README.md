# TaskNotes Gantt

Gantt chart, critical path and resource planning for
[TaskNotes](https://github.com/callumalpass/tasknotes) projects in Obsidian.

TaskNotes gives every task a note, real dates and real dependencies. This plugin draws
the plan those fields already describe — and lets you change it by dragging.

## What it does

- **Two surfaces.** A Bases view that inherits any `.base` file's filters, and a
  standalone tab covering the whole vault.
- **Editing.** Drag to reschedule, drag ends to resize, Shift-drag to create
  dependencies. All four ICS relation types.
- **Critical path** with float, dependency-conflict detection, cycle reporting, and
  optional cascade — with one-click fixes for conflicts and circular chains.
- **Capacity.** A daily load histogram per group, against per-resource capacity.
- **Baselines** with variance, and progress from checklists, tracked time or status.
- **Filtering.** Facets for project, status, priority, context, tag, assignee and your
  own TaskNotes user fields — ANDed across facets, ORed within them.
- **Export** to SVG, PNG, CSV or Mermaid.
- **AI-operable.** A headless CLI and an MCP server over the same scheduling engine, so
  an agent can read the plan, propose changes, check what they would break, and write
  them — with a dry run by default and an undo for every write.
- **Safe by default.** Safe mode, confirmation for bulk changes, and undo on every
  write path.

Full keyboard control, pinch to zoom on touch, and a print stylesheet.

## Documentation

| | |
| --- | --- |
| [User guide](docs/user-guide.md) | Reading the chart, editing, filtering, settings reference, troubleshooting |
| [Agent guide](docs/agent-guide.md) | Planning the vault from the CLI or MCP — written for the AI, and worth a read before you point one at your notes |
| [Tools reference](docs/tools-reference.md) | Every command, flag, tool argument, output shape and exit code |
| [Architecture](docs/architecture.md) | Module map, the data pipeline, and the invariants that must not break |
| [Development](docs/development.md) | Build, test, deploy to a vault, conventions, releasing |
| [TaskNotes integration](docs/tasknotes-integration.md) | Every assumption about TaskNotes, and what happens when one fails |
| [Backlog](docs/backlog.md) | Deferred work, and why it was deferred |

## Planning with an AI

The chart's model — critical path, working-time arithmetic, capacity, conflict and
cycle detection — is also reachable outside Obsidian, so an AI agent can plan against
the same numbers you see on screen rather than re-deriving them from 160 markdown files
and getting it wrong.

```sh
npm run build

node bin/tng.mjs doctor    --vault ~/vault --project "PRJ-06"
node bin/tng.mjs schedule  --vault ~/vault --project "PRJ-06" --start 2026-05-04 --out p.json
node bin/tng.mjs validate  --vault ~/vault --project "PRJ-06" --file p.json
node bin/tng.mjs apply     --vault ~/vault --project "PRJ-06" --file p.json --write --undo-out undo.json
```

The same four capabilities are available over MCP. Register `bin/tng-mcp.mjs` with your
agent (see [the agent guide](docs/agent-guide.md)) and it gets `gantt_snapshot`,
`gantt_validate`, `gantt_apply` and `gantt_schedule`.

**Three things keep this safe rather than merely convenient:**

- **Nothing writes by default.** `apply` is a dry run until you pass `--write`, and
  `schedule` and `validate` never write at all.
- **Every write is reversible.** `apply` hands back the proposal that undoes it.
- **The agent has to check its own work.** `validate` reports what a change would break
  as well as what it would fix, and `apply` refuses a proposal that does not validate.

Two caveats worth knowing before you use it on notes you care about. The CLI runs
outside Obsidian, so it edits frontmatter directly rather than through the TaskNotes
API: `dateModified` is not maintained on this path, and Obsidian picks the change up
through its file watcher the way it would an edit from any external editor. And it is
worth trying against a copy of your vault first — `git init` a copy, run the change, and
read the diff.

## Requirements

- Obsidian 1.10.0 or later, for the Bases view API.
- TaskNotes 4.12 or later for editing. Earlier versions, or TaskNotes disabled, fall
  back to a read-only chart with a banner explaining why.

## Install

Not yet in the community plugin browser. To install manually, copy `main.js`,
`manifest.json` and `styles.css` into `.obsidian/plugins/tasknotes-gantt/` in your
vault, then enable it in **Settings → Community plugins**.

## How it stores data

Inside Obsidian, fields TaskNotes owns — `scheduled`, `due`, `status`, `blockedBy` and
the rest — are only ever written through the TaskNotes API, so its caches,
`dateModified` bookkeeping and reverse-dependency handling all stay correct. The
headless CLI runs outside Obsidian and cannot use that API, so it edits the frontmatter
keys directly and leaves `dateModified` alone; see
[Planning with an AI](#planning-with-an-ai).

Fields this plugin adds — baselines — are written directly to task frontmatter under
configurable property names, so they stay readable and diffable, and survive if you
uninstall this plugin.

One thing to know: TaskNotes accepts two `blockedBy` shapes, and its own serializer
normalizes to the object form whenever it writes a task. So the first time you edit a
task that used the bare-string form, those entries are rewritten. No dependency is lost;
only the formatting changes, and it is TaskNotes' behaviour rather than this plugin's.
See [the integration doc](docs/tasknotes-integration.md#data-shapes-that-vary).

## Development

```sh
npm install
npm run dev      # watch build
npm test         # unit tests
npm run build    # typecheck + production bundle
```

Point `OBSIDIAN_VAULT` at a vault and every build deploys into it:

```sh
OBSIDIAN_VAULT=/path/to/scratch-vault npm run dev
```

Use a scratch vault — this plugin writes to task notes. See
[Development](docs/development.md) for the full setup.

## Privacy

The plugin runs entirely locally. It makes no network requests and collects no
telemetry, and neither does the CLI or the MCP server.

The MCP server is a local process that speaks to whatever agent you point at it. What
that agent then does with your task data is between you and it — a snapshot of a
108-task initiative is around 3,000 words of titles, dates and statuses, so decide
deliberately before handing it to a hosted model.

## License

MIT
