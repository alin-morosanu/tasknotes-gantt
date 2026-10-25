# Tools reference

Every command, flag, tool argument and output shape, for looking up.

For *how to use these well* — the loop, what makes an answer wrong, what to do about
inferred dates — read [the agent guide](agent-guide.md) instead. This page is the
lookup table that guide assumes.

Two front doors, one engine:

| | |
| --- | --- |
| **CLI** | `bin/tng.mjs`, built by `npm run build`. Markdown or JSON on stdout. |
| **MCP** | `bin/tng-mcp.mjs`, stdio transport. Four tools, text results. |

Both call the same pure modules the Gantt chart calls, so their answers cannot differ
from what the chart shows.

---

## Running them

```sh
npm run build          # produces bin/tng.mjs and bin/tng-mcp.mjs

node bin/tng.mjs help
node bin/tng.mjs snapshot --vault ~/vault --project "PRJ-06"
```

Without `--vault`, the CLI walks up from the working directory looking for a
`.obsidian` directory.

MCP registration, for Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "tasknotes-gantt": {
      "command": "node",
      "args": ["/path/to/TaskNotes-Gantt-Chart/bin/tng-mcp.mjs", "--vault", "/path/to/vault"]
    }
  }
}
```

The server reads the vault fresh on every call — about 0.2 seconds for 1,300 notes —
so it never answers from a plan that has since changed on disk.

---

## Command and tool map

| CLI | MCP | Writes? |
| --- | --- | --- |
| `tng snapshot` | `gantt_snapshot` | no |
| `tng doctor` | `gantt_snapshot` with `summary: true` | no |
| `tng validate` | `gantt_validate` | no |
| `tng apply` | `gantt_apply` | only with `--write` / `write: true` |
| `tng schedule` | `gantt_schedule` | no |
| `tng help` | — | no |

---

## Scope

Every command takes the same scope selection. Clauses **narrow together** (AND);
multiple values within one clause **widen** (OR).

| CLI | MCP | Type | Meaning |
| --- | --- | --- | --- |
| `--initiative X` | `initiative` | `string[]` | Exact, case-insensitive match on a user-defined field |
| `--project X` | `project` | `string[]` | **Substring**, case-insensitive, of a project's name |
| `--status X` | `status` | `string[]` | Exact, case-insensitive match on status |
| `--from D` | `from` | `string` | Window start, `YYYY-MM-DD` |
| `--to D` | `to` | `string` | Window end, `YYYY-MM-DD` |
| `--all` | `includeArchived` | `boolean` | Include archived tasks |
| `--vault PATH` | `vault` | `string` | The vault to read. Over MCP it must match the server's `--vault` |

**On the CLI, multi-value clauses are comma-separated**; over MCP they are arrays.

```sh
tng snapshot --status "backlog,in-progress" --project "PRJ-06,PRJ-01"
```

```json
{ "status": ["backlog", "in-progress"], "project": ["PRJ-06", "PRJ-01"] }
```

`--project` matching is by substring, so `PRJ-01` and `Relaunch` both select
*PRJ-01 Website Relaunch*. The others are exact.

Archived tasks are excluded unless you ask for them.

> **A date window drops undated tasks entirely.** A task is in the window if any part
> of it overlaps, and a task with neither a start nor a due date has no part to
> overlap with. In the reference vault, `--project PRJ-06` returns 16 tasks and
> `--project PRJ-06 --from 2020-01-01 --to 2030-01-01` returns 8 — the other 8 have no
> dates at all. Use a window to narrow a timeline, never to select "everything".

> **Scope determines identity.** Short ids are assigned within the scope you asked for.
> Use the same scope for every call in one piece of work, or the ids in a proposal may
> resolve to different tasks than the ones you saw.

---

## `snapshot` / `gantt_snapshot`

The state of the plan: problems, uncertainty, resource load, critical path, tasks.

| CLI | MCP | Meaning |
| --- | --- | --- |
| `--format json` | `format: "json"` | Full [`AgentSnapshot`](#agentsnapshot) instead of the markdown brief |
| `--detail A,B` | `detail: ["A","B"]` | Expand these task ids in full beneath the table |
| `--summary` | `summary: true` | Omit the task table |

`--format json` returns the whole structure and ignores `--detail` and `--summary`,
which only shape the markdown brief.

Brief sections, in order — deliberately, so a truncated read still holds what matters:

1. **Header** — scope, task count, timeline, working calendar.
2. **Problems** — conflicts with magnitude, circular dependencies.
3. **What this snapshot does not know** — inferred dates, missing estimates, dangling
   links. Read this before quoting any total.
4. **Load** — hours per resource, and days over capacity.
5. **Critical path** — the chain that determines the end date.
6. **Tasks** — the table.
7. **Detail** — only when `--detail` was given.
8. **Legend**.

The MCP tool appends an **Unreadable notes** section when any file that looked like a
task could not be parsed, matching `tng doctor`.

### Reading the task table

```
| id | task | status | pri | start | end | est | float | blocked by |
| BLO-0003! | BLO-0003: Keyword Research | backlog | high | 2026-07-04 | 2026-07-06 | 2h | 0d | BLO-0002 |
```

| Marker | Meaning |
| --- | --- |
| `~2026-07-04` | The chart **inferred** this date. Nothing in the note says it. |
| `!` after an id | On the critical path |
| `◆` | A milestone (a task with a zero estimate) |
| `float` | Working days it can slip before delaying the plan. `—` means it is in a cycle and not scheduled. |
| `BLO-0002:SS` | A relation other than finish-to-start (`FS`, `SS`, `FF`, `SF`) |
| `…booking page?` | The dependency does not resolve. Unresolved entries show the uid **as authored** — usually a path — because there is no task to give a short id to. |

---

## `doctor`

`tng doctor` is `tng snapshot --summary` plus any unreadable notes: problems and
uncertainty without the task table. CLI only — over MCP, call `gantt_snapshot` with
`summary: true`, which returns the same thing.

Takes the scope flags and nothing else.

---

## `validate` / `gantt_validate`

What a proposal would change, break and fix. Writes nothing.

| CLI | MCP | Meaning |
| --- | --- | --- |
| `--file F` | `proposal` | The proposal — a file path on the CLI, an inline object over MCP |
| `--format json` | — | Full [`ValidationReport`](#validationreport) instead of markdown |

`--proposal F` is accepted as a synonym for `--file F`.

**Exit code 3** when the proposal cannot be applied, so a script can branch without
parsing the text. Over MCP a negative verdict is still a successful call — `isError`
is false, because the tool did its job.

---

## `apply` / `gantt_apply`

The same report, and then the write. **A dry run unless you ask for the write.**

| CLI | MCP | Meaning |
| --- | --- | --- |
| `--file F` | `proposal` | The proposal |
| `--write` | `write: true` | Edit the notes. Without it, nothing is touched. |
| `--undo-out F` | — | Write the reversing proposal to this path. CLI only |
| `--allow-cycles` | `allowCycles: true` | Write despite a restored circular dependency |

Over MCP, every write returns the undo proposal in the result as a fenced `json`
block. There is deliberately no way for an agent to name a file to write it to: a
path chosen by the agent would be a write anywhere the user can write. A dry run does not include it, because nothing has changed.
It is emitted before the notes are touched, so an interrupted write is still
recoverable from what the call already returned.

What a write does and does not touch:

- Only the frontmatter keys the proposal names, edited in place. Key order, quoting
  style, comments and the note body are unchanged.
- Clearing a key blanks its value rather than deleting the line, because that is how
  TaskNotes writes an empty date and because deleting could not be undone.
- Nothing is written until every file in the batch has been read, edited and re-parsed
  in memory. One unwritable note stops the whole batch.
- `dateModified` is not updated: the CLI runs outside Obsidian and edits the file
  directly. Obsidian's watcher re-indexes the change like any external edit.

### `--allow-cycles`

A proposal that would create a circular dependency is refused. Undoing a change that
*broke* a cycle necessarily recreates it, so that one error can be waived — and only
that one. A proposal with an unknown id or an unparseable date is still refused, because
writing an operation that did not apply would commit a change set nobody described.

---

## `schedule` / `gantt_schedule`

Lay work out over the working calendar and the dependency network. Emits a proposal;
writes nothing.

| CLI | MCP | Meaning |
| --- | --- | --- |
| `--start D` | `start` | Lay work out forward from this date |
| `--deadline D` | `deadline` | Or backward from the date it must be finished by |
| `--level` | `level: true` | Also push work off days a resource is over capacity |
| `--resource F` | `resource` | Field naming the resource, e.g. `contexts` |
| `--rounds N` | `rounds` | Levelling rounds before giving up. Default 50. |
| `--out F` | — | Save the proposal to this path |
| `--format json` | — | Print the bare proposal instead of the summary (ignored when `--out` is given) |

Exactly one of `--start` and `--deadline` is required; giving both is an error, because
forward-from-a-start and backward-from-a-deadline are different questions.

**Read the notes it returns.** They are the part that says where the plan rests on a
guess: how many tasks had no estimate, how many are scheduled on non-working days, how
many conflicts survive because they involve work already finished, and whether levelling
converged.

What it will not do:

- Move a finished task. Rescheduling history would rewrite the record of when work
  happened, so conflicts involving a done task survive a clean layout.
- Schedule a task inside a circular dependency, which has no earliest start.
- Re-estimate. Each task keeps the length it has now — the working span between its
  dates, or its estimate where it has no span.

A backward pass schedules into the past rather than clamping, and says so, because
whether the deadline is reachable is the thing worth knowing.

Levelling needs a field the vault actually fills in. Check the snapshot's Load section
first; if nothing carries the field, every task lands in an unlimited "unassigned" lane
and the notes say so rather than reporting success.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The command failed — no vault, unreadable proposal file, unwritable note |
| `2` | Unknown command |
| `3` | `validate` or `apply`: the proposal cannot be applied |

---

## JSON shapes

### Proposal

The document you write. `version` is optional and must be `1` if present.

```json
{
  "version": 1,
  "rationale": "Resolve the BLO chain.",
  "operations": [
    { "op": "set_dates", "id": "BLO-0004", "scheduled": "2026-05-04", "due": "2026-05-08" }
  ]
}
```

| `op` | Fields | Notes |
| --- | --- | --- |
| `set_dates` | `scheduled?`, `due?` | At least one. `null` clears that date. |
| `shift` | `days` | Non-zero whole number; negative moves earlier |
| `set_estimate` | `minutes` | Non-negative, or `null`. `0` marks a milestone. |
| `add_dependency` | `blockedBy`, `type?`, `lag?` | Re-stating an existing dependency updates its type and lag |
| `remove_dependency` | `blockedBy` | |
| `set_status` | `status` | Must be a status the vault defines |
| `set_field` | `field`, `value` | A property of your own, by plain name (`initiative`). Not a field TaskNotes manages — those have their own operations. Single-line value; `null` clears it |

`id` and `blockedBy` accept a short id (`BEL-0002`), a full vault path, or a bare
filename. Case-insensitive.

`type` is `FINISHTOSTART` (the default), `STARTTOSTART`, `FINISHTOFINISH` or
`STARTTOFINISH`. `lag` is an ISO-8601 duration, negative for a lead.

> **Durations are working time.** `PT4H` is four working hours. `P2D` is 2,880 minutes
> of working time — six working days on an eight-hour day, not two. Write `PT16H` for
> two working days.

### `AgentSnapshot`

```
generatedAt   string                ISO timestamp
vault         string                absolute path
scope         { description, taskCount, totalInVault }
calendar      { workdays[], dayStart, dayEnd, hoursPerDay, holidays[], dueDateInclusive }
vocabulary    { statuses[{value,label,done}], priorities[{value,label,weight}], userFields[] }
timeline      { start, end }        null when nothing is scheduled
problems      { conflicts[], cycles[][] }
unknowns      SnapshotUnknowns
criticalPath  string[]              task ids, in order
resources     SnapshotResource[]
tasks         SnapshotTask[]
```

**`tasks[]`**

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The short stable id |
| `path` | `string` | Vault-relative note path |
| `title`, `status`, `priority` | `string` | |
| `done` | `boolean` | Whether that status counts as complete |
| `start`, `end` | `{ date, origin }` | `origin` is `"authored"` or `"inferred"` |
| `durationDays` | `number` | **Working** days the bar spans |
| `estimateMinutes` | `number \| null` | |
| `milestone` | `boolean?` | Present only when true |
| `projects`, `contexts` | `string[]` | |
| `assignee` | `string?` | |
| `fields` | `Record<string,string>` | User-defined TaskNotes fields |
| `progress` | `number \| null` | Ratio in `[0,1]` |
| `dependencies` | `{ blockedBy, type, lagMinutes?, unresolved? }[]` | |
| `floatDays` | `number \| null` | Working days of slack; `null` when excluded from scheduling |
| `critical` | `boolean` | |

**`unknowns`**

| Field | Type |
| --- | --- |
| `tasksWithoutEstimate` | `number` |
| `tasksWithoutDates` | `number` |
| `tasksWithInferredDates` | `number` |
| `danglingDependencies` | `{ task, link }[]` |
| `danglingProjects` | `{ project, taskCount }[]` |
| `excludedFromScheduling` | `string[]` |

**`problems.conflicts[]`** — `{ task, blockedBy, type, overlapDays, message }`.
`overlapDays` is in working days; `0` means the order is wrong but the overlap falls
entirely on non-working days, so no actual work collides.

**`resources[]`** — `{ name, taskCount, totalHours, capacityHoursPerDay, overloadedDays,
overloads: { date, hours, capacityHours }[], unestimatedCount }`. A
`capacityHoursPerDay` of `null` marks an unlimited lane, which is what the unassigned
pile is.

### `ValidationReport`

```
ok            boolean               false when anything in errors blocks the change
rationale     string?               carried through from the proposal
errors        { operation, message, hint?, kind? }[]
regressions   string[]              costs to weigh, not blockers
improvements  string[]
neutral       string[]
changes       { id, title, fields: { field, before, after }[] }[]
summary       { tasksChanged, conflicts, cycles, overloadedDays, criticalTasks, projectEnd }
```

Every entry in `summary` except `tasksChanged` is a `{ before, after }` pair.

In `errors`, `operation` is the zero-based index of the offending operation, or `-1`
for a problem with the proposal as a whole. `kind: "cycle"` marks the one error
`--allow-cycles` may waive. Errors are ordered by operation, with document-level
problems last, so the list reads in the same sequence as the proposal.

---

## Errors worth recognising

| Message | What to do |
| --- | --- |
| `No task called "X". Did you mean …?` | A typo, or a scope that does not contain the task |
| `set_dates changes nothing: give scheduled, due, or both.` | Add a date field |
| `"X" is not a status in this vault.` | Use one from the snapshot's `vocabulary.statuses` |
| `Due date D falls before the start S.` | A one-sided `set_dates` can be refused by the *other* date |
| `That dependency is not on this task.` | The hint lists what the task actually waits for |
| `` `status` is managed by TaskNotes and cannot be set with set_field. `` | Use the dedicated operation: set_status, set_dates, set_estimate, add/remove_dependency |
| `This server is bound to … and will not open another vault.` | Start a second MCP server with `--vault` for the other vault |
| `This would create a circular dependency: …` | Blocking, unless this is an undo — see `--allow-cycles` |
| `Nothing was written: fix the errors above and run again.` | `apply` refused; nothing changed |
| `No vault found. Run inside an Obsidian vault, or pass --vault <path>.` | |
| `TaskNotes settings not found at …` | The vault has no TaskNotes plugin data to read the catalog from |
