# TaskNotes integration

Everything this plugin assumes about TaskNotes, and what happens when an assumption
fails. This is the document to read first if a TaskNotes update breaks something.

- [The runtime API](#the-runtime-api)
- [Degradation](#degradation)
- [Fields read](#fields-read)
- [Fields written](#fields-written)
- [Data shapes that vary](#data-shapes-that-vary)
- [Events](#events)
- [Bases](#bases)
- [Verifying against a new version](#verifying-against-a-new-version)

## The runtime API

TaskNotes 4.12+ exposes an in-process API at `app.plugins.plugins.tasknotes.api`,
documented at <https://callumalpass.github.io/tasknotes/javascript-api/>.

`src/bridge/tasknotes-api.ts` declares only the surface actually called. Everything is
narrowly typed on purpose: TaskNotes publishes no typings to depend on, so the bridge
validates at runtime instead.

What is used:

| Namespace | Used for |
| --- | --- |
| `lifecycle.ready()` | Waiting for TaskNotes to finish loading. Resolves immediately if it already has, so load order does not matter. |
| `apiVersion` / `hasCapability()` | Version and capability negotiation |
| `catalog.statuses/priorities/userFields` | The user's real statuses, priorities and custom fields |
| `model.config().fieldMapping` | Frontmatter property names, which are user-configurable |
| `settings.snapshot()` | Task identification method, excluded folders |
| `tasks.update` | Every date change |
| `tasks.addDependency` / `removeDependency` | Dependency edges |
| `events.on/off` | Reacting to changes made elsewhere |
| `extensions.register` | Announcing this plugin under the `gantt` namespace |

`SUPPORTED_API_VERSION` in `src/bridge/tasknotes.ts` is a hard gate. A different version
degrades to read-only rather than guessing.

## Degradation

`TaskNotesBridge` is the only place in the codebase that touches `app.plugins`. One
choke point keeps the failure modes in one testable place.

| Mode | When | Behaviour |
| --- | --- | --- |
| `api` | Everything present and capable | Full read/write |
| `fallback` | TaskNotes present but the API is missing, unhealthy, the wrong version, or lacking a capability | Read-only, with a banner naming the reason |
| `unavailable` | TaskNotes not installed or disabled | Read-only from the vault |

Fallback mode is genuinely useful rather than a blank chart: the catalog is read
straight out of `.obsidian/plugins/tasknotes/data.json`, so the user's real statuses,
priorities, field mapping and identification rules are all still correct.

## Fields read

Property names come from TaskNotes' field mapping, **never hardcoded** — the mapping is
user-configurable. The defaults:

| Mapped field | Default property | Notes |
| --- | --- | --- |
| `title` | `title` | Falls back to the filename when absent |
| `status` | `status` | Completion comes from the catalog's `isCompleted`, never from the literal `"done"` |
| `priority` | `priority` | Ranked by the catalog's `weight` |
| `scheduled` | `scheduled` | Bar start |
| `due` | `due` | Bar end |
| `timeEstimate` | `timeEstimate` | Minutes. `0` means milestone |
| `timeEntries` | `timeEntries` | Summed into `trackedMinutes` |
| `completedDate` | `completedDate` | |
| `projects` | `projects` | Wikilinks; used for grouping |
| `contexts` | `contexts` | |
| `blockedBy` | `blockedBy` | Dependencies |
| `archiveTag` | `archived` | **A tag, not a boolean property** |
| `sortOrder` | `tasknotes_manual_order` | LexoRank; used by manual sort |

Anything not in the mapping lands in `GanttTask.extra`, which is where user fields like
`initiative` and non-TaskNotes fields like `assignee` are read from.

**Beware:** a mapped field is *not* in `extra`. Reading `extra` alone for the resource
axis silently produced a single empty lane for `contexts`, which has 100% coverage in
the reference vault. `resourceValues` and `buildFacets` both special-case the
first-class fields for this reason.

## Fields written

| Field class | Examples | Written via | Why |
| --- | --- | --- | --- |
| TaskNotes-owned | `scheduled`, `due`, `blockedBy` | `api.tasks.*` | Keeps `dateModified`, the field mapping, its caches and its events correct |
| This plugin's own | `ganttBaselineStart`, `ganttBaselineEnd` | `app.fileManager.processFrontMatter` | Not in TaskNotes' mapping, so its API has no opinion about them |

Baseline property names are configurable, and default to a `gantt` prefix so they are
obviously not TaskNotes'.

Every write goes through `GanttWriter` (dates) or `BaselineWriter` (baselines). Both
enforce safe mode, the confirmation threshold and an undo journal.

## Data shapes that vary

Real vaults contain all of these. The normalizer handles every one, and
`tests/fixtures/tasks.ts` pins them.

**`blockedBy` has two authored shapes**, often in the same vault:

```yaml
# bare string
blockedBy:
  - "[[TaskNotes/Tasks/BEL-0001 Draft homepage copy]]"

# object, with an explicit relation type and optional lag
blockedBy:
  - uid: "[[TaskNotes/Tasks/BEL-0001 Draft homepage copy]]"
    reltype: FINISHTOSTART
    gap: PT4H
```

TaskNotes' own serializer normalizes to the object form whenever it writes a task, so
editing a task that used the bare form rewrites those entries. Disclosed in the README:
it is TaskNotes' behaviour, and it changes formatting only.

**A dependency is matched on its authored uid, not on the file it resolves to.**
`api.tasks.removeDependency(path, uid, ctx)` takes a plain string and filters
`blockedBy` on an exact comparison. Passing a resolved path — which usually carries a
`.md` suffix the note does not — matches nothing, and the call succeeds while changing
nothing. `Edge` therefore carries both `uid` (as authored) and `from` (resolved).

**Links appear in two path styles** — full (`TaskNotes/Tasks/X`) and bare (`X`) — and
optionally as markdown links when `useFrontmatterMarkdownLinks` is on. All are resolved
through `metadataCache.getFirstLinkpathDest`.

**Dates are either date-only or full ISO.** Date-only values are anchored to *local*
midnight; `new Date('2026-04-15')` parses as UTC and shifts every bar a day west of
Greenwich.

**Blank values are common.** `scheduled:` with nothing after it parses as `null`, not as
a missing key, and must read as absent rather than as an error.

**Links dangle.** The reference vault has five project links pointing at notes that do
not exist, across 23 tasks. Those form their own group with a warning rather than being
dropped — losing work because a link is broken is worse than the broken link.

**Cycles exist.** The reference vault contains a real two-task deadlock. Cycle handling
is a normal path, not a defensive afterthought.

## Events

`TaskNotesEvents` subscribes to the task mutation events plus `lifecycle.cache.changed`,
debounced 80 ms.

The important behaviour is what it does *not* forward: the echo of a write this plugin
just made. Without that filter a drag writes a file, the file emits an event, the event
triggers a re-render, and the bar jumps out from under the pointer.

Suppression works two ways, deliberately:

1. By **correlation id**, attached to every mutation through the API's `context`.
2. By **touched path**, on a 2.5 second window — because TaskNotes is not guaranteed to
   return the context in its payload, and that could not be verified from the bundle.

## Bases

`Plugin.registerBasesView` is public Obsidian API since 1.10.0. TaskNotes registers
`tasknotesTaskList`, `tasknotesKanban`, `tasknotesCalendar` and `tasknotesMiniCalendar`
the same way; this plugin adds `tasknotesGanttChart` alongside them.

Registration retries — the core Bases plugin may load after this one, and
`registerBasesView` returns `false` when it is not ready.

`BasesEntry.getValue` returns wrapped values shaped for Bases' own rendering, so the
adapter resolves entries back to their file and reads frontmatter from the metadata
cache instead. Fewer shapes to unwrap, and it reuses the same normalizer as every other
path.

## Verifying against a new version

When TaskNotes updates, check in this order:

1. **Run the data report** (`Write data report`). The Connection section states the mode,
   the API version and the reason. If it still says `api` / writable, the handshake is
   intact.
2. **Compare the counts** in that report against the previous one. A sudden drop in
   resolved edges or dated tasks means a shape changed.
3. **Grep the bundle** if something looks wrong. It is minified but not stripped, so
   string literals and object keys survive:
   ```sh
   grep -o 'apiVersion=[0-9]*' .obsidian/plugins/tasknotes/main.js
   grep -o '"tasks\.[a-z]*"' .obsidian/plugins/tasknotes/main.js | sort -u
   ```
4. **Check the field mapping** in `.obsidian/plugins/tasknotes/data.json` for renamed or
   added fields.

If the API version changed, the bridge already degrades to read-only rather than
writing against an interface it does not understand. That is the intended behaviour:
update `SUPPORTED_API_VERSION` only after checking the methods this plugin calls.
