# User guide

TaskNotes gives every task a note, real dates and real dependencies. This plugin draws
the plan those fields already describe, and lets you change it by dragging.

- [Getting started](#getting-started)
- [Reading the chart](#reading-the-chart)
- [Filtering and grouping](#filtering-and-grouping)
- [Editing the plan](#editing-the-plan)
- [Critical path and conflicts](#critical-path-and-conflicts)
- [Capacity](#capacity)
- [Baselines and progress](#baselines-and-progress)
- [Export](#export)
- [Keyboard and touch](#keyboard-and-touch)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)

## Getting started

**Requirements:** Obsidian 1.10.0 or later, and TaskNotes 4.12 or later for editing.
Older TaskNotes versions, or TaskNotes disabled, give you a read-only chart.

There are two ways to open a chart.

**The standalone tab** — the Gantt icon in the ribbon, or the command **Open chart**.
It covers the whole vault and has its own filter bar. Use it for planning across
projects.

**A Bases view** — open any `.base` file and switch its view type to **Gantt**. It
inherits that base's filters, formulas and saved views, so a board you already use as a
Kanban can be looked at as a timeline without configuring anything. Use it when you
want a chart of a query you have already written.

Per-view options — grouping, sort, timescale, dependency lines and arrowheads — are
stored in the `.base` file, so two Gantt views of different bases can be configured
differently without affecting each other.

## Reading the chart

### Bars

| Appearance | Meaning |
| --- | --- |
| Solid bar | Both `scheduled` and `due` are set. This is a real plan. |
| Hollow, dashed bar | At least one date was **inferred**. Nothing in the note says this. |
| Diamond | A milestone: `timeEstimate: 0`, or the same start and end date. |
| Red bar with a warning | `due` falls before `scheduled`. Only you know which is wrong. |

Bar colour comes from **your** TaskNotes statuses, so a chart matches the colours on
your Kanban board.

A bar is drawn across the whole days it covers. A task scheduled and due on the same
date occupies one full day column, not the eight working hours it literally spans —
otherwise it would be an invisible sliver.

### Inferred dates

Most vaults are not fully scheduled. Where a date is missing, the chart works one out:

- **`due` but no `scheduled`** — the start is calculated backwards from `timeEstimate`.
- **`scheduled` but no `due`** — the end is calculated forwards from `timeEstimate`.
- **Neither** — the bar is anchored at today.
- **No `timeEstimate` either** — the default duration from settings is used.

These bars are drawn hollow and dashed, and their dates appear dimmed and italic in the
grid, because a guess should never look like something you decided. Dragging one is how
it becomes real: the guess is the starting point, and the drag writes actual dates to
the note.

### The rest of the chart

- A **red vertical line** marks today.
- **Weekends** are shaded, at day and week zoom.
- **Group rows** carry a grey summary bar spanning everything inside them.
- A task belonging to two projects appears under both, with a **link icon** so the
  repetition reads as one task shown twice.
- A group whose project note does not exist gets a **warning triangle**. Its tasks are
  still shown — losing work because a link is broken would be worse than the broken
  link.
- A task whose bar is off screen gets a **small arrow** at that edge of the timeline,
  in its status colour. Click it to scroll there.

## Filtering and grouping

The filter row narrows the chart to what you care about.

- The **search box** matches task names.
- Each **facet menu** — project, status, priority, context, tag, assignee, and every
  user field you have defined in TaskNotes — selects values to keep.

Values within one facet are ORed; facets are ANDed. So *the in-progress and up-next
tasks, on these two projects, under the Company Growth initiative* is three facets,
each narrowing the last.

Each menu shows how many tasks a value would give you, counted against the **other**
facets — the number tells you what selecting it would actually do now. A value that
would return nothing is not listed. Absence is selectable: **No project** finds tasks
nobody has filed, **No initiative** finds the ones with that field blank.

**Grouping** is separate from filtering. Group by project, status, priority, context or
assignee, or turn it off for a flat list.

Every group has a **checkbox** to switch it out of the chart, and the toolbar has one
button to **collapse or expand every group** at once. A switched-off group keeps its
header, greyed, so you can switch it back on.

Filters, hidden groups and collapse state all persist across reloads.

## Editing the plan

| Gesture | Effect |
| --- | --- |
| Drag a bar | Move both dates by the same number of days |
| Drag its left edge | Change `scheduled` only |
| Drag its right edge | Change `due` only |
| Shift-drag between bars | Create a dependency |
| Double-click | Open the task note |
| Ctrl/Cmd + scroll | Zoom the timescale |
| Click an edge arrow | Scroll to a task that is off screen |

Drags snap to whole days.

**Dependencies.** The relation type comes from which ends you drag between: right to
left is finish-to-start, left to left is start-to-start, and so on — all four ICS types
are supported. A link that would create a circular dependency turns the line red and is
refused before anything is written.

### Safety

Editing writes to your real notes, so there are three gates:

- **Safe mode** makes the whole chart read-only. Toggle it from the command palette or
  settings. A banner tells you when it is on.
- **Confirmation** for any change touching more than the threshold number of tasks
  (default 10). The dialog lists every edit, not just a count.
- **Undo last change** reverts the previous change exactly, including a cascade. Undoing
  a drag that invented dates removes them again rather than leaving the guess behind.

All date changes go through TaskNotes' own API, so it keeps `dateModified`, its caches
and its other views correct.

## Critical path and conflicts

Turn on **Highlight the critical path** (the ⚡ button) to outline the chain that
determines each project's end date, and to add a **Float** column showing the working
days a task can slip before it delays that end.

Float is measured **per connected group of dependencies**, not across the whole vault.
A vault is usually many independent plans, and measuring an April chain's slack against
an August deadline it has nothing to do with would make float meaningless. A task with
no dependencies at all is never called critical — being alone in a network of one is
not information.

**Conflicts.** A task scheduled before something it depends on has finished gets a red
marker and appears in a banner. This is checked against the dates in your notes,
separately from the critical path calculation, so it reports what you wrote rather than
what the maths would prefer.

The banner offers **Reschedule them**. Each task is pushed forward to the earliest date
its dependencies allow, and the change propagates — so fixing 23 conflicts may move
more than 23 tasks, because moving one pushes what follows it. Nothing is ever moved
*earlier*: the complaint is that a task starts too early, and pulling something back to
meet it would rewrite a date nobody questioned.

It goes through the ordinary write gates — safe mode blocks it, the dialog lists every
edit, and one undo reverses the lot.

**Circular dependencies** are detected, excluded from scheduling, and named in a banner.
Nothing else surfaces these, and they are silent deadlocks: two tasks each blocked by
the other can never start.

The banner offers **Break the loop**, which removes one dependency from each circular
chain. It picks the entry the dates contradict most — where the predecessor finishes
furthest after the successor starts. In a two-task deadlock the task scheduled first is
almost never the one that genuinely waits, so the entry claiming it does is the error.

This always asks first, whatever your confirmation threshold, and names exactly which
dependency goes. Deleting one destroys a statement about the work, and no heuristic
should do that unasked.

**Cascade** (the → button, off by default) makes a drag also push the tasks that depend
on the one you moved. Successors are only ever pushed *later*, never pulled earlier — a
gap between two tasks is usually deliberate, and the dependency graph cannot know why.

## Capacity

The 📊 button adds a daily load histogram beneath each group: how many working minutes
that group is carrying each day, against the capacity you set. Days over capacity are
red, and a dashed line marks the limit.

Load comes from `timeEstimate`, spread across the working days each bar covers in
proportion to the hours available on each. **Tasks with no estimate contribute nothing**
and are counted in a banner — inventing a number would make the chart look
authoritative while being fiction.

The **Unassigned** bucket is never flagged as over capacity. It holds every task nobody
owns, and measuring that pile against one person's working day reports arithmetic, not
information. Give it an explicit override if you do want it checked.

Set **Resource property** (default `assignee`) and per-resource capacity in settings —
`Team = 1920` for a team of four, for instance.

It does not have to be a person. `contexts`, `projects`, `tags`, `status`, `priority`
or any property of your own all work, and whichever you pick is used consistently: the
load chart measures it, the resource grouping groups by it, and the filter bar offers a
facet named after it.

A banner above the chart says which property is in use and how many tasks carry a value
for it. If none do — the default `assignee` in a vault where nothing is assigned — it
says so and points at the setting, because otherwise "nothing is over capacity" and
"there is nothing to measure" look identical.

### Levelling

When a resource is over capacity, a banner offers to **Level them**. It pushes the
least important task with the most slack off each overloaded day, repeating until
nothing is over capacity.

Three things it will not do:

- **It never moves a task earlier.** Closing a gap is a different decision, made for
  reasons the capacity numbers cannot see. The problem being solved is a day that is
  too full.
- **It never leaves a dependency broken.** Pushing a task past its successors is what a
  naive levelling pass does; after each round this one pushes whatever it displaced by
  the least amount that restores the constraint.
- **It never fixes a conflict it did not cause.** A task that already contradicted its
  dependencies stays where it is — that is what **Reschedule them** is for, and a click
  labelled "level resources" should not quietly rewrite dates about something else.

It goes through the same gates as every other write: safe mode blocks it, anything over
the confirmation threshold lists every change first, and one undo reverses the lot.

The banner only appears while the load chart is on, because a button that fixes a
problem you cannot see is a trap.

## Charts inside a note

A fenced `tngantt` block draws a live chart wherever you put it — which is what to do
with a project note that has been carrying a hand-drawn timeline.

````markdown
```tngantt
project: PRJ-01 Website Relaunch
zoom: week
height: 320
groupBy: none
```
````

Filters are the same ones the filter bar offers: `project`, `status`, `priority`,
`context`, `tag`, `assignee`, and any user field your TaskNotes setup defines
(`initiative:` in the reference vault). Comma-separate for several values, and use
`none` for the "no project" bucket. `text:` searches titles.

A project is matched by any part of its name, so `project: Relaunch` finds
*PRJ-01 Website Relaunch*. If a name exactly matches one project, only that one is
used.

Display options: `zoom` (day, week, month, quarter), `groupBy`, `sort`, `height`,
`rowHeight`, `gridWidth`, and the toggles `dependencies`, `arrowheads`, `critical`,
`violations`, `completed`, `archived`, `capacity`, `baseline`.

The chart is **read-only** unless you add `editable: true`. An embedded chart is
usually being read rather than edited, and a stray drag would rewrite a date in a note
you were only scrolling past.

If a line cannot be read — a misspelt option, or a filter matching no task — the block
says so in place of the chart rather than quietly drawing the wrong thing.

## Baselines and progress

**Set baseline for all tasks** snapshots where every task currently sits. Each bar then
carries a thin grey baseline beneath it, and the grid gains a **Δ** column showing
working days later (+) or earlier (−) than that snapshot. **Clear baseline from all
tasks** removes it.

Baselines are only ever written when you ask. Re-taking one automatically on every edit
would destroy the thing it exists to measure.

They live in your task frontmatter under `ganttBaselineStart` and `ganttBaselineEnd`
(renameable in settings). Those are this plugin's own properties, not TaskNotes', so
they are written directly rather than through its API — which is also why they survive
if you uninstall this plugin.

**Progress** shading comes from the first source that can answer:

1. The status is flagged complete → 100%
2. Body checklist items
3. Time tracked against the estimate
4. Position in your status list

A task where none of those know anything shows **no** progress rather than 0% —
"nothing recorded" and "no work done" are different claims. You can change which source
is tried first in settings.

## Export

**Export chart** saves what is currently on screen into your vault.

| Format | Use |
| --- | --- |
| SVG | Vector; scales and prints cleanly, task names are real text |
| PNG | A picture, for somewhere that cannot show SVG |
| CSV | The table behind the chart, with float, baseline and variance |
| Mermaid | A fenced ` ```mermaid ` block — Obsidian renders it, so a project note gets a live timeline |

Exports respect the current filter, so an export contains what you were looking at.

The CSV marks which dates were inferred, so a spreadsheet built from it cannot mistake
a guess for something you entered.

## Keyboard and touch

The chart is fully operable without a pointer. Click it, or tab to it, then:

| Key | Effect |
| --- | --- |
| ↑ / ↓ | Move between tasks |
| Home / End | First / last task |
| ← / → | Pan the timeline |
| Shift + ← / → | Move the focused task by a day |
| Alt + ← / → | Change the focused task's due date by a day |
| Enter | Open the task note, or collapse a group |

On a touch screen, pinch to zoom the timescale.

## Settings reference

### Editing

| Setting | Default | What it does |
| --- | --- | --- |
| Safe mode | off | Makes the chart read-only |
| Confirm changes above | 10 | Ask before a change touching more tasks than this |

### Working calendar

| Setting | Default | What it does |
| --- | --- | --- |
| Working days | Mon–Fri | Days that carry working hours |
| Working day | 09:00–17:00 | Used to turn estimates into spans |
| Holidays | none | Extra non-working dates, `YYYY-MM-DD` per line |

### Dates and durations

| Setting | Default | What it does |
| --- | --- | --- |
| Due date is inclusive | on | A task due the 16th finishes at the end of the 16th |
| Default duration | 480 min | Span for a task with a date but no estimate |

### Dependencies

| Setting | Default | What it does |
| --- | --- | --- |
| Show dependency lines | on | The connectors between tasks |
| Show arrowheads | on | The heads on their ends |

### Scheduling

| Setting | Default | What it does |
| --- | --- | --- |
| Highlight the critical path | off | Outline the critical chain, add a Float column |
| Flag dependency conflicts | on | Mark tasks scheduled too early |
| Cascade dependents | off | Dragging a bar also pushes what depends on it |

### Baseline and progress

| Setting | Default | What it does |
| --- | --- | --- |
| Show baseline | on | Ghost bar and Δ column |
| Baseline properties | `ganttBaselineStart` / `ganttBaselineEnd` | Where baselines are stored |
| Progress source | Status | Which signal is tried first |

### Capacity

| Setting | Default | What it does |
| --- | --- | --- |
| Show load histogram | off | Daily load bar chart per group |
| Capacity per day | 480 min | Working minutes a resource absorbs per day |
| Capacity overrides | none | `Name = minutes`, one per line |

### Appearance, grouping and export

| Setting | Default | What it does |
| --- | --- | --- |
| Row height | 28 px | |
| Resource property | `assignee` | Property the load chart, resource grouping and levelling measure against |
| Show archived tasks | off | |
| Export folder | vault root | Where exports are saved |

## Troubleshooting

**Run the data report first.** The command **Write data report** creates a note
describing everything the plugin can see: task counts, date coverage, dependency types,
dangling links and cycles. Most questions below are answered by it.

**A task is missing.** Check that it carries your TaskNotes task tag (`#task` by
default), is not in an excluded folder, and is not filtered out — the banner reports how
many tasks the filter is hiding. Archived tasks are hidden unless you turn them on.

**A task has a name but no bar.** Its bar is off screen. Look for the small arrow at the
left or right edge of its row and click it.

**The chart says read-only.** Either safe mode is on, or the plugin could not reach
TaskNotes' API. The banner says which. Without the API the chart still renders from your
vault, but nothing can be edited.

**My `blockedBy` entries changed format.** TaskNotes accepts two shapes — a bare
`"[[link]]"` and a `{uid, reltype}` mapping — and its own serializer normalizes to the
second whenever it writes a task. So the first time you edit a task that used the bare
form, those entries get rewritten. No dependency is lost; only the formatting changes.
This is TaskNotes' behaviour, not this plugin's.

**Bars look a day out.** Check **Due date is inclusive**. On, a task due the 16th
finishes at the end of the 16th; off, at the start of it.

**A project group shows a warning triangle.** The project note that tasks link to does
not exist. The tasks are still shown — either create the note or fix the links.

**A banner reports a circular dependency.** Two or more tasks each block the other, so
none can start. Open the named tasks and remove one of the `blockedBy` entries.
