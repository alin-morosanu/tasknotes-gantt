import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, defaultVaultFrom } from '../mcp/server';
import { note, readAll, removeScratchVaults, scratchVault } from './fixtures/vault';

/**
 * The MCP server, driven over a real transport.
 *
 * These go through `tools/call` rather than reaching into the handlers, because the
 * things most likely to be wrong live in the wiring: a schema that rejects a valid
 * argument, a result shape the protocol will not carry, a tool that writes when it was
 * asked for a dry run.
 */

interface Response {
  id: number;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; tools?: unknown[] };
  error?: { message: string };
}

/** A minimal client: enough JSON-RPC to open a session and call a tool. */
function connect(vaultPath: string | null) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ defaultVault: vaultPath });
  const pending = new Map<number, (r: Response) => void>();
  let nextId = 1;

  clientSide.onmessage = (message: unknown) => {
    const response = message as Response;
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  };

  const ready = (async () => {
    await server.connect(serverSide);
    await clientSide.start();
  })();

  const request = async (method: string, params: unknown): Promise<Response> => {
    await ready;
    const id = nextId++;
    const answer = new Promise<Response>((resolve) => pending.set(id, resolve));
    await clientSide.send({ jsonrpc: '2.0', id, method, params } as never);
    return answer;
  };

  const open = async () => {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    });
    await ready;
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
  };

  return {
    open,
    request,
    async call(name: string, args: Record<string, unknown>) {
      const response = await this.request('tools/call', { name, arguments: args });
      return {
        text: (response.result?.content ?? []).map((c) => c.text ?? '').join('\n'),
        isError: response.result?.isError === true,
        error: response.error?.message
      };
    },
    async close() {
      await server.close();
    }
  };
}

const NOTES = {
  'BEL-0001 First.md': note('BEL-0001', {
    status: 'backlog',
    priority: 'high',
    scheduled: '2026-04-13',
    due: '2026-04-14',
    timeEstimate: '120'
  }),
  'BEL-0002 Second.md': note('BEL-0002', {
    status: 'backlog',
    priority: 'normal',
    scheduled: '2026-04-13',
    due: '2026-04-15',
    timeEstimate: '60'
  })
};

let vault: string;
let mcp: ReturnType<typeof connect>;

beforeEach(async () => {
  vault = scratchVault(NOTES);
  mcp = connect(vault);
  await mcp.open();
});

afterEach(async () => {
  await mcp.close();
  removeScratchVaults();
});

describe('the tool surface', () => {
  it('offers the four tools', async () => {
    const response = await mcp.request('tools/list', {});
    const tools = (response.result?.tools ?? []) as { name: string; description: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'gantt_apply',
      'gantt_schedule',
      'gantt_snapshot',
      'gantt_validate'
    ]);
  });

  it('tells the agent the things that make its answers correct', async () => {
    // These three are load-bearing. A model that misses any of them will confidently
    // reschedule around a date nobody chose, or write without checking.
    const response = await mcp.request('tools/list', {});
    const tools = (response.result?.tools ?? []) as { name: string; description: string }[];
    const by = (name: string) => tools.find((t) => t.name === name)?.description ?? '';

    expect(by('gantt_snapshot')).toContain('INFERRED');
    expect(by('gantt_apply')).toContain('DRY RUN');
    expect(by('gantt_validate')).toContain('before gantt_apply');
  });
});

describe('gantt_snapshot', () => {
  it('reads the vault it was started with', async () => {
    const { text, isError } = await mcp.call('gantt_snapshot', {});
    expect(isError).toBe(false);
    expect(text).toContain('2 of 2 tasks in the vault');
  });

  it('narrows to a scope', async () => {
    const { text } = await mcp.call('gantt_snapshot', { status: ['backlog'], summary: true });
    expect(text).toContain('status backlog');
  });

  it('returns the whole structure as json when asked', async () => {
    const { text } = await mcp.call('gantt_snapshot', { format: 'json' });
    const parsed = JSON.parse(text) as { tasks: { id: string }[] };
    expect(parsed.tasks.map((t) => t.id).sort()).toEqual(['BEL-0001', 'BEL-0002']);
  });

  it('says what is wrong rather than throwing', async () => {
    const unbound = connect(null);
    await unbound.open();
    const { text, isError } = await unbound.call('gantt_snapshot', {
      vault: '/definitely/not/a/vault'
    });
    await unbound.close();
    expect(isError).toBe(true);
    expect(text).toContain('Not an Obsidian vault');
  });
});

describe('the server is bound to one vault', () => {
  it('refuses a call that names a different vault', async () => {
    // An agent reads note text, note text can steer an agent, and gantt_apply writes.
    // A call that could name its own vault would let a note redirect writes elsewhere.
    const other = scratchVault(NOTES);
    const before = readAll(other);
    const { text, isError } = await mcp.call('gantt_apply', {
      vault: other,
      write: true,
      proposal: { version: 1, operations: [{ op: 'shift', id: 'BEL-0001', days: 3 }] }
    });
    expect(isError).toBe(true);
    expect(text).toContain('bound to');
    expect(readAll(other)).toEqual(before);
  });

  it('accepts the vault it was started with, named explicitly', async () => {
    const { isError } = await mcp.call('gantt_snapshot', { vault, summary: true });
    expect(isError).toBe(false);
  });
});

describe('gantt_apply writes nowhere but the vault', () => {
  it('offers no file path for the agent to choose', async () => {
    // It once took `undoOut` and wrote to it — any file the user could write, with
    // content partly chosen by the agent through the proposal's rationale.
    const response = await mcp.request('tools/list', {});
    const tools = (response.result?.tools ?? []) as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    const apply = tools.find((t) => t.name === 'gantt_apply');
    expect(Object.keys(apply?.inputSchema.properties ?? {})).not.toContain('undoOut');
  });

  it('ignores an undoOut it is handed anyway', async () => {
    const target = path.join(os.tmpdir(), `tng-should-not-exist-${Date.now()}.json`);
    await mcp.call('gantt_apply', {
      write: true,
      undoOut: target,
      proposal: { version: 1, operations: [{ op: 'shift', id: 'BEL-0001', days: 1 }] }
    });
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('gantt_validate', () => {
  it('approves a change that breaks nothing', async () => {
    const { text, isError } = await mcp.call('gantt_validate', {
      proposal: { version: 1, operations: [{ op: 'shift', id: 'BEL-0001', days: 2 }] }
    });
    expect(isError).toBe(false);
    expect(text).toContain('can be applied');
  });

  it('names the operation at fault and suggests the id that was meant', async () => {
    const { text } = await mcp.call('gantt_validate', {
      proposal: { version: 1, operations: [{ op: 'shift', id: 'BEL-9999', days: 2 }] }
    });
    expect(text).toContain('operation 0');
    expect(text).toContain('Did you mean BEL-0001');
  });

  it('is not an error just because the answer is no', async () => {
    // The tool did its job. Marking a negative verdict as a tool failure would teach
    // an agent to treat validation itself as unreliable.
    const { isError } = await mcp.call('gantt_validate', {
      proposal: { version: 1, operations: [{ op: 'shift', id: 'BEL-9999', days: 2 }] }
    });
    expect(isError).toBe(false);
  });
});

describe('gantt_apply', () => {
  const shift = { version: 1, operations: [{ op: 'shift', id: 'BEL-0001', days: 3 }] };

  it('is a dry run unless told otherwise', async () => {
    const before = readAll(vault);
    const { text, isError } = await mcp.call('gantt_apply', { proposal: shift });
    expect(isError).toBe(false);
    expect(text).toContain('Dry run');
    expect(readAll(vault)).toEqual(before);
  });

  it('writes when asked, and hands back the undo in the same answer', async () => {
    // The undo reaches the caller before the notes change, so an interrupted write is
    // still recoverable from what the call already returned.
    const before = readAll(vault);
    const { text } = await mcp.call('gantt_apply', { proposal: shift, write: true });
    expect(text).toContain('Wrote 1 note.');
    expect(readAll(vault)).not.toEqual(before);

    const undo = JSON.parse(text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```')));
    const back = await mcp.call('gantt_apply', { proposal: undo, write: true });
    expect(back.isError).toBe(false);
    expect(readAll(vault)).toEqual(before);
  });

  it('refuses to write a proposal that does not validate', async () => {
    const before = readAll(vault);
    const { text, isError } = await mcp.call('gantt_apply', {
      write: true,
      proposal: { version: 1, operations: [{ op: 'set_status', id: 'BEL-0001', status: 'nope' }] }
    });
    expect(isError).toBe(true);
    expect(text).toContain('Nothing was written');
    expect(readAll(vault)).toEqual(before);
  });

  it('refuses a restored cycle until allowCycles says otherwise', async () => {
    await mcp.call('gantt_apply', {
      write: true,
      proposal: {
        version: 1,
        operations: [{ op: 'add_dependency', id: 'BEL-0002', blockedBy: 'BEL-0001' }]
      }
    });
    const closing = {
      version: 1,
      operations: [{ op: 'add_dependency', id: 'BEL-0001', blockedBy: 'BEL-0002' }]
    };

    const refused = await mcp.call('gantt_apply', { proposal: closing, write: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('allowCycles');

    const forced = await mcp.call('gantt_apply', {
      proposal: closing,
      write: true,
      allowCycles: true
    });
    expect(forced.isError).toBe(false);
    expect(forced.text).toContain('Wrote 1 note.');
  });
});

describe('gantt_schedule', () => {
  it('lays work out forward and returns a proposal that validates', async () => {
    const { text, isError } = await mcp.call('gantt_schedule', { start: '2026-05-04' });
    expect(isError).toBe(false);

    const proposal = JSON.parse(text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```')));
    const checked = await mcp.call('gantt_validate', { proposal });
    expect(checked.text).toContain('can be applied');
  });

  it('insists on a direction', async () => {
    const missing = await mcp.call('gantt_schedule', {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Say where to schedule from');

    const both = await mcp.call('gantt_schedule', { start: '2026-05-04', deadline: '2026-06-01' });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('not both');
  });

  it('says so rather than scheduling nothing', async () => {
    const { text, isError } = await mcp.call('gantt_schedule', {
      start: '2026-05-04',
      project: ['nothing matches this']
    });
    expect(isError).toBe(true);
    expect(text).toContain('Nothing to schedule');
  });

  it('writes nothing, whatever it returns', async () => {
    const before = readAll(vault);
    await mcp.call('gantt_schedule', { start: '2026-05-04' });
    expect(readAll(vault)).toEqual(before);
  });
});

describe('defaultVaultFrom', () => {
  it('takes the path after --vault', () => {
    expect(defaultVaultFrom(['--vault', '/some/vault'])).toBe('/some/vault');
  });

  it('ignores a --vault with no path after it', () => {
    // Otherwise the next flag becomes the vault path and the failure is baffling.
    expect(defaultVaultFrom(['--vault', '--debug'])).not.toBe('--debug');
  });
});
