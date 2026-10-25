# Planning this vault, for an AI agent

You are being asked to reason about a project plan that lives in Obsidian notes. This
document is written for you, not for the person using the plugin. Read the whole thing
once; it is short, and most of it is about how to be wrong less often.

## What you have

A vault of TaskNotes task notes, each with dates, an estimate, a status, and
`blockedBy` dependencies. On top of that sits the same scheduling engine the Gantt
chart draws with: critical path, working-time arithmetic, resource capacity, cycle
detection, conflict detection.

You reach it two ways, both onto the identical core.

**MCP** — `gantt_snapshot`, `gantt_validate`, `gantt_apply`, `gantt_schedule`.

**CLI** — `tng snapshot`, `tng doctor`, `tng validate`, `tng apply`, `tng schedule`.
Add `--vault <path>` if you are not inside the vault. `tng help` prints the flags, and
[the tools reference](tools-reference.md) has every flag, argument and output shape.

`tng doctor` is `tng snapshot --summary` — problems and totals without the task table —
and `gantt_snapshot` with `summary: true` is the same thing over MCP.

Anything you can do in one you can do in the other, with the same answers. Nothing
here is a separate reimplementation of the chart: if these tools say a task is
critical, the user's chart says so too.

---

## The loop

**snapshot → propose → validate → apply.**

Do not skip validate. It is the only thing standing between a plausible-looking
rearrangement and one that actually holds together, and it is cheap. A proposal that
does not validate is refused by `apply` anyway, so checking first costs you nothing and
tells you what to fix.

The point of the loop is that you get to check your own answer. Without it you get one
guess. With it you converge.

---

## Four things that will make you wrong

### 1. A `~` date is a guess, not a commitment

The chart infers dates for tasks that do not have them. 23 tasks in the reference vault
have a due date and no start; 19 have neither. Every date in a snapshot is marked:

```
| TASK-0630 | TASK-0630 Draft the project brief… | backlog | high | ~2026-09-07 | ~2026-09-07 | 4h | 0d |  |
```

`~2026-09-07` means **nothing in the note says that**. The chart put the task there
because it had to put it somewhere. In JSON the same thing appears as
`"origin": "inferred"` against `"origin": "authored"`.

Rescheduling around an inferred date as though a person chose it is the single most
common way to produce a confident, wrong plan. Treat an inferred date as free to move
and an authored one as a decision somebody made.

### 2. The snapshot tells you what it does not know

Read the **"What this snapshot does not know"** section before you trust any total:

```
- 42 task(s) have at least one date the chart worked out rather than read from the note
  — marked `~` below. 19 have no dates at all.
- 23 task(s) have no time estimate. They contribute nothing to the resource totals, so
  those totals understate the real load.
- 2 dependenc(y/ies) point at notes that do not exist: SAL-0002 → `TaskNotes/Tasks/…`.
  They are not part of the schedule.
- 5 project link(s) point at missing notes: `Side Project` (3 tasks), …
```

A resource total computed from a set where a fifth of the tasks have no estimate is not
a resource total. Say so when you report it, rather than passing on a number that looks
authoritative.

The Problems section above it carries the other exclusion you need: a circular
dependency removes its members from scheduling entirely, so they have no float and
nothing downstream of them is measured until you break it.

### 3. Use the short ids

Tasks are named `BEL-0002`, `BOA-0012`, `TASK-0610`. Use those everywhere. They are
short, stable, and hard to get subtly wrong; a 60-character path is none of those, and
a proposal that names a task by a nearly-correct path fails in a way that is tedious to
debug. A reference is also accepted as a full path or a bare filename, and an unknown
one comes back with the near misses:

```
No task called "BEL-9999". Did you mean BEL-0001, BEL-0002, BEL-0003?
```

### 4. Scope must match

Ids are assigned within the scope you asked for. If you take a snapshot of
`--initiative "Company Growth"` and then validate against the whole vault, ids may
resolve to different tasks or not at all. **Use the same scope for every call in one
piece of work.**

Scope flags combine and narrow together: `--initiative`, `--project` (substring match,
so `PRJ-01` or `Relaunch` both work), `--status`, `--from`/`--to`, `--all` to
include archived.

---

## The proposal

A small JSON document. Every operation names one task and one intent.

```json
{
  "version": 1,
  "rationale": "Resolve the BLO chain so nothing starts before its predecessor finishes.",
  "operations": [
    { "op": "set_dates", "id": "BLO-0004", "scheduled": "2026-05-04", "due": "2026-05-08" },
    { "op": "shift", "id": "BLO-0005", "days": 3 },
    { "op": "set_estimate", "id": "BOA-0007", "minutes": 240 },
    { "op": "add_dependency", "id": "BEL-0003", "blockedBy": "BEL-0002", "type": "STARTTOSTART", "lag": "PT4H" },
    { "op": "remove_dependency", "id": "BEL-0004", "blockedBy": "BEL-0003" },
    { "op": "set_status", "id": "BEL-0001", "status": "in-progress" },
    { "op": "set_field", "id": "BEL-0001", "field": "initiative", "value": "Company Growth" }
  ]
}
```

| Operation | Fields | Notes |
| --- | --- | --- |
| `set_dates` | `scheduled?`, `due?` | Either or both. `null` clears one. Omitting both is an error. |
| `shift` | `days` | Whole days, negative moves earlier. Materializes an inferred date. |
| `set_estimate` | `minutes` | `0` marks a milestone. `null` clears it. |
| `add_dependency` | `blockedBy`, `type?`, `lag?` | Re-stating an existing one updates it. |
| `remove_dependency` | `blockedBy` | |
| `set_status` | `status` | Must be a status this vault defines; the snapshot lists them. |
| `set_field` | `field`, `value` | A property of your own, such as `initiative`. Refused for fields TaskNotes manages — use the dedicated operation. Single-line value; `null` clears it. |

`type` is one of `FINISHTOSTART` (the default), `STARTTOSTART`, `FINISHTOFINISH`,
`STARTTOFINISH`. `lag` is an ISO-8601 duration, negative for a lead.

**Every problem is reported at once**, with the index of the operation at fault, so you
can fix the whole list in one pass rather than one error per round trip.

---

## Reading a validation report

Three categories, and they mean different things.

**Errors** stop the change. An unknown id, a date that cannot be parsed, a status this
vault does not define, a dependency cycle the change would create. Fix these; there is
nothing to weigh.

**Regressions** are real costs for you to judge, not blockers. Conflicts introduced,
a resource pushed over capacity, the end of the plan moved out, the critical path
lengthened. A proposal with regressions still applies. Decide whether the trade is
worth it and say so when you report back.

**Improvements** are what it fixes.

```
# Validation — can be applied

## What this fixes
- Resolves 2 dependency conflict(s), leaving none.
- Pulls the end of the plan in to 2026-06-04.

## Summary
| | before | after |
| --- | --- | --- |
| conflicts | 2 | 0 |
| cycles | 0 | 0 |
| end of plan | 2026-09-07 | 2026-06-04 |
```

The CLI exits `3` when a proposal cannot be applied, so you can branch on that without
reading the text.

---

## Writing

**`apply` is a dry run unless you say otherwise** — `--write` on the CLI, `write: true`
over MCP. A dry run reports exactly what it would do and touches nothing.

Only the keys your proposal names are edited, in place. Key order, quoting, comments
and the note body are left alone.

**Keep the undo.** `apply` returns the proposal that reverses the change — in the MCP
result, or to a file with `--undo-out undo.json`. It arrives before the notes change,
so an interrupted write is still recoverable. Apply it to put everything back.

Two things to know about the write path:

- It goes through the file rather than the TaskNotes API, so `dateModified` is not
  updated. Obsidian's watcher re-indexes the change like any external edit.
- Clearing a key blanks its value rather than deleting the line. `scheduled:` with
  nothing after it reads back as no date, which is exactly how TaskNotes writes one.

### The one error you may deliberately accept

Undoing a change that broke a dependency cycle necessarily puts the cycle back, and a
new cycle is a blocking error. Pass `--allow-cycles` / `allowCycles: true` **only** for
that case. It waives cycle errors and nothing else; a proposal with a bad id or an
unparseable date is still refused, because writing an operation that did not apply
would commit a change set nobody described.

---

## Scheduling from scratch

```
tng schedule --project "PRJ-06" --start 2026-05-04 --out proposal.json
tng schedule --initiative "Company Growth" --deadline 2026-06-30
tng schedule --project "PRJ-06" --start 2026-05-04 --level --resource contexts
```

Give `--start` to lay work out forward, or `--deadline` to work back from a date it
must be finished by — not both. It emits a proposal and writes nothing, so its output
goes through `validate` and `apply` like anything you wrote yourself.

**Read the notes it returns before trusting the dates.** They say where the plan rests
on a guess:

```
- Levelled against `contexts` over 1 resource(s); settled after 18 rounds.
- Each task keeps the length it has now — the span between its dates, or its estimate
  where it has no span. This lays the work out again; it does not re-estimate it.
- 3 task(s) are currently scheduled entirely on non-working days, so their spans
  measure as zero working time. Their estimates were used instead.
- 4 dependency conflict(s) remain, all involving a task this pass left alone.
- 2 task(s) are in a circular dependency and were not scheduled.
- 9 finished task(s) were left where they are.
```

What it will not do:

- **It will not move finished work.** Rescheduling history would rewrite the record of
  when the work actually happened. Conflicts involving a done task therefore survive a
  clean layout, and the notes say how many.
- **It will not schedule a task inside a cycle**, because such a task has no earliest
  start. Break the cycle first.
- **It will not re-estimate.** A task with a three-day window and a two-hour estimate
  keeps its three days. If you want it shorter, propose a `set_dates` yourself.

A backward pass schedules into the past rather than clamping, because whether the
deadline is reachable at all is the thing worth knowing:

```
This deadline needs work to have started on 2026-04-16, which is 102 working day(s)
before 2026-09-07. The deadline cannot be met without cutting scope or shortening
estimates.
```

`--level` pushes work off days a resource is over capacity, lowest priority and most
slack first. It needs a field the vault actually fills in — check the snapshot's Load
section, and pass `--resource contexts` (or whatever is populated) rather than relying
on the default. If nothing carries the field it says so instead of reporting success.

---

## Four jobs, and how to do them

### Repair a plan

```
tng doctor --initiative "Company Growth"
# or: gantt_snapshot { "initiative": ["Company Growth"], "summary": true }
```

Conflicts, cycles, dangling links, missing estimates and any note that could not be
read at all — without the task table. Then:
break any cycle first (a cycle excludes its members from scheduling entirely, so
everything downstream of it is unmeasured), then resolve conflicts by moving the
successor later — moving a predecessor earlier rewrites a date somebody chose for
reasons the dependency graph cannot see.

For conflicts specifically, `tng schedule --start <today>` scoped to the affected
project resolves all of them at once and is usually a better answer than a hand-written
proposal, as long as you read its notes.

### Schedule from scratch

Snapshot for context, `schedule` for the layout, `validate` to confirm, `apply` to
write. Report the notes from `schedule` alongside the dates — a plan whose lengths came
from a default duration is a placeholder, and the person deserves to know which parts
those are.

### Answer a question

Most questions are answered by a snapshot alone, and `--summary` (or `summary: true`)
omits the task table when you only need the shape of the plan. The critical path
section answers "what determines the end date". The float column answers "what can
slip". The Load section answers "who is overloaded".

If a question is about a change — *what has to move for the relaunch to ship by June* —
answer it with `schedule --deadline` and a `validate`, not by reasoning about dates in
your head. The tools do the arithmetic correctly and you do not have to be right about
working days.

### Triage and prioritise

The snapshot carries status, priority, float and the critical path. Float is the number
that matters most for ordering: a task with zero float delays the whole plan if it
slips, and one with twenty days of float does not. Priority is the human's opinion;
float is the plan's. When they disagree, say so — that is usually the useful finding.

---

## Details that have caught people out

- **`P2D` as a lag means 2880 minutes of working time** — six working days on an
  eight-hour day, not two. Write `PT16H` if you mean two working days. This is
  consistent across the chart and the tools, so it is a thing to know rather than a bug
  to route around.
- **A schedule works in whole working days.** An all-day `scheduled` reads back as the
  start of a working day and an inclusive `due` as the end of one, so anything finer
  would contradict itself the moment it was written and read again.
- **Durations, floats and overlaps are in working days.** "Too early by 5d" means five
  working days. `0d` means the order is wrong but the overlap falls entirely on
  non-working days, so no actual work collides.
- **A task scheduled Saturday to Sunday has a span of zero working time.** The
  scheduler falls back to its estimate and says so; do not read a zero-length bar as a
  milestone.
- **A milestone is a task with a zero estimate**, drawn as a point. Give it
  `set_estimate: 0`, not a same-day start and end.
- **Archived tasks are excluded by default** from every command. Pass `--all` when you
  genuinely want them.

---

## A worked example

```bash
# 1. See the shape of it.
tng doctor --project "PRJ-06"
#    -> 2 tasks scheduled before a dependency allows.

# 2. Ask for a layout that resolves them.
tng schedule --project "PRJ-06" --start 2026-05-04 --out /tmp/p.json
#    -> 16 of 16 tasks would move. Read the notes.

# 3. Check it before believing it.
tng validate --project "PRJ-06" --file /tmp/p.json
#    -> can be applied. conflicts 2 -> 0.

# 4. See exactly which files and keys would change.
tng apply --project "PRJ-06" --file /tmp/p.json
#    -> Dry run. Nothing was written.

# 5. Write it, keeping the undo.
tng apply --project "PRJ-06" --file /tmp/p.json --write --undo-out /tmp/undo.json
#    -> Wrote 16 notes.

# If it was wrong:
tng apply --project "PRJ-06" --file /tmp/undo.json --write
```

Same scope at every step. That is not a stylistic preference — it is what makes the ids
in step 5 mean what they meant in step 1.
