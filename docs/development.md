# Development

- [Setup](#setup)
- [Working in a vault](#working-in-a-vault)
- [Testing](#testing)
- [Probing against a real vault](#probing-against-a-real-vault)
- [Driving Obsidian for screenshots](#driving-obsidian-for-screenshots)
- [Conventions](#conventions)
- [Versioning](#versioning)
- [The changelog](#the-changelog)
- [Releasing](#releasing)
- [CI and the supply chain](#ci-and-the-supply-chain)

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
| `tngantt` blocks (in Obsidian) | A block's timeline stayed blank whenever the note opened in a background tab — reading view detaches and re-attaches sections mid-layout — and a block copied the main view's hidden groups, so `groupBy: none` could show nothing |

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

## Driving Obsidian for screenshots

Unit tests cover the pure core; they cannot see a canvas that never drew. The plugin's
UI has to be looked at, and Obsidian can be driven from a script to do it — no macOS
Screen Recording or Accessibility permission needed.

Obsidian is an Electron app, so started with a DevTools port it accepts the
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/):
`Page.captureScreenshot` for screenshots, `Runtime.evaluate` to run code in a window
(open a note, run a command, read the DOM), `Input.dispatchMouseEvent` for real clicks
and drags.

```sh
osascript -e 'quit app "Obsidian"'
open -a Obsidian --args --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
curl -s http://127.0.0.1:9222/json/list      # one "page" target per vault window
```

A minimal driver, in Node 22+ with its built-in `WebSocket`:

```js
// node cdp.mjs eval '<js>'  |  node cdp.mjs shot out.png
const VAULT = 'gantt-test-vault';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = targets.find((x) => x.type === 'page' && x.title.includes(` - ${VAULT} - `));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const wait = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); wait.get(m.id)?.(m); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((r) => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expr) => (await send('Runtime.evaluate',
  { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;

// Refuse to touch any window that is not the test vault.
if ((await run('app.vault.getName()')) !== VAULT) process.exit(3);
```

Useful expressions once connected:

```js
// Reload the plugin after a deploy (there is no Hot Reload plugin in the test vault).
await app.plugins.disablePlugin('tasknotes-gantt'); await app.plugins.enablePlugin('tasknotes-gantt');
// Open a note in reading view, in its own tab.
const leaf = app.workspace.getLeaf('tab');
await leaf.openFile(app.vault.getFileByPath('Gantt block test.md'), { state: { mode: 'preview' } });
// Run any command.
app.commands.executeCommandById('tasknotes-gantt:open-gantt-view');
```

**Safety.** Bind the port to `127.0.0.1` only, and relaunch Obsidian normally when you
are done — while the port is open, any local process can control every Obsidian window,
including vaults you care about. Identify the target window by vault name and check it
before every action, as the driver above does.

**Measure, then fix.** When something looks wrong, read numbers out of the DOM before
theorising: a canvas still at the browser's default 300×150 means it was never sized;
a `ResizeObserver` or `requestAnimationFrame` wrapper installed for one run shows what
fired and when. The blank-timeline bug was found this way — Obsidian's reading view
detaches a note's sections within a single frame during layout, which no amount of
reading the plugin's own code would have revealed.

### Screenshots for the README

Never from a real vault: a screenshot of one publishes real names, plans and tab titles.
`scripts/demo-vault.mjs` builds a vault of made-up projects instead, with dates computed
from the day it runs so the plan always straddles today:

```sh
TASKNOTES_FROM=../gantt-test-vault node scripts/demo-vault.mjs ../gantt-demo-vault
OBSIDIAN_VAULT=../gantt-demo-vault npm run build
```

`TASKNOTES_FROM` copies the TaskNotes plugin files from a vault that has it installed;
its settings are written from scratch, because a real `data.json` carries API and
calendar tokens. The script refuses to write into a non-empty folder it did not create.

You do not need to quit your own Obsidian for this. A second instance with its own
profile directory knows only about the vaults listed in that profile, so it opens the
demo vault and nothing else:

```sh
P=$(mktemp -d)
echo '{"vaults":{"demo":{"path":"'"$PWD"'/../gantt-demo-vault","ts":0,"open":true}}}' > "$P/obsidian.json"
/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir="$P" \
  --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 &
```

A new vault opens in restricted mode; `await app.plugins.setEnable(true)` and
`app.plugins.enablePluginAndSave(id)` for `tasknotes` and `tasknotes-gantt` turn the
plugins on. Then fix the viewport with
`Emulation.setDeviceMetricsOverride({ width: 1400, height: 940, deviceScaleFactor: 2 })`,
collapse both sidebars, and clip `Page.captureScreenshot` to
`.workspace-leaf.mod-active .view-content`. In reading view a note has two copies of a
`tngantt` block (the hidden editor renders one too), so select the one under
`.markdown-reading-view`. Downscale to 1800 px wide with
`sips --resampleWidth 1800` and save under `docs/images/`.

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

## Versioning

Releases follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). What
counts as the public interface — the things whose change decides the bump:

- **What the plugin writes into notes**: the baseline property names and their value
  format, and the `ganttMilestone` flag it reads.
- **The `tngantt` block syntax**: option names, accepted values, and what they mean.
- **Settings**: a renamed or removed setting. A rename that `mergeSettings` migrates is
  not breaking — the user's value carries over.
- **The CLI**: command names, flags, exit codes, and the JSON output shapes.
- **The MCP server**: tool names, arguments, and result formats.
- **The proposal format**: its operations, fields, and `version`.
- **`minAppVersion`**: raising it is a minor bump. `versions.json` keeps older Obsidian
  installs on the last release that supported them.

**While the major version is 0** — as now — SemVer allows anything to change, so this
project narrows it: a breaking change to any of the above bumps the **minor** version
(0.1 → 0.2) and says so under **Changed** or **Removed**; everything else, features
included, bumps the **patch**. From 1.0.0 the usual rules apply: breaking is major,
features are minor, fixes are patch.

A version is never reused. A release that turns out broken is fixed by the next patch,
and can be marked `[YANKED]` in the changelog.

## The changelog

[CHANGELOG.md](../CHANGELOG.md) follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Add entries under `## [Unreleased]` as you work, in **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed** or **Security**, written for the person using
the plugin and ending in a full stop. Do not write entries at release time from the
commit log; by then the reasons are gone.

One departure from the Keep a Changelog examples: tags are bare versions (`0.1.1`, not
`v0.1.1`), because Obsidian installs from the release whose tag equals `manifest.json`'s
version exactly. `.npmrc` sets `tag-version-prefix=""` so `npm version` agrees.

`scripts/changelog.mjs` does the mechanical parts, and `tests/changelog.test.ts` holds
the file to the format in CI:

| Command | Used by | Does |
| --- | --- | --- |
| `check` | `preversion` | Refuses to release if `[Unreleased]` is empty or the file is malformed |
| `release [version]` | `version` | Moves `[Unreleased]` into `## [x.y.z] - date` and updates the compare links |
| `notes <version>` | release workflow | Prints one version's section, published as the GitHub release notes |
| `lint` | by hand | Lists format problems |

## Releasing

```sh
npm version patch        # or minor, or major — see Versioning
git push --follow-tags
```

`npm version` refuses to run on a dirty tree. Then, in order:

1. **`preversion`** checks the changelog has something under `[Unreleased]` and runs
   the full test suite. Either failing stops the release before any file changes.
2. npm bumps `package.json`.
3. **`version`** writes the new version into `manifest.json` and `versions.json`, and
   moves `[Unreleased]` into a dated section of `CHANGELOG.md`.
4. npm commits all of it as one commit named after the version, and tags it — `0.1.1`,
   with no `v`.

Pushing the tag starts the **release workflow**, which runs the audit and the tests
again, builds, refuses to continue if the tag and `manifest.json` disagree or the
changelog has no section for the version, and publishes `main.js`, `manifest.json` and
`styles.css` with that changelog section as the release notes.

**If a release fails** after the tag is pushed, fix the cause and release the next
patch. Do not move or reuse the tag — anyone who saw it has the old one.

## CI and the supply chain

CI runs `npm audit`, lint, the tests and the build on every push and pull request, and
checks all three bundles were produced. Actions are pinned to full commit SHAs rather
than tags, since a tag can be moved to point at different code; workflows have
read-only permissions except the step that publishes a release; the checkout token is
not left in `.git/config`. Dependabot (`.github/dependabot.yml`) proposes updates to
the pins and to npm dependencies weekly.

Node 22.12 or later is required — vitest 5 will not run on anything older.

`main.js` and `bin/` are gitignored; they are build artifacts.
