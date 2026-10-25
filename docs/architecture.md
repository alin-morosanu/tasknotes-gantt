# Architecture

About 10,000 lines of TypeScript across 41 source files, with 362 unit tests. This
document covers the shape of the code and the decisions that are not obvious from
reading it.

- [The core principle](#the-core-principle)
- [Module map](#module-map)
- [The data pipeline](#the-data-pipeline)
- [Load-bearing invariants](#load-bearing-invariants)
- [Rendering](#rendering)
- [The two views](#the-two-views)

## The core principle

**Pure core, effectful shell.** Every scheduling algorithm is a pure function over
plain data with no Obsidian import. Only the bridge, adapter and UI layers touch the
app.

This is not stylistic. It is what makes the hard parts — critical path, working-time
arithmetic, cascade, capacity — testable at all. A Gantt's correctness lives in
arithmetic that is tedious to verify by looking at pixels, and every real bug found
during development was caught by a unit test or by running the model over the real
vault, never by staring at the chart.

The layering rule: `model/` imports only from `model/` and `types.ts`. `render/` may
import `model/`. `data/` and `bridge/` may import `model/`. `ui/` may import anything.
Nothing imports upward.

## Module map

```
src/
  types.ts              Pure data contracts. No imports.
  main.ts               Plugin entry: registration, commands, wiring.
  diagnostics.ts        The "Write data report" artifact.

  bridge/               Everything that touches TaskNotes.
    tasknotes-api.ts    Structural types for TaskNotes' runtime API.
    tasknotes.ts        Discovery, capability negotiation, graceful degradation.
    catalog.ts          Statuses, priorities, field mapping, task identification.
    events.ts           Change subscription with echo suppression.
    writer.ts           EVERY date mutation. Safe mode, confirm, undo.
    frontmatter.ts      Fields this plugin owns, written directly.

  data/
    normalize.ts        Raw frontmatter -> GanttTask. Pure.
    adapter-vault.ts    Reads from the metadata cache.
    adapter-bases.ts    Reads from Bases query results.

  model/                All pure. All unit tested.
    dates.ts            Parsing, formatting, DST-safe day arithmetic.
    calendar.ts         Working days, hours, holidays; working-time arithmetic.
    geometry.ts         Dates -> bars, including inference.
    graph.ts            Edges, cycles, topological order, components.
    constraints.ts      The four ICS relation types as bounds.
    schedule.ts         Critical path: forward/backward passes, float, violations.
    reschedule.ts       Drag -> reversible patches; cascade.
    resource.ts         Reads the configurable resource property off a task.
    capacity.ts         Per-resource daily load; levelling proposals.
    progress.ts         Progress resolution chain.
    baseline.ts         Baselines and variance.
    filter.ts           Facets, matching, counts.
    autofix.ts          Proposals for conflicts and cycles. Preview-only.
    levelling.ts        Push work off over-capacity days, dependency-safe.

  render/               Pure geometry plus one canvas painter.
    timescale.ts        Time <-> pixels, ruler ticks.
    layout.ts           Tasks -> rows; virtualization.
    canvas.ts           The painter, hit-testing, edge routing.
    theme.ts            Obsidian CSS variables -> a concrete palette.

  ui/                   The effectful shell.
    controller.ts       State, orchestration, interaction. The largest file.
    view-standalone.ts  ItemView.
    view-bases.ts       BasesView.
    grid.ts             The task list beside the chart.
    view-embed.ts       A chart inside a note, from a ```tngantt``` block.
    toolbar.ts filter-bar.ts confirm-modal.ts export-modal.ts

  export/               svg, png, csv, mermaid.
  settings/             Defaults, migration, settings tab, code-block config.

  agent/                Pure. Shared by the plugin and the headless CLI.
    ids.ts              Stable short ids (BEL-0002) with collision handling.
    snapshot.ts         Tasks + schedule + capacity -> AgentSnapshot.
    brief.ts            AgentSnapshot -> compact markdown.
    proposal.ts         Proposal parsing and reference resolution.
    simulate.ts         Apply a proposal to an in-memory copy. Writes nothing.
    diff.ts             Before/after: errors, regressions, improvements.
    autoschedule.ts     Lay out a schedule forward, backward, or levelled.

cli/                    Node only. Never imported by the plugin bundle.
  vault.ts              Read a vault from disk, the counterpart to adapter-vault.
  identify.ts           Task identification, shared with the plugin.
  frontmatter.ts        Surgical YAML key edits, in place.
  apply.ts              Simulated result -> file writes plus the inverse proposal.
  session.ts            Scope, snapshot, evaluate, plan. The pipeline both doors run.
  index.ts              Argument parsing and dispatch.

mcp/
  server.ts             Four tools over cli/session.ts.
  main.ts               serveStdio entry.
```

`cli/` and `mcp/` are separate esbuild entries producing `bin/tng.mjs` and
`bin/tng-mcp.mjs`. `yaml`, `zod`, the MCP SDK and `node:fs` must never enter the plugin
bundle, which is why the split exists at all.

**`cli/session.ts` is the reason the two front doors cannot disagree.** The CLI maps
flags onto it and the MCP server maps tool arguments onto it; neither reasons about a
vault on its own. When `apply` writes, it writes the very simulation whose consequences
`validate` printed — there is no second implementation of what an operation means.

The MCP server re-reads the vault on every call. A cache would be faster and would
eventually answer from a plan that no longer exists on disk, which is the one failure
this whole design exists to prevent. Reading 1361 notes costs about 0.2 seconds.

## The data pipeline

```
TaskNotes API or metadata cache
  -> normalize.ts        raw frontmatter becomes GanttTask
  -> filter.ts           the visible set is chosen
  -> progress.ts         progress is resolved
  -> geometry.ts         bars are derived, dates inferred where missing
  -> graph.ts            edges built, cycles detected
  -> schedule.ts         critical path and conflicts
  -> capacity.ts         daily load per group
  -> layout.ts           rows built, grouped, sorted
  -> canvas.ts           painted
```

**Filtering happens early, before geometry and scheduling.** So the critical path, the
load histogram and every export describe the visible set rather than quietly including
work the user filtered away. A CSV exported while filtered contains what was on screen.

## Load-bearing invariants

These are the things that will break if changed carelessly. Each was a real bug.

### Bars carry two extents

`Bar.startMs`/`endMs` are the true working-time instants; every duration, float and
variance calculation uses them. `Bar.displayStartMs`/`displayEndMs` are snapped out to
whole days and are what the canvas draws.

A task scheduled and due on the same date spans 09:00–17:00 — a third of a day column,
which is a 1–2px sliver at month zoom and invisible below it. Drawing the day-snapped
extent makes a one-day task read as one day. Conflating the two would either make short
tasks invisible or make a one-day task report three days of duration (24h ÷ 8h).

Endpoints the author gave an explicit time to are never widened.

### Writes go to two different places

| Field class | Examples | Written via |
| --- | --- | --- |
| TaskNotes-owned | `scheduled`, `due`, `blockedBy` | `api.tasks.*` |
| This plugin's own | `ganttBaselineStart`, `ganttBaselineEnd` | `processFrontMatter` |

Using the API for TaskNotes' fields gets `dateModified` maintenance, field-mapping
respect, cache invalidation and event emission for free. Using it for fields that are
not in its mapping would be meaningless — it has no opinion about them.

### Our own writes must not echo back

A write emits `task.updated`, which triggers a re-render, which can yank the bar out
from under a drag in progress. `GanttWriter` tags every mutation with a correlation id
and `TaskNotesEvents` drops matching events.

It **also** tracks touched paths on a 2.5 second window, because TaskNotes is not
guaranteed to return our `context` in the payload. That belt-and-braces is deliberate:
the assumption could not be verified from the bundle.

### The critical path is per component

The forward and backward passes run over **weakly-connected components** of the
dependency graph, each with its own end date.

Scheduling a whole vault as one network makes the backward pass cap every chain at the
latest task anywhere. On the reference vault that produced **2 critical tasks out of
165, with a median float of 293 days** — an April chain measuring its slack against an
August 2027 deadline it had nothing to do with. Per-component gives 64 of 165 critical
and a median float of 0.

A task with no dependencies is never critical: trivially so in a network of one, which
is noise rather than information.

### Two different questions about the schedule

The CPM passes answer *what does the dependency network imply*. The violation check
answers *does the plan as written contradict its own dependencies*, and compares the
**planned** bars, not the computed early dates.

Conflating them would either hide conflicts the maths silently resolved, or report
ordinary slack as an error.

### Absence is not zero

- A task with no progress signal reports `null`, not `0`. "Nothing recorded" and "no
  work done" are different claims.
- A task with no `timeEstimate` contributes nothing to capacity, and the count of such
  tasks is surfaced, rather than inventing a number that would make the histogram look
  authoritative while being fiction.
- The Unassigned capacity lane is unbounded unless given an explicit override. Measuring
  141 unowned tasks against one person's working day reports a 38-hour day.

### Working-time arithmetic must terminate

`normalizeCalendar` repairs a calendar with no working days or an inverted day window,
and every walker is bounded. A user can switch every weekday off; the UI must not hang.

### Dependency arrows are orthogonal, and route near the target

Right angles only. The vertical run sits just **before** the target, so the long
horizontal travels along the source's row — empty to the right of its own bar — rather
than along the target's row, where it would cross the target bar before reaching the
arrowhead.

Back-to-back bars get a midpoint step rather than the backward detour: a full stub each
side needs 22px, and a task starting the day after its predecessor has about two.

The test that pins this asserts every segment of every route is horizontal or vertical.

### One reader for the resource property

The resource axis is a property name the user chooses, and three places resolve it: the
load histogram, the filter facet, and the resource grouping. Each once read
`task.extra[field]` on its own — correct only for properties TaskNotes does not map.
Choosing `contexts`, the field most tasks in the reference vault actually carry, made
capacity work and left the other two silently empty: one lane, one facet with no
values, one ungrouped lump.

`resourceValuesOf` in `model/resource.ts` is now the only reader, so a chosen property
either works everywhere or nowhere. Each caller applies its own empty-bucket sentinel
on top — `UNASSIGNED`, `NO_VALUE`, `UNGROUPED` — because those three mean different
things to their own layers.

### Levelling is a loop, and it is push-only

`planLevelling` picks one victim per overloaded day. Running it once trades an overload
for a set of dependency conflicts, because the task it pushed has moved past its own
successors. So `planLevellingRun` loops: level, restore dependency order, measure
again. The headless scheduler learned the same lesson independently in `autoschedule`.

Two constraints keep it honest. It only ever pushes tasks **later**, because a gap is
usually deliberate and the problem being solved is a full day. And it only restores
dependencies for tasks whose predecessors actually moved — a conflict that predates the
run belongs to `planConflictFixes`, and fixing it here would mean a click labelled
"level resources" rewrote dates about something else. On the reference vault that
distinction is the difference between moving 45 tasks and moving 11.

Every patch is built against the task's **original** bar with a cumulative day delta,
never composed from intermediate ones, or `inverse` would restore a position that never
existed and undo would land somewhere the user has never seen.

### Durations and overlaps are working time

Every figure a reader might act on — a task's duration, a conflict's magnitude, float —
is measured in **working** minutes, not elapsed ones. Dividing wall-clock time by the
length of a working day inflates everything by roughly three and is wrong in a way that
looks plausible: a Saturday-to-Monday task read as seven working days, and a task ten
working days early was reported as forty.

Zero is a legitimate answer. Two tasks on the same closed weekend, one waiting on the
other, overlap by no work at all — but the order is still contradictory, so the
violation is reported with a magnitude of `0d` rather than dropped.

### A generated schedule works in whole working days

An all-day `scheduled` reads back as the start of that working day, and an inclusive
`due` as the end of one. A schedule computed to the minute would therefore contradict
itself the moment it was written and read again: a task finishing Tuesday 13:00 is
stored as "due Tuesday", comes back as Tuesday 17:00, and its successor — placed at
13:00 — is now too early. Whole working days is the only granularity that survives the
round trip.

For the same reason `autoschedule` takes a task's duration from the working length of
its **current bar**, exactly as `computeSchedule` does, rather than from `timeEstimate`.
Laying a plan out again is not the same as re-estimating it. The one exception is a
span containing no working time at all — several tasks in the reference vault are
scheduled Saturday to Sunday — where the estimate answers instead, because a zero-length
task lets its finish-to-start successor start the same morning.

### Clearing a key blanks it rather than deleting it

By the time a clear reaches the file, nothing records whether the key was blank before
the change or created by it. Blanking leaves an empty line behind in the second case;
deleting destroys a blank key the author wrote in the first. Blank `scheduled:` and
`due:` keys are common in a TaskNotes vault and created keys are not, so blanking loses
less. An empty value reads back as absent, so the difference is cosmetic — but only one
of the two rules can lose a line somebody wrote.

### An undo must be applicable

Breaking a dependency cycle is a legitimate change, and so is undoing it — but undoing
it necessarily puts the cycle back, and a proposal that creates a cycle is a blocking
error. Without a way through, every `--undo-out` file from a cycle-breaking apply would
be permanently unapplicable, which is worse than useless: it looks like a safety net
and is not one.

So the cycle error carries `kind: 'cycle'`, and `apply --allow-cycles` accepts errors
of that kind and no other. Parse and simulation errors stay absolute: when an operation
did not apply, writing would commit a change set nobody described.

## Rendering

**Canvas plus a sparse DOM overlay.** The canvas paints grid, bars, arrows and
histograms in one culled pass per animation frame. A DOM node per bar dies at a few
hundred rows; this handles thousands.

What DOM does carry:

- The **task grid** — virtualized rows, sharing the canvas's row height exactly so the
  panes stay aligned at any scroll position.
- The **scroll layer**, which sits *above* the canvas and owns both scrolling and
  pointer input. Listeners belong there; a listener on the canvas beneath it never
  fires.
- An **off-screen `role="grid"` mirror** of the visible rows. Canvas is invisible to
  assistive technology, so without this the chart would be unusable with a screen
  reader.

Colours come from Obsidian CSS variables resolved once per render, since canvas cannot
use them directly. Status colours come from the user's TaskNotes catalog, never
hardcoded.

## The two views

Both construct the same `GanttController` and differ only in their data adapter and
chrome.

`GanttStandaloneView` reads the whole vault and owns the filter bar and toolbar.

`GanttBasesView` extends Obsidian's `BasesView`, so a `.base` file's filters and
formulas decide which rows arrive. Registration retries, because the core Bases plugin
may load after this one.

**Each view owns its own settings object.** The Bases view used to write per-view
options straight into the shared plugin settings, so opening a second Gantt silently
reconfigured the first.
