# Backlog

Deferred work, with the reason it was deferred. Not a wishlist — each item was built
or considered and consciously held back.

## What a `P2D` dependency lag means

`parseDurationMinutes` turns `P2D` into 2880 minutes, and every constraint applies lag
with `addWorkMinutes` — so `P2D` means 2880 minutes of *working* time, which on an
eight-hour day is six working days, not two. `PT16H` is what "two working days" reads
as today.

**Why deferred:** it is consistent across the chart, the CLI, the scheduler and the MCP
server, no note in the reference vault uses a day-valued lag, and changing it would
silently move bars in an existing plan. It is a question for the user rather than a bug
to fix quietly. `docs/agent-guide.md` documents the current meaning so an agent is not
caught by it.

## Ship the CLI and MCP server to people who do not clone the repo

`bin/` is gitignored and the release workflow uploads only `main.js`, `manifest.json`
and `styles.css`, so the headless tooling reaches nobody who has not built it. (CI does
now check that both binaries build.)

**Why deferred:** orthogonal to the plugin itself, and the decision is really "is this
for other people or for one vault" — worth answering before designing a distribution.

## PNG and print verification

The SVG-to-PNG rasteriser and the print stylesheet are implemented but have only been
exercised against unit tests and a stubbed environment. They need checking in a real
Obsidian session before release. (Levelling has now been run against the real vault
through `tng schedule --level`: a 108-task initiative on one lane settles in 18 rounds.)

## Write project rollup dates back to project notes

Project notes in the reference vault have no frontmatter at all, so project-level dates
are always rolled up from members and never read. Writing a computed start and end back
into the project note was considered and left out: it would mean this plugin owns
fields in notes it does not otherwise touch.

The rollup itself already exists where it matters — a group header row carries a `bar`
spanning its members (`src/render/layout.ts`), so a project draws its rolled-up span in
the chart and in a ```tngantt``` block. Only the write is missing.

## Tests for the effectful shell

`src/ui/controller.ts` is over 1,300 lines — state, orchestration and interaction — and
has no tests, along with the views, the bridge adapters and the settings tab. The pure
core underneath is thoroughly covered, which is the layering working as intended, but
the shell is now large enough that "untested by design" and "untested by drift" are
hard to tell apart.
