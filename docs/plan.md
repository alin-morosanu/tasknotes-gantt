> **Historical.** This is the plan written before implementation began, kept for
> the record. It is not maintained, and several decisions in it were changed once
> the model met real data — see [architecture.md](architecture.md) for what was
> actually built and why.

# TaskNotes Gantt — Implementation Plan

## Context

`the project folder` is empty. The goal is a new, professional-grade Obsidian plugin that adds project *planning* to TaskNotes — the layer TaskNotes deliberately does not have.

The need is concrete and visible in the vault. The reference vault's `TaskNotes/` holds 166 real task notes across 18 project notes, and those project notes contain **hand-drawn ASCII timelines** like this one in `TaskNotes/Projects/PRJ-01 Website Relaunch.md`:

```
Apr 13 ──── Apr 14 ──── Apr 15 ──── Apr 16 ──── Apr 17
  │            │           │           │           │
  ├─ BEL-0001  └─ BEL-0002 └─ BEL-0003 └─ BEL-0004 └─ BEL-0006
```

That artifact is the requirement statement. The data to render it properly already exists — 147 tasks carry `blockedBy` dependencies with real `FINISHTOSTART` relation types, 143 carry `timeEstimate` in minutes, 165 carry `due`/`scheduled` — but nothing in the ecosystem draws it, computes a critical path from it, or tells you that Avery is booked 14 hours on a Tuesday.

**Intended outcome:** a Gantt surface that (a) schedules and sequences work by dragging, writing real dates back into TaskNotes; (b) shows resource load against capacity; (c) tracks the plan against a baseline over time.

### What the research established

Three findings drive the entire architecture, all verified first-hand against the installed builds:

1. **TaskNotes 4.12.5 ships a first-class, versioned, in-process runtime API designed for companion plugins.** Confirmed in the installed bundle (`plugin.api = new VL(plugin)`, `apiVersion = 1`, `hasCapability()`). It exposes `tasks.*` (read/write/dependencies), `relationships.*`, `query.tasks`, `catalog.*` (statuses, priorities, user fields), `settings.snapshot`, a 30-event `events.on` bus (`task.scheduled.changed`, `task.due.changed`, `task.dependencies.changed`, …), `lifecycle.ready()`, typed errors, and `extensions.register` for namespacing a companion plugin. **We never hand-parse or hand-write TaskNotes frontmatter.**
2. **Obsidian 1.13's `Plugin.registerBasesView()` is public API** — verified in the locally installed `obsidian@1.13.1` typings (`obsidian.d.ts:5009`, `BasesView` at :1105, `BasesViewRegistration` at :1254, all `@since 1.10.0`). TaskNotes itself uses it for `tasknotesTaskList` / `tasknotesKanban` / `tasknotesCalendar` / `tasknotesMiniCalendar`. Registering `tasknotesGanttChart` alongside them means **the Gantt inherits every filter, formula and saved view in the user's existing `.base` files for free** — and the user's daily driver is already a Bases kanban pinned in the left sidebar.
3. **The vault's data is sparse and inconsistent in specific, known ways** that must be designed for, not discovered later:
   - `blockedBy` exists in **two incompatible shapes in the same vault** — a bare list of `"[[link]]"` strings *and* a list of `{uid, reltype}` objects. Both must parse.
   - 41 tasks have no `scheduled`; 12 have `due` only; 20 have neither. Empty-string values (`scheduled:`) are common and parse as `null`, not missing.
   - 5 distinct `projects:` wikilinks are **dangling** (23 task references). Grouping must not drop those tasks.
   - `timeEntries` is used **zero times** vault-wide — progress cannot come from time tracking. 113 of 166 tasks have body checkboxes; that is the real progress signal.
   - Project notes have **no frontmatter at all**. Project-level dates must be rolled up, never read.
   - **No Dataview installed.** Only TaskNotes, Excalidraw, Kanban + core Bases.

### Decisions taken

| Decision | Choice |
|---|---|
| Surfaces | Custom Bases view **and** standalone full-tab view |
| Storage for Gantt-only data | Task frontmatter first |
| Renderer | Custom canvas/SVG, no third-party Gantt library |
| Resource axis | Switchable (assignee / contexts / projects / user field) |
| Missing dates | Infer, render distinctly, write back on interaction |
| Baselines | Single baseline in task frontmatter |
| Delivery | Full product, phased into shippable increments |

---

## Architecture

### Principle: pure core, effectful shell

Mirrors the convention already established in the sibling `content-dragger` plugin (pure `model.ts`/`move.ts`, effectful `editor.ts`, 13-line `main.ts`). Every scheduling algorithm is a pure function over plain data, unit-tested with no Obsidian import. Only the adapter and render layers touch the app.

```
src/
  main.ts                    plugin entry — wiring only
  types.ts                   pure contracts (GanttTask, Edge, Bar, ScheduleResult, …)
  settings/
    defaults.ts  settings-tab.ts
  bridge/
    tasknotes.ts             locate plugin, await lifecycle.ready(), assert apiVersion===1,
                             capability negotiation, catalog+fieldMapping snapshot, extension register
    events.ts                subscribe/unsubscribe, echo suppression by correlationId
    writer.ts                ALL mutations; batching, confirm gate, undo journal
  data/
    adapter-api.ts           api.query.tasks / cacheManager  -> GanttTask[]
    adapter-bases.ts         BasesEntry[]                    -> GanttTask[]
    adapter-vault.ts         metadataCache fallback (read-only, TaskNotes absent/incompatible)
    normalize.ts             PURE: raw record -> GanttTask (handles both blockedBy shapes,
                             empty-string nulls, date-only vs ISO, dangling links)
  model/                     ALL PURE — the tested core
    calendar.ts              working calendar: workdays, day start/end, holidays,
                             addWorkMinutes / subWorkMinutes / workMinutesBetween
    geometry.ts              bar derivation + inference rules
    graph.ts                 build DAG, Tarjan SCC cycle detection, topological order
    constraints.ts           FS/SS/FF/SF + ISO-8601 `gap` lag/lead
    schedule.ts              CPM forward/backward pass, ES/EF/LS/LF, total+free float, critical path
    reschedule.ts            drag -> proposed patch set (free / cascade / replan modes)
    capacity.ts              per-resource daily histogram, overallocation, leveling proposal
    progress.ts              % complete resolution chain
    baseline.ts              variance vs baseline
    rollup.ts                project/parent summary bars from members
  render/
    timescale.ts             PURE: zoom levels, tick generation, date<->x
    layout.ts                PURE: viewport + rows -> draw primitives, viewport culling
    canvas.ts                devicePixelRatio-aware canvas painter
    overlay.ts               sparse DOM: handles, editable labels, a11y mirror
    interactions.ts          pointer state machine: drag / resize / link / marquee
    theme.ts                 Obsidian CSS vars -> palette (light+dark, no hardcoded colors)
  ui/
    controller.ts            owns state, orchestrates model+render, undo stack
    view-bases.ts            extends BasesView
    view-standalone.ts       extends ItemView
    toolbar.ts  grid.ts  inspector.ts  confirm-modal.ts
  export/                    png.ts svg.ts csv.ts mermaid.ts
  commands.ts
```

### Rendering: hybrid canvas + sparse DOM

- `<canvas>` scaled by `devicePixelRatio` paints grid, bars, arrows, capacity histogram — one culled draw per `requestAnimationFrame`. This is what makes 5,000 tasks viable where a DOM-per-bar approach dies at ~500.
- DOM overlay carries only what canvas cannot: drag handles on the hovered/focused bar, the inline label editor, and an **off-screen `role="grid"` mirror of visible rows** so the chart is screen-reader navigable. This is the standard way to make a canvas chart accessible and it must be built in from Phase 1, not retrofitted.
- Left task grid is virtualized DOM rows; right chart is canvas; scroll is synced via a shared scroll model.
- SVG is the **export** path (`export/svg.ts`), not the live path — it reuses `render/layout.ts` primitives so exports match the screen exactly.

### Two surfaces, one renderer

Both views construct the same `GanttController` and differ only in adapter + toolbar:

**Bases view** — `this.registerBasesView("tasknotesGanttChart", { name: "Gantt", icon: "chart-gantt", factory, options })`.
- Registration must retry: the core `bases` plugin may not be loaded at `onload`. TaskNotes solves this with a 5s retry loop; we do the same, plus `app.workspace.onLayoutReady`, and honour the boolean return value.
- Read data from `this.data.data` / `this.data.groupedData` (`BasesEntry[]`), re-render in `onDataUpdated()`. Never retain a reference to `this.data` — the typings explicitly state entries are recreated.
- `config.getOrder()` drives left-grid columns; `config.get(key)` reads our registered options.
- The user's existing `.base` formulas (`nextDate`, `isOverdue`, `urgencyScore`, `priorityWeight`, `daysUntilDue`) become selectable **color-by** and **sort** sources — free value from work they already did.
- Registered options: start property, end property, estimate property, progress property, resource property, timescale, show baseline, show critical path, show capacity, show unscheduled rail, row height.

**Standalone view** — `ItemView` + ribbon icon, for cross-project portfolio planning. Uses `api.query.tasks()` with its own filter bar (built from `api.query.filterOptions()` so the vocabulary matches TaskNotes exactly). This is the full-screen planning workspace the Bases view cannot be, because a `.base` file scopes to one query.

### Read path

```
await tn.api.lifecycle.ready()
guard: tn.api.apiVersion === 1 && hasCapability("tasks.read","tasks.write","query.tasks","catalog.read")
catalog snapshot: api.catalog.statuses()  -> {value,label,color,isCompleted,order}
                  api.catalog.priorities() -> {value,label,color,weight}
                  api.model.config().fieldMapping
```
Statuses and priorities are **read from the catalog, never hardcoded** — this vault uses `backlog/up-next/in-progress/on-hold/done/delegate`, which are not TaskNotes' shipped defaults, and `isCompleted` is the only correct way to know a task is done.

Live updates: subscribe to `task.updated`, `task.scheduled.changed`, `task.due.changed`, `task.dependencies.changed`, `task.status.changed`, `task.created`, `task.deleted`, plus `lifecycle.on("cache.changed")`. Debounce 50 ms, then full recompute (O(V+E) — trivially fast at these sizes; optimise only if measured).

### Write path — and the field-ownership split

This is the safety-critical boundary:

| Field class | Examples | Written via |
|---|---|---|
| **TaskNotes-owned** | `scheduled`, `due`, `status`, `priority`, `timeEstimate`, `blockedBy`, `projects` | `api.tasks.update` / `setScheduled` / `setDue` / `addDependency` |
| **Gantt-owned** | `ganttBaselineStart`, `ganttBaselineEnd`, `ganttMilestone` | `app.fileManager.processFrontMatter` |

Going through the API for TaskNotes fields is what gets us `dateModified` maintenance, field-mapping respect, reverse-dependency bookkeeping, webhooks and event emission for free. Hand-editing that frontmatter would silently desync TaskNotes' caches.

Every mutation carries `{ source: "tasknotes-gantt", correlationId, reason }`. **Echo suppression:** the writer records in-flight correlationIds; the event listener drops any `task.*` event carrying one of ours. Without this, drag → write → event → re-render → drag is a feedback loop.

**Guard rails on batch writes** (we are editing 166 real notes in a live vault):
- Confirmation modal for any operation touching more than `confirmThreshold` tasks (default 10), listing exactly which files and which field changes.
- Cascade/leveling operations are **preview-first**: ghost bars + a diff table, commit only on explicit confirm.
- Writes run at concurrency 4 with a progress notice above 20 files.
- Undo journal stores the inverse patch set; one Ctrl+Z reverts a whole cascade.
- A global **Safe mode** setting makes the entire plugin read-only.

### Fallback adapter

If TaskNotes is missing, or `apiVersion !== 1`, or a required capability is absent: degrade to **read-only** via `metadataCache` frontmatter, reading `fieldMapping` from `.obsidian/plugins/tasknotes/data.json` when present. Show a persistent banner naming the reason. This keeps the plugin installable standalone and survives a TaskNotes major version bump without bricking.

---

## Core algorithms

### Bar geometry (`model/geometry.ts`)

Given scheduled `S`, due `D`, estimate `E` (minutes), working calendar `C`:

| Case | Bar | Style |
|---|---|---|
| S and D | `[S, endOf(D)]` | planned (solid) |
| S only | `[S, C.addWorkMinutes(S, E ?? defaultDuration)]` | inferred end (dashed right cap) |
| D only | `[C.subWorkMinutes(endOf(D), E ?? defaultDuration), endOf(D)]` | inferred start (dashed left cap) |
| neither, has E | anchored at CPM early-start if predecessors exist, else today | unplanned (hatched) |
| neither, no E | unscheduled rail beside the chart | — |
| `D < S` | rendered as an error bar with a warning badge | invalid |

`endOf(D)`: a date-only `due` means **end of the working day, inclusive** — not `00:00`. This is the single most common off-by-one in Gantt implementations. Exposed as a setting (`dueDateInclusive`, default true).

Milestone detection: `timeEstimate === 0` (5 such tasks exist today), or `scheduled === due`, or explicit `ganttMilestone: true`. Renders as a diamond.

Interacting with an inferred bar commits real dates — this is how the 41 undated tasks get planned, and it is the feature that makes the chart worth opening.

### Critical path (`model/schedule.ts`)

Standard CPM over the working calendar, with all four ICS relation types and ISO-8601 `gap` lag/lead (TaskNotes stores and validates these natively):

```
FS: ES(succ) >= EF(pred) + gap        SS: ES(succ) >= ES(pred) + gap
FF: EF(succ) >= EF(pred) + gap        SF: EF(succ) >= ES(pred) + gap
```

Forward pass → ES/EF; backward pass from project end (or a target deadline) → LS/LF; total float = LS − ES; free float from immediate successors. Critical when total float ≤ threshold (default 0); a near-critical band is highlighted separately.

**Cycle handling is mandatory, not optional** — 147 tasks carry dependencies and nothing currently validates them. Tarjan SCC; any component of size > 1 (or a self-loop) is marked, its internal edges excluded from CPM, and a banner lists the ring with jump-to links. The algorithm must never hang.

### Dependency editing

Drag from a bar edge handle to another bar. The handle pair chooses the relation type: right→left = FS, left→left = SS, right→right = FF, left→right = SF. Written with `api.tasks.addDependency(succPath, { uid, reltype, gap })`.

Pre-checks before write: reject self-links, and reject any edge that would create a cycle (run `graph.ts` on the prospective edge first), with a toast explaining which ring it would close.

**Disclosure needed:** TaskNotes' own serializer normalizes `blockedBy` to the object form on write. The first time the Gantt touches a task that currently uses the bare-string form, TaskNotes will rewrite those entries as `{uid, reltype}`. That is TaskNotes' behavior, not ours, but it produces a visible git diff — so it gets a one-time notice and a line in the README.

### Resource capacity (`model/capacity.ts`)

Group-by selector: `assignee` (default — the vault's existing custom field, values Avery/Blake/Team/Casey/Drew/Emery) | `contexts` | `projects` | any TaskNotes user field | none. Handles both scalar and list-valued fields, plus an explicit **Unassigned** lane.

Per lane, per working day: sum each overlapping task's `timeEstimate` prorated across its bar's working minutes. Capacity from `defaultCapacityMinutesPerDay` (480) with per-resource overrides in settings. Overallocation shades above the capacity line.

**Leveling** (Phase 4) is a greedy serial scheduler: order by priority weight (from `api.catalog.priorities()`), then total float, then `tasknotes_manual_order`; push tasks forward until they fit, respecting dependencies. **Preview-only — never auto-writes.**

### Progress (`model/progress.ts`)

Resolution chain, configurable order. Tuned to this vault, where `timeEntries` is empty and only 3 of 12 done tasks carry `completedDate`:

1. `status.isCompleted` → 100%
2. **Checklist ratio from the note body** — the real signal here (113 tasks have checkboxes). Read from `metadataCache.getFileCache(f).listItems` filtered to `task !== undefined`; no file read needed.
3. `timeEntries` tracked ÷ estimate
4. Status order position as a coarse fallback

### Hierarchy and rollup (`model/rollup.ts`)

Rows nest by `projects` wikilink. A task in multiple projects appears under each, marked as linked (setting: first-project-only). **Dangling project links get a synthetic "Unresolved project" group with a warning icon** — never silently dropped. TaskNotes supports task-as-project, which gives real nesting: a parent task row gets a rollup summary bar spanning its children's extent.

Ordering within a group reuses TaskNotes' own `tasknotes_manual_order` LexoRank key when present, so manual order stays consistent with the user's kanban.

---

## Phases

Each phase is independently shippable and independently useful.

| Phase | Deliverable |
|---|---|
| **0 — Scaffold & bridge** | Repo, build, deploy script, `bridge/tasknotes.ts` with capability negotiation, `data/normalize.ts` + its tests, a command that dumps the parsed task graph. Proves the integration before any pixels. |
| **1 — Read-only Gantt (MVP)** | Bases view + standalone view, timescale/zoom, canvas bars, project grouping, inference styling, unscheduled rail, theme integration, a11y mirror, click-to-open-note. |
| **2 — Editing** | Drag/resize bars, create milestones, dependency draw & delete, write-back via API, echo suppression, undo, confirm modals, safe mode. |
| **3 — Critical path** | Graph, CPM, float, critical highlight, cycle detection banner, constraint-violation badges, cascade reschedule with preview. |
| **4 — Capacity** | Switchable resource lanes, daily histograms, overallocation, per-resource capacity settings, leveling preview. |
| **5 — Baselines & tracking** | Set/clear baseline, variance bars and columns, progress % sources, today-line and progress curve, slippage report. |
| **6 — Release** | Export (PNG/SVG/CSV/Mermaid), print stylesheet, touch/mobile, full a11y pass, docs, CI, community-plugin submission. *Optional:* a ```tngantt``` code block so project notes render a live chart where the ASCII timelines are today. |

---

## Project conventions

Adopt the sibling `content-dragger` setup wholesale — it is already tuned for Obsidian and the user's preferences.

- **Build:** esbuild → CJS `main.js` at repo root, `obsidian`/`electron`/CM6/Lezer + builtins external, `"type": "module"`, `.mjs` configs, top-level await, minify in production. Copy `esbuild.config.mjs` and adapt.
- **TypeScript:** the same strict config — `strict`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `isolatedModules`, target ES2021.
- **Tests:** Vitest, no config file, explicit `import { describe, expect, it } from 'vitest'`, pure modules only.
- **Lint:** the same three-rule flat `eslint.config.mjs`. No Prettier/Biome.
- **CSS:** single root `styles.css`, prefix `tng-`, **Obsidian CSS variables only** — no hardcoded colors, no separate light/dark blocks. `render/theme.ts` reads the computed vars so canvas paint matches the active theme.
- **Release:** `version-bump.mjs` on the npm `version` lifecycle; the two GitHub workflows (CI: lint/test/build/artifact-check on Node 20; Release: tag-triggered `gh release create main.js manifest.json styles.css`).
- **Manifest:** `id: tasknotes-gantt`, name "TaskNotes Gantt", author Alin Morosanu / github.com/alin-morosanu, MIT, `minAppVersion: "1.10.0"` (the `registerBasesView` floor), `isDesktopOnly: false` with drag-editing gated to desktop until Phase 6.
- **`docs/plan.md`** written before implementation, matching the shape used for content-dragger (Summary → Behavior & Interfaces → Implementation → Test & Release → Assumptions and Boundaries).
- **Close the deploy gap:** `content-dragger` has no vault-copy step and instructs a manual copy in its README. Add `scripts/deploy.mjs` driven by an `OBSIDIAN_VAULT` env var, wired as a post-build step and into esbuild watch — targeting a **scratch test vault**, not `the reference vault`, until Phase 2 write paths are proven.

---

## Verification

**Unit (Vitest, pure modules).** `calendar`, `geometry`, `graph`, `constraints`, `schedule`, `capacity`, `progress`, `rollup`, `timescale`, `layout`, `normalize`.

**Golden fixtures from the real vault.** Snapshot ~30 anonymized tasks from the reference vault's `TaskNotes/Tasks/` into `tests/fixtures/`, deliberately covering every known landmine: both `blockedBy` shapes (BEL-0002 object form, BEL-0003 string form), empty-string dates (TASK-0610), due-only tasks (the 12 BOA-*), zero-estimate milestones, dangling project links, missing `title`, and the datetime-valued `due` from the bakery vault.

**Property tests for CPM.** Generate random DAGs; assert total float ≥ 0 for all nodes, that the critical path length equals project duration, and that no successor's ES violates its predecessor constraint under any relation type. Plus an explicit 3-node cycle that must be detected, excluded, and reported without hanging.

**Manual acceptance, in order:**
1. `npm run build`, deploy to a scratch vault seeded with a copy of `TaskNotes/`. Confirm the Gantt appears in the Bases view switcher next to Kanban.
2. Open `TaskNotes/Views/kanban-default.base`, switch the "Business Board" view to Gantt — its existing filters and formulas must carry over untouched.
3. Verify BEL-0001 → BEL-0002 draws a FS arrow, and that the BEL-* chain matches the hand-drawn ASCII timeline in `PRJ-01 Website Relaunch.md`.
4. Confirm the 12 BOA-* due-only tasks render inferred start caps, the 20 undated tasks land in the unscheduled rail, and the 5 dangling project links produce an "Unresolved project" group rather than vanishing.
5. Drag a bar; confirm `scheduled`/`due` change in the note, `dateModified` updates, TaskNotes' own kanban reflects it live, and no render feedback loop occurs.
6. Introduce a deliberate cycle; confirm the banner appears and the view stays responsive.
7. Switch the resource axis to `assignee`; confirm Avery's lane sums her 6 tasks' estimates and flags overallocation against a 480 min/day capacity.
8. Set a baseline, shift a task, confirm the variance bar and column.
9. Disable TaskNotes; confirm the fallback adapter renders read-only with a banner instead of erroring.
10. Toggle dark/light and a community theme; confirm canvas colors follow.

**Performance gate.** Synthetic 5,000-task vault: initial render < 500 ms, scroll/zoom sustained at 60 fps, full CPM recompute < 16 ms at 1,000 tasks.

---

## Risks

| Risk | Mitigation |
|---|---|
| Writing to 166 real notes in a live vault | Confirm modals above threshold, preview-first cascades, undo journal, global safe mode, scratch vault until Phase 2 is proven |
| TaskNotes API v1 is young and unversioned beyond `apiVersion` | Hard `apiVersion === 1` guard, per-capability checks, read-only fallback adapter, `extensions.register` under namespace `gantt` |
| Bases view API is `@since 1.10.0` and young | Honour `registerBasesView`'s boolean return, retry loop, standalone view as the guaranteed surface |
| `blockedBy` reshaping on first write | One-time notice + README disclosure; it is TaskNotes' serializer, not ours |
| `due` inclusivity ambiguity | Explicit `dueDateInclusive` setting, default true, documented |
| Project notes have no frontmatter | Project dates are always rolled up from members, never read; optional write-back deferred |
| Canvas accessibility | Off-screen `role="grid"` mirror built in Phase 1, not retrofitted |
