import fs from 'node:fs';
import process from 'node:process';
import { findVault, readVault, type VaultData } from './vault';
import { renderBrief } from '../src/agent/brief';
import { parseTaskDate } from '../src/model/dates';
import { buildIdMap } from '../src/agent/ids';
import { renderReport } from '../src/agent/diff';
import { autoschedule, buildScheduleProposal } from '../src/agent/autoschedule';
import { writePlan } from './apply';
import {
  applyScope,
  evaluateProposal,
  onlyCycleErrors,
  planFor,
  renderUnreadable,
  snapshotFor,
  touchedKeys,
  type Scope
} from './session';

/**
 * The headless entry point.
 *
 * Everything here is argument handling and printing; all the reasoning lives in the
 * same pure modules the plugin uses, so the chart and the agent cannot disagree about
 * what a vault contains.
 */

interface Args {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const command = argv[0] ?? 'help';

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      booleans.add(key);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }

  return { command, flags, booleans };
}

/** Split a comma-separated flag into trimmed values. */
function list(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Flags to the shared scope options. */
function scopeFrom(args: Args): Parameters<typeof applyScope>[1] {
  const options: Parameters<typeof applyScope>[1] = {
    initiatives: list(args.flags.get('initiative')),
    projects: list(args.flags.get('project')),
    statuses: list(args.flags.get('status')),
    includeArchived: args.booleans.has('all')
  };
  const from = args.flags.get('from');
  const to = args.flags.get('to');
  if (from !== undefined) options.from = from;
  if (to !== undefined) options.to = to;
  return options;
}

function loadVault(args: Args): VaultData {
  const explicit = args.flags.get('vault');
  const vaultPath = explicit ?? findVault(process.cwd());
  if (vaultPath === null) {
    throw new Error(
      'No vault found. Run inside an Obsidian vault, or pass --vault <path>.'
    );
  }
  return readVault(vaultPath);
}

function commandSnapshot(args: Args): string {
  const vault = loadVault(args);
  const scope = applyScope(vault, scopeFrom(args));
  const snapshot = snapshotFor(vault, scope);

  if (args.flags.get('format') === 'json') return JSON.stringify(snapshot, null, 2);
  return renderBrief(snapshot, {
    detail: list(args.flags.get('detail')),
    summaryOnly: args.booleans.has('summary')
  });
}

/** Problems only — the fastest way to ask "what is wrong with this plan". */
function commandDoctor(args: Args): string {
  const vault = loadVault(args);
  const scope = applyScope(vault, scopeFrom(args));
  const snapshot = snapshotFor(vault, scope);

  return [renderBrief(snapshot, { summaryOnly: true }), ...renderUnreadable(vault)].join('\n');
}

/**
 * Read the proposal named on the command line and run it through the shared pipeline.
 *
 * `validate` and `apply` go through the same call, so what `apply` writes is derived
 * from the very simulation whose consequences `validate` printed.
 */
function readAndEvaluate(args: Args, command: string) {
  const file = args.flags.get('file') ?? args.flags.get('proposal');
  if (file === undefined) {
    throw new Error(`Give the proposal to read: tng ${command} --file proposal.json`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const vault = loadVault(args);
  const scope: Scope = applyScope(vault, scopeFrom(args));
  return { vault, scope, ...evaluateProposal(vault, scope, raw) };
}

function commandValidate(args: Args): { output: string; ok: boolean } {
  const { report } = readAndEvaluate(args, 'validate');
  if (args.flags.get('format') === 'json') {
    return { output: JSON.stringify(report, null, 2), ok: report.ok };
  }
  return { output: renderReport(report), ok: report.ok };
}

/**
 * Apply a proposal to the notes themselves.
 *
 * A dry run by default. `--write` is the only thing that touches a file, and it is
 * refused outright when validation found a blocker — the report is the gate, not a
 * suggestion.
 */
function commandApply(args: Args): { output: string; ok: boolean } {
  const evaluation = readAndEvaluate(args, 'apply');
  const { vault, scope, report } = evaluation;
  const write = args.booleans.has('write');
  const undoOut = args.flags.get('undo-out');

  const plan = planFor(vault, scope, evaluation);
  const lines = [renderReport(report)];

  if (!report.ok) {
    const onlyCycles = onlyCycleErrors(report);
    if (!(onlyCycles && args.booleans.has('allow-cycles'))) {
      lines.push('Nothing was written: fix the errors above and run again.');
      if (onlyCycles) {
        lines.push(
          'Every error above is a circular dependency this change would restore. If you ' +
            'are undoing an earlier apply, pass `--allow-cycles` to put the loop back.'
        );
      }
      return { output: lines.join('\n'), ok: false };
    }
    lines.push('Applying anyway: `--allow-cycles` was given, and every error is a loop.');
  }

  if (plan.writes.length === 0) {
    lines.push('No note needs changing.');
    return { output: lines.join('\n'), ok: true };
  }

  lines.push('## Files');
  lines.push('');
  for (const item of plan.writes) {
    lines.push(`- \`${item.path}\` — ${touchedKeys(item).join(', ')}`);
  }
  lines.push('');

  if (!write) {
    lines.push('Dry run. Nothing was written. Add `--write` to apply this.');
    return { output: lines.join('\n'), ok: true };
  }

  // The undo goes to disk before the notes do, so an interrupted batch is still
  // recoverable — the file naming what to put back exists before anything is changed.
  if (undoOut !== undefined) {
    fs.writeFileSync(undoOut, `${JSON.stringify(plan.undo, null, 2)}\n`, 'utf8');
    lines.push(`Undo written to \`${undoOut}\`. Apply it to put everything back.`);
  }

  const written = writePlan(vault.vaultPath, plan);
  lines.push(`Wrote ${written.length} note${written.length === 1 ? '' : 's'}.`);
  if (undoOut === undefined) {
    lines.push('No undo file was requested. Use `--undo-out undo.json` to make this reversible.');
  }
  return { output: lines.join('\n'), ok: true };
}

/**
 * Lay out a schedule from scratch and emit it as a proposal.
 *
 * Writes no note. The output is an ordinary proposal, so it goes through `validate`
 * and `apply` like anything an agent wrote by hand — there is no privileged path for
 * dates this tool generated itself.
 */
function commandSchedule(args: Args): string {
  const start = parseTaskDate(args.flags.get('start'));
  const deadline = parseTaskDate(args.flags.get('deadline'));
  if (start === null && deadline === null) {
    throw new Error(
      'Say where to schedule from: --start YYYY-MM-DD to lay work out forward, or ' +
        '--deadline YYYY-MM-DD to work back from a date it must be finished by.'
    );
  }
  if (start !== null && deadline !== null) {
    throw new Error(
      'Give --start or --deadline, not both. Forward from a start and backward from a ' +
        'deadline are different questions, and answering both at once would mean ' +
        'silently preferring one.'
    );
  }

  const vault = loadVault(args);
  const scope = applyScope(vault, scopeFrom(args));
  if (scope.tasks.length === 0) {
    throw new Error(`Nothing to schedule: no task matches ${scope.description}.`);
  }

  const result = autoschedule({
    tasks: scope.tasks,
    settings: vault.settings,
    catalog: vault.catalog,
    now: Date.now(),
    ...(start === null ? {} : { startMs: start.ms }),
    ...(deadline === null ? {} : { deadlineMs: deadline.ms }),
    level: args.booleans.has('level'),
    ...(args.flags.get('rounds') === undefined
      ? {}
      : { levellingRounds: Number(args.flags.get('rounds')) }),
    ...(args.flags.get('resource') === undefined
      ? {}
      : { resourceField: args.flags.get('resource') as string })
  });

  const ids = buildIdMap(scope.tasks);
  const operations = buildScheduleProposal(scope.tasks, result, ids, vault.settings);
  const direction =
    start === null ? `backward from ${deadline?.raw}` : `forward from ${start.raw}`;
  const proposal = {
    version: 1,
    rationale: `Scheduled ${scope.description} ${direction}${
      args.booleans.has('level') ? ', levelled against resource capacity' : ''
    }.`,
    operations
  };

  const out = args.flags.get('out');
  if (out !== undefined) {
    fs.writeFileSync(out, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  }

  if (args.flags.get('format') === 'json' && out === undefined) {
    return JSON.stringify(proposal, null, 2);
  }

  const lines = [
    `# Schedule — ${scope.description}, ${direction}`,
    '',
    `${operations.length} of ${scope.tasks.length} task(s) would move.`,
    ''
  ];
  for (const note of result.notes) lines.push(`- ${note}`);
  if (result.notes.length > 0) lines.push('');

  if (operations.length > 0) {
    lines.push('| task | start | due |');
    lines.push('| --- | --- | --- |');
    for (const op of operations.slice(0, 60)) {
      if (op.op !== 'set_dates') continue;
      lines.push(`| ${op.id} | ${op.scheduled ?? '—'} | ${op.due ?? '—'} |`);
    }
    if (operations.length > 60) lines.push(`| … | ${operations.length - 60} more | |`);
    lines.push('');
  }

  lines.push(
    out === undefined
      ? 'Nothing was written. Add `--out proposal.json` to save this, then check it with `tng validate`.'
      : `Proposal written to \`${out}\`. Check it with \`tng validate --file ${out}\` before applying.`
  );
  return lines.join('\n');
}

const HELP = `tng — TaskNotes Gantt, headless

Reads a vault with the same code the Gantt chart uses, so what you see here is what
the chart sees.

Commands
  snapshot          The project state: problems, uncertainty, critical path, tasks
  doctor            Problems and uncertainty only, without the task table
  validate          What a proposal would change, break and fix. Writes nothing.
  apply             The same, and then write it. A dry run unless --write is given.
  schedule          Lay out a schedule from scratch, as a proposal. Writes nothing.
  help              This text

Schedule
  --start D         Lay the work out forward from this date
  --deadline D      Or backward from the date it must be finished by
  --level           Also push work off days a resource is over capacity
  --resource F      Field naming the resource to level against, e.g. contexts
  --rounds N        Levelling rounds before giving up. Default 50.
  --out F           Save the proposal here, ready for validate and apply

  Finished tasks stay where they are, and tasks inside a circular dependency are left
  alone: neither has a meaningful earliest start. Spans are whole working days,
  because that is the only granularity an all-day date survives being read back at.

Validate and apply
  --file F          The proposal, as JSON
  --write           apply only: edit the notes. Refused if validation found an error.
  --undo-out F      apply only: write the proposal that puts everything back.
  --allow-cycles    apply only: write even though the change restores a circular
                    dependency. Only an undo file should routinely need this.
  Use the same scope flags you used for the snapshot it was written against.

  Writes edit only the keys the proposal names, in place. They go through the file
  rather than through TaskNotes, so dateModified is not updated; Obsidian's watcher
  re-indexes the change the same way it would an edit from any external editor.

Scope (combine freely; they narrow together)
  --initiative X    Tasks whose user-defined initiative field is X
  --project X       Tasks in a project whose name contains X
  --status X        Tasks with status X (comma-separated for several)
  --from D --to D   Tasks whose dates overlap the window, as YYYY-MM-DD
  --all             Include archived tasks, which are excluded by default

Output
  --format json     Machine-readable, rather than the default markdown brief
  --detail A,B      Expand these task ids in full beneath the table
  --summary         Omit the task table

Other
  --vault PATH      The vault to read. Defaults to the nearest one above the cwd.

The same four capabilities are available to an AI agent over MCP: run
bin/tng-mcp.mjs --vault <path> and see docs/development.md for the registration.

A date shown as ~2026-04-15 was inferred by the chart, not read from the note.
`;

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);

  try {
    switch (args.command) {
      case 'snapshot':
        process.stdout.write(`${commandSnapshot(args)}\n`);
        return 0;
      case 'doctor':
        process.stdout.write(`${commandDoctor(args)}\n`);
        return 0;
      case 'validate': {
        const result = commandValidate(args);
        process.stdout.write(`${result.output}\n`);
        // A non-zero exit lets a caller branch on the outcome without parsing the text.
        return result.ok ? 0 : 3;
      }
      case 'apply': {
        const result = commandApply(args);
        process.stdout.write(`${result.output}\n`);
        return result.ok ? 0 : 3;
      }
      case 'schedule':
        process.stdout.write(`${commandSchedule(args)}\n`);
        return 0;
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
