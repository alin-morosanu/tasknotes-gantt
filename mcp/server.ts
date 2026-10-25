import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { findVault, readVault, type VaultData } from '../cli/vault';
import { writePlan } from '../cli/apply';
import {
  applyScope,
  evaluateProposal,
  onlyCycleErrors,
  planFor,
  renderUnreadable,
  snapshotFor,
  touchedKeys,
  type Scope,
  type ScopeOptions
} from '../cli/session';
import { renderBrief } from '../src/agent/brief';
import { renderReport } from '../src/agent/diff';
import { parseTaskDate } from '../src/model/dates';
import { autoschedule, buildScheduleProposal } from '../src/agent/autoschedule';

/**
 * The Gantt chart's scheduling brain, over MCP.
 *
 * Four tools onto the same pure core the plugin and the CLI use, so an agent's view of
 * a plan and the user's chart cannot drift. Everything an agent needs that a human does
 * not — stable short ids, an authored/inferred flag on every date, and a validator it
 * can check its own reasoning against — is in the payloads rather than in the prose.
 *
 * The vault is re-read on every call. A cache would be faster and would eventually
 * answer from a plan that no longer exists on disk, which is the one failure this whole
 * design exists to prevent.
 */

const SCOPE_SHAPE = {
  initiative: z
    .array(z.string())
    .optional()
    .describe('Values of the user-defined initiative field. Exact, case-insensitive.'),
  project: z
    .array(z.string())
    .optional()
    .describe('Substrings of a project name, e.g. "Relaunch" for "PRJ-01 Website Relaunch".'),
  status: z.array(z.string()).optional().describe('Status values as configured in this vault.'),
  from: z.string().optional().describe('Window start, YYYY-MM-DD. Tasks overlapping it are kept.'),
  to: z.string().optional().describe('Window end, YYYY-MM-DD.'),
  includeArchived: z.boolean().optional().describe('Archived tasks are excluded unless true.'),
  vault: z
    .string()
    .optional()
    .describe('Path to the vault. Only needed when the server was started without --vault; otherwise it must match.')
};

const PROPOSAL_SHAPE = z
  .object({
    version: z.literal(1).optional(),
    rationale: z.string().optional().describe('Why this change. Carried into the report.'),
    operations: z.array(z.record(z.string(), z.unknown()))
  })
  .describe(
    'A change set. Each operation names one task by its short id and one intent: ' +
      'set_dates, shift, set_estimate, add_dependency, remove_dependency, set_status, set_field.'
  );

function scopeOptionsFrom(args: Record<string, unknown>): ScopeOptions {
  const options: ScopeOptions = {};
  if (Array.isArray(args['initiative'])) options.initiatives = args['initiative'] as string[];
  if (Array.isArray(args['project'])) options.projects = args['project'] as string[];
  if (Array.isArray(args['status'])) options.statuses = args['status'] as string[];
  if (typeof args['from'] === 'string') options.from = args['from'];
  if (typeof args['to'] === 'string') options.to = args['to'];
  if (args['includeArchived'] === true) options.includeArchived = true;
  return options;
}

/** Text-only result, which is what every one of these tools returns. */
function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/** An error the agent can act on, rather than a stack trace. */
function failure(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

export interface ServerOptions {
  /** The vault to read when a call does not name one. */
  defaultVault: string | null;
}

function load(options: ServerOptions, args: Record<string, unknown>): VaultData {
  const named = typeof args['vault'] === 'string' ? args['vault'] : null;
  // The vault the user started the server with is the only one an agent may touch.
  // An agent reads note text, note text can steer an agent, and `gantt_apply` writes —
  // so letting a call name its own vault would let a note redirect writes elsewhere.
  if (
    named !== null &&
    options.defaultVault !== null &&
    path.resolve(named) !== path.resolve(options.defaultVault)
  ) {
    throw new Error(
      `This server is bound to ${options.defaultVault} and will not open another vault. ` +
        'Start a second server with --vault to work on a different one.'
    );
  }
  const vaultPath = named ?? options.defaultVault;
  if (vaultPath === null) {
    throw new Error(
      'No vault to read. Start the server with --vault <path>, or pass `vault` in the call.'
    );
  }
  return readVault(vaultPath);
}

function scoped(options: ServerOptions, args: Record<string, unknown>): {
  vault: VaultData;
  scope: Scope;
} {
  const vault = load(options, args);
  return { vault, scope: applyScope(vault, scopeOptionsFrom(args)) };
}

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'tasknotes-gantt', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'gantt_snapshot',
    {
      title: 'Project snapshot',
      description: [
        'The state of a plan: problems, what the plan does not know, the critical path,',
        'and a table of tasks.',
        '',
        'Read this before proposing anything. Two things in it carry more weight than',
        'the rest. A date shown as ~2026-04-15 was INFERRED by the chart, not written',
        'in the note — it is a guess, not a commitment, and rescheduling around it as',
        'though someone chose it is the most common way to get this wrong. And the',
        '"what this snapshot does not know" section states where the numbers are',
        'incomplete: tasks with no estimate contribute nothing to capacity, dangling',
        'links point at notes that do not exist, and tasks inside a cycle are excluded',
        'from scheduling entirely.',
        '',
        'Tasks are named by short stable ids (BEL-0002, TASK-0610). Use those ids in',
        'every proposal; they are shorter than paths and far harder to get subtly wrong.'
      ].join('\n'),
      inputSchema: z.object({
        ...SCOPE_SHAPE,
        format: z
          .enum(['brief', 'json'])
          .optional()
          .describe('brief is compact markdown and the default; json is the full structure.'),
        detail: z.array(z.string()).optional().describe('Task ids to expand in full below the table.'),
        summary: z
          .boolean()
          .optional()
          .describe('Omit the task table, leaving problems, totals and anything unreadable.')
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        const { vault, scope } = scoped(options, args);
        const snapshot = snapshotFor(vault, scope);
        if (args.format === 'json') return text(JSON.stringify(snapshot, null, 2));
        // Unreadable notes ride along with the brief, so the MCP door reports every
        // gap the CLI's `doctor` does and neither is the more complete view.
        return text(
          [
            renderBrief(snapshot, {
              detail: args.detail ?? [],
              summaryOnly: args.summary === true
            }),
            ...renderUnreadable(vault)
          ].join('\n')
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    'gantt_validate',
    {
      title: 'Check a proposal',
      description: [
        'What a proposal would change, break and fix — without touching a file.',
        '',
        'This is the loop: propose, check, revise. It separates three things that need',
        'weighing differently. ERRORS block the change: an unknown id, a date it cannot',
        'read, a dependency cycle the change would create. REGRESSIONS are real costs to',
        'judge: conflicts introduced, capacity breached, the end of the plan pushed out.',
        'IMPROVEMENTS are what it fixes.',
        '',
        'Every error names the operation it came from, so fix them by index. Run this',
        'before gantt_apply; apply refuses a proposal that does not validate anyway.',
        '',
        'Use the same scope you used for the snapshot the proposal was written against,',
        'or its ids will not resolve.'
      ].join('\n'),
      inputSchema: z.object({ ...SCOPE_SHAPE, proposal: PROPOSAL_SHAPE }),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        const { vault, scope } = scoped(options, args);
        const { report } = evaluateProposal(vault, scope, args.proposal);
        return text(renderReport(report));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    'gantt_apply',
    {
      title: 'Apply a proposal',
      description: [
        'Write a proposal into the notes. A DRY RUN unless `write` is true: without it,',
        'this reports exactly what it would do and changes nothing.',
        '',
        'Only the keys the proposal names are edited, in place — key order, quoting,',
        'comments and the note body are left alone. The result carries the proposal that',
        'would undo the change; keep it if the change might need reversing.',
        '',
        'A proposal with errors is refused. The single exception is a change that',
        'restores a dependency cycle, which an undo of a cycle-breaking change always',
        'does: pass allowCycles to put the loop back.',
        '',
        'Writes go through the file rather than the TaskNotes API, so `dateModified` is',
        "not updated. Obsidian's watcher re-indexes the change like any external edit."
      ].join('\n'),
      inputSchema: z.object({
        ...SCOPE_SHAPE,
        proposal: PROPOSAL_SHAPE,
        write: z.boolean().optional().describe('Edit the notes. Omit for a dry run.'),
        allowCycles: z
          .boolean()
          .optional()
          .describe('Write even though the change restores a cycle. Only an undo should need this.')
      }),
      annotations: { destructiveHint: true }
    },
    async (args) => {
      try {
        const { vault, scope } = scoped(options, args);
        const evaluation = evaluateProposal(vault, scope, args.proposal);
        const { report } = evaluation;
        const plan = planFor(vault, scope, evaluation);
        const lines = [renderReport(report)];

        if (!report.ok) {
          const cyclesOnly = onlyCycleErrors(report);
          if (!(cyclesOnly && args.allowCycles === true)) {
            lines.push('Nothing was written: fix the errors above and call again.');
            if (cyclesOnly) {
              lines.push(
                'Every error above is a circular dependency this change would restore. If ' +
                  'this is an undo, pass allowCycles to put the loop back.'
              );
            }
            return { ...text(lines.join('\n')), isError: true };
          }
          lines.push('Applying anyway: allowCycles was given, and every error is a loop.');
        }

        if (plan.writes.length === 0) {
          lines.push('No note needs changing.');
          return text(lines.join('\n'));
        }

        lines.push('## Files');
        lines.push('');
        for (const item of plan.writes) {
          lines.push(`- \`${item.path}\` — ${touchedKeys(item).join(', ')}`);
        }
        lines.push('');

        if (args.write !== true) {
          lines.push('Dry run. Nothing was written. Call again with write: true to apply this.');
          return text(lines.join('\n'));
        }

        // The undo reaches the caller before the notes change, so an interrupted write
        // is still recoverable from what this call already returned.
        lines.push('## Undo');
        lines.push('');
        lines.push('Apply this proposal to put everything back:');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(plan.undo, null, 2));
        lines.push('```');
        lines.push('');

        const written = writePlan(vault.vaultPath, plan);
        lines.push(`Wrote ${written.length} note${written.length === 1 ? '' : 's'}.`);
        return text(lines.join('\n'));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    'gantt_schedule',
    {
      title: 'Schedule from scratch',
      description: [
        'Lay work out over the working calendar and the dependency network, and return',
        'the proposal that would do it. Writes nothing: check it with gantt_validate and',
        'write it with gantt_apply, like any proposal.',
        '',
        'Give `start` to lay the work out forward, or `deadline` to work backward from a',
        'date it must be finished by — not both. A backward pass will schedule into the',
        'past rather than clamp, because whether the deadline is reachable at all is the',
        'thing worth knowing; the notes say so when it is not.',
        '',
        'Each task keeps the length it has now — the span between its dates, or its',
        'estimate where it has no span. This lays the plan out again; it does not',
        're-estimate it. Finished tasks are never moved, and tasks inside a cycle are',
        'left alone because they have no earliest start.',
        '',
        'Read the notes in the result before trusting the dates. They say where the plan',
        'rests on a guess.'
      ].join('\n'),
      inputSchema: z.object({
        ...SCOPE_SHAPE,
        start: z.string().optional().describe('Lay work out forward from this date, YYYY-MM-DD.'),
        deadline: z.string().optional().describe('Or backward from the date it must be done by.'),
        level: z.boolean().optional().describe('Also push work off days a resource is over capacity.'),
        resource: z
          .string()
          .optional()
          .describe('Field naming the resource to level against, e.g. "contexts". Defaults to the chart setting.'),
        rounds: z.number().int().positive().optional().describe('Levelling rounds before giving up. Default 50.')
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      try {
        const start = parseTaskDate(args.start);
        const deadline = parseTaskDate(args.deadline);
        if (start === null && deadline === null) {
          throw new Error(
            'Say where to schedule from: `start` to lay work out forward, or `deadline` to ' +
              'work back from a date it must be finished by.'
          );
        }
        if (start !== null && deadline !== null) {
          throw new Error(
            'Give start or deadline, not both. Forward from a start and backward from a ' +
              'deadline are different questions, and answering both at once would mean ' +
              'silently preferring one.'
          );
        }

        const { vault, scope } = scoped(options, args);
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
          level: args.level === true,
          ...(args.resource === undefined ? {} : { resourceField: args.resource }),
          ...(args.rounds === undefined ? {} : { levellingRounds: args.rounds })
        });

        const operations = buildScheduleProposal(
          scope.tasks,
          result,
          // Ids come from the same scope the caller will validate against.
          evaluateProposal(vault, scope, { version: 1, operations: [] }).ids,
          vault.settings
        );
        const direction =
          start === null ? `backward from ${deadline?.raw}` : `forward from ${start.raw}`;
        const proposal = {
          version: 1,
          rationale: `Scheduled ${scope.description} ${direction}${
            args.level === true ? ', levelled against resource capacity' : ''
          }.`,
          operations
        };

        const lines = [
          `# Schedule — ${scope.description}, ${direction}`,
          '',
          `${operations.length} of ${scope.tasks.length} task(s) would move.`,
          ''
        ];
        for (const note of result.notes) lines.push(`- ${note}`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(proposal, null, 2));
        lines.push('```');
        return text(lines.join('\n'));
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}

/** Read `--vault <path>` from the command line, falling back to the cwd's vault. */
export function defaultVaultFrom(argv: readonly string[]): string | null {
  const index = argv.indexOf('--vault');
  const named = index === -1 ? undefined : argv[index + 1];
  if (named !== undefined && !named.startsWith('--')) return named;
  return findVault(process.cwd());
}

export function main(argv: readonly string[]): void {
  const defaultVault = defaultVaultFrom(argv);
  // One factory, one registration pass: the SDK pins an instance per connection.
  serveStdio(() => createServer({ defaultVault }), {
    // stdout is the protocol channel; anything written there that is not a JSON-RPC
    // message corrupts the stream, so errors go to stderr.
    onerror: (error) => process.stderr.write(`${error.message}\n`)
  });
}
