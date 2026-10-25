# Security

## Reporting a vulnerability

Please report it privately through
[GitHub's private vulnerability reporting](https://github.com/alin-morosanu/tasknotes-gantt/security/advisories/new)
rather than in a public issue. Include what you did, what happened, and the version.
You will get a reply, and a fix will be released as a patch version with the issue
described in the changelog's **Security** section once users can update.

Only the latest release is supported.

## What the plugin can touch

Knowing the boundaries makes it easier to tell a vulnerability from intended behaviour.

**The Obsidian plugin**

- Makes no network requests and collects no telemetry.
- Changes TaskNotes fields — dates, status, dependencies — only through the TaskNotes
  API. It writes its own baseline fields directly into task frontmatter.
- Never edits a note that is not a task. It creates exports in the folder you choose,
  and the data report as a single note, `TaskNotes Gantt report.md`, at the vault root.

**The CLI** (`bin/tng.mjs`, from a clone of this repository)

- Reads the vault you point it at and writes only with `--write`, editing only the
  frontmatter keys a proposal names.
- Takes file paths only from your own command line (`--out`, `--undo-out`).

**The MCP server** (`bin/tng-mcp.mjs`)

An agent connected to it reads your notes, and text in a note can try to steer the
agent. The server is built on the assumption that whatever the agent sends may have
been influenced that way:

- It is bound to the vault it was started with and refuses calls naming another.
- It never takes a file path from the agent. The only files it writes are the task
  notes a proposal names, and only when called with `write: true`.
- `set_field` accepts only plain property names, refuses fields TaskNotes manages,
  and refuses values spanning more than one line. The frontmatter writer independently
  escapes control characters and refuses keys that could start a line of their own.

Anything that gets past one of those is a vulnerability — please report it.
