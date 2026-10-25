# Development

- [Setup](#setup)
- [Working in a vault](#working-in-a-vault)
- [Testing](#testing)
- [Probing against a real vault](#probing-against-a-real-vault)
- [Conventions](#conventions)
- [Releasing](#releasing)

## Setup

Node 18 or later.

```sh
npm install
npm run dev      # esbuild in watch mode
npm test         # vitest
npm run lint     # eslint
npm run build    # tsc --noEmit, then a production bundle
```

`npm run build` typechecks before bundling, so a type error fails the build rather than
shipping.

## Working in a vault

Point `OBSIDIAN_VAULT` at a vault and every build copies `main.js`, `manifest.json` and
`styles.css` into it, plus a `.hotreload` marker for the Hot Reload plugin:

```sh
OBSIDIAN_VAULT=/path/to/scratch-vault npm run dev
```

Deploying is a no-op when the variable is unset, so a plain `npm run dev` never touches
anyone's vault by accident.

**Use a scratch vault.** This plugin writes to task notes. A useful one is a copy of a
real vault's `TaskNotes/` folder plus its `.obsidian/plugins/tasknotes/` directory, so
the settings, statuses and field mapping are genuine:

```sh
V=../gantt-test-vault
mkdir -p "$V/.obsidian/plugins"
cp -R /path/to/vault/TaskNotes "$V/TaskNotes"
cp -R /path/to/vault/.obsidian/plugins/tasknotes "$V/.obsidian/plugins/tasknotes"
for f in app.json core-plugins.json types.json; do
  cp "/path/to/vault/.obsidian/$f" "$V/.obsidian/$f"
done
echo '["tasknotes","tasknotes-gantt"]' > "$V/.obsidian/community-plugins.json"
```

Bases must stay enabled in `core-plugins.json` for the Bases view to register.

## Testing

362 unit tests, all over pure modules. `vitest.config.ts` aliases the `obsidian` module
to `tests/stubs/obsidian.ts`, which is a minimal stand-in — Obsidian's real module only
exists inside the app.

Shared fixtures:

- `tests/fixtures/build.ts` — `makeTask()`, one builder for every test. It exists
  because six files used to carry their own copy of the task shape, and every addition
  to `GanttTask` broke all six identically.
- `tests/fixtures/tasks.ts` — records and a catalog taken from a real vault, covering
  both authored `blockedBy` shapes, blank frontmatter values, due-only tasks,
  zero-estimate milestones, dangling project links and a missing title.

### What is worth testing

Prefer tests that pin a **property** over tests that pin a value. The most useful test
in the suite asserts that every segment of every dependency route is horizontal or
vertical — that is the thing that was broken, stated directly, and it cannot regress
quietly.

Similar load-bearing tests:

- Working-time arithmetic terminates on a calendar with no working days.
- Total float is never negative, on random graphs.
- A cycle is detected and excluded rather than looped on.
- The writer refuses every path in safe mode and records no undo entry.
- An undone drag that invented dates clears them rather than leaving the guess.

The DOM and canvas layers are not unit tested. They are checked by a smoke test that
loads the bundle against a stubbed Obsidian, and by using the plugin.

### Smoke testing the bundle

Loading `main.js` against a stubbed `obsidian` module catches wiring mistakes before
Obsidian is opened. It has caught real bugs — a fire-and-forget connect that left the
catalog stale, and every command and view registration.

```js
const mod = require('./main.js');
const Plugin = mod.default ?? mod;
const plugin = new Plugin(fakeApp, {});
await plugin.onload();
```

## Probing against a real vault

**Run a new model over real data before building UI on it.** This is the single most
valuable practice in this project, and it has caught a bug in every phase it was used:

| Phase | What the probe found |
| --- | --- |
| Critical path | 2 of 165 tasks critical, median float 293 days — the whole-vault network was the wrong model |
| Capacity | The resource axis read only `extra`, so `contexts` — 100% coverage — gave one empty lane |
| Progress | Confirmed checklists answer for 113 of 167 tasks, justifying their rank |
| Agent apply | The undo file for a cycle-breaking change could never be applied — restoring the dependency recreates the loop, and a new loop is a blocking error |
| Schedule | Tasks scheduled Saturday to Sunday measure as zero working minutes, so their successors started the same morning — the very conflict the pass exists to remove |
| Schedule | Levelling reported success against a field no task fills in, and gave up after 5 rounds on a vault that settles in 18 |
| Levelling UI | "Level resources" silently fixed all 23 pre-existing dependency conflicts too, moving 45 tasks where the overload implicated 11 |

The method: write a temporary `tests/*-probe.test.ts` that reads the real vault from
disk, runs the model, and `console.log`s a summary. Read the numbers, ask whether they
are useful rather than merely correct, then delete the probe.

A plausible-looking feature built on an unexamined model is worse than no feature: it
is confidently wrong.

### Registering the MCP server

`bin/tng-mcp.mjs` speaks MCP over stdio. In Claude Code, add it to `.mcp.json`:

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

Without `--vault` it looks for a vault above the working directory. Once started with
one, the server is bound to it: a tool call naming a different vault is refused. Run
a second server for a second vault. The four tools are `gantt_snapshot`,
`gantt_validate`, `gantt_apply` and `gantt_schedule`; only `gantt_apply` writes, and
only when called with `write: true`. Their arguments and output shapes are in
[the tools reference](tools-reference.md).

### Probing a protocol

An MCP server is easy to write and easy to get subtly wrong, because nothing in the
type system says whether a client can actually open a session. `tests/mcp.test.ts`
drives the real server over `InMemoryTransport.createLinkedPair()` with a hand-rolled
JSON-RPC client — `initialize`, `notifications/initialized`, `tools/call` — so the
wiring is exercised rather than the handlers.

For the built binary, speak to it over a pipe:

```sh
npm run build
node scratch/mcpclient.mjs bin/tng-mcp.mjs ~/vault \
  '[{"name":"gantt_snapshot","args":{"summary":true}}]'
```

Never write to stdout from the server: it is the protocol channel, and anything that
is not a JSON-RPC message corrupts the stream. Errors go to stderr.

### Probing a write

Reading real data is not enough once a change reaches the disk. **Prove the write
landed, not just that it was proposed** — the "Break the loop" bug was an API call that
succeeded and changed nothing, which is the worst failure shape there is.

Copy the markdown out of the real vault (not the whole thing — it is 13 GB of
attachments), `git init` the copy, and let git answer:

```sh
S=/tmp/probe
mkdir -p "$S/vault" && cd ~/your-vault
find . -name '*.md' -not -path './.obsidian/*' | while read -r f; do
  mkdir -p "$S/vault/$(dirname "$f")"; cp "$f" "$S/vault/$f"
done
mkdir -p "$S/vault/.obsidian/plugins/tasknotes"
cp .obsidian/plugins/tasknotes/data.json "$S/vault/.obsidian/plugins/tasknotes/"
git -C "$S/vault" init -q . && git -C "$S/vault" add -A && git -C "$S/vault" commit -qm base

node bin/tng.mjs apply --file p.json --vault "$S/vault" --write --undo-out "$S/undo.json"
git -C "$S/vault" diff                    # only the keys the proposal named?
node bin/tng.mjs apply --file "$S/undo.json" --vault "$S/vault" --write --allow-cycles
git -C "$S/vault" status --short          # empty: every byte restored
```

An empty `git status` after apply-then-undo across 1361 notes is the strongest
statement available that the writer is surgical and reversible.

## Conventions

- **ESM everywhere** — `"type": "module"`, `.mjs` config files.
- **Strict TypeScript**, including `noUncheckedIndexedAccess`. This is why indexed
  access is full of `?.` and `!`.
- **esbuild** to a CJS bundle at `main.js`, with `obsidian`, `electron` and Node
  builtins external; plus two ESM Node bundles, `bin/tng.mjs` and `bin/tng-mcp.mjs`.
- **Two tsconfigs.** The root one uses `moduleResolution: "node"`, which predates
  package `exports` maps — so an import of `@modelcontextprotocol/server/stdio`
  resolves to nothing and is silently typed `any`. `tsconfig.mcp.json` re-checks
  `mcp/` under `moduleResolution: "bundler"`, and `npm run build` runs both. Without
  it the MCP server would type-check clean while calling methods that do not exist.
  Confirm a type check is real by breaking it on purpose before trusting a clean run.
- **ESLint flat config**, three rules, no formatter.
- **One `styles.css`** at the repo root, prefix `tng-`, **Obsidian CSS variables only**.
  No hardcoded colours, so themes work without special cases.
- **Comments explain why, not what.** A comment that restates the code is noise; one
  that records the bug a line prevents is the reason the line survives a refactor.

### Obsidian plugin guidelines

The build is kept clean of the common review failures. Worth re-checking before a
release:

```sh
grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML" src/   # must be empty
grep -rn "console\." src/                                  # must be empty
grep -n "detachLeavesOfType" src/main.ts                   # must be empty
```

Also: no global `app`, commands do not repeat the plugin name (Obsidian prefixes it),
settings headings are sentence case, and `onunload` does not detach leaves.

## Releasing

1. Update `CHANGELOG.md`.
2. `npm version <patch|minor|major>` — the `version` lifecycle script runs
   `version-bump.mjs`, which writes `manifest.json` and `versions.json` and stages both.
3. `git push --follow-tags`.

The tag-triggered release workflow builds and attaches `main.js`, `manifest.json` and
`styles.css` to a GitHub release. CI runs `npm audit`, lint, tests and the build on
every push, and checks all three bundles were produced. The release job refuses to
publish if the tag does not match `manifest.json`'s version.

Actions are pinned to full commit SHAs rather than tags, since a tag can be moved to
point at different code. Dependabot (`.github/dependabot.yml`) proposes updates to the
pins and to npm dependencies weekly. Node 22.12 or later is required — vitest 5 will
not run on anything older.

`main.js` is gitignored; it is a build artifact, produced by the release workflow.
