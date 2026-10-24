import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createAppClient, createEventBuffer, RpcFailure } from '../src/client.js';

async function fakeServer() {
  const dir = await mkdtemp(join(tmpdir(), 'dot-mcp-'));
  const socketPath = join(dir, 'server.sock');
  const http = await import('node:http');
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  server.listen(socketPath);
  await once(server, 'listening');
  const requests: Record<string, any>[] = [];
  const connections: Record<string, any>[][] = [];
  let dropInput = false;
  let holdInput = false;
  let denyRegistration = false;
  ws.on('connection', (socket) => {
    const messages: Record<string, any>[] = [];
    connections.push(messages);
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      messages.push(request);
      if (request.id === undefined) return;
      if (request.method === 'thread/control/input' && holdInput) return;
      if (request.method === 'thread/control/input' && dropInput) {
        socket.terminate();
        return;
      }
      if (request.method === 'controller/register' && denyRegistration) {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unsupported controller' } }));
        return;
      }
      const results: Record<string, unknown> = {
        initialize: { userAgent: 'test-codex/0.164.0' },
        'thread/list': { data: [{ id: 'test-thread', status: { type: 'idle' } }], nextCursor: null },
        'thread/loaded/list': { data: ['test-thread'], nextCursor: null },
        'thread/read': { thread: { id: 'test-thread' } },
        'thread/control/read': { state: { grant: null, turnRunning: false } },
        'thread/control/request': { state: { request: { status: 'pending' }, grant: null } },
        'thread/control/input': { turnId: 'accepted-turn' },
      };
      socket.send(JSON.stringify({ id: request.id, result: results[request.method] ?? {} }));
    });
  });
  return {
    socketPath,
    requests,
    connections,
    observeApproval: () => {
      for (const socket of ws.clients) {
        socket.send(
          JSON.stringify({
            method: 'serverRequest/observed',
            params: {
              request: {
                id: 'human-approval',
                method: 'item/commandExecution/requestApproval',
                params: { threadId: 'test-thread', command: 'example' },
              },
            },
          }),
        );
      }
    },
    dropInput: () => {
      dropInput = true;
    },
    holdInput: () => {
      holdInput = true;
    },
    denyRegistration: () => {
      denyRegistration = true;
    },
    close: async () => {
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function mcpProcess(socketPath: string | undefined) {
  const child = spawn(process.execPath, ['dist/src/index.js'], {
    env: { ...process.env, ...(socketPath ? { CODEX_APP_SERVER_SOCKET: socketPath } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
    else request?.resolve(message.result);
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error(`MCP exited: ${stderr}`));
    pending.clear();
  });
  function call(method: string, params: unknown) {
    return new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function initialize() {
    const result = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dot-mcp-test', version: '1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  }
  async function close() {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    lines.close();
  }
  return { child, call, initialize, close };
}

function textResult(result: any) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

test(
  'stdio tools enforce the controller boundary and preserve exact mutation arguments',
  { timeout: 15_000 },
  async () => {
    const fake = await fakeServer();
    const mcp = mcpProcess(fake.socketPath);
    try {
      await mcp.initialize();
      assert.deepEqual(
        fake.connections[0]?.slice(0, 4).map((message) => message.method),
        ['initialize', 'initialized', 'controller/register', 'event/firehose'],
      );
      assert.deepEqual(fake.connections[0]?.[2]?.params, { controllerId: 'dot' });
      const catalog = await mcp.call('tools/list', {});
      const names = catalog.tools.map((tool: any) => tool.name);
      assert(names.includes('send_message'));
      assert(!names.some((name: string) => /approve|start_thread|rpc/.test(name)));
      textResult(await mcp.call('tools/call', { name: 'list_threads', arguments: {} }));
      const listing = fake.requests.find((request) => request.method === 'thread/list')!;
      assert(listing.params.sourceKinds.includes('subAgent'));
      assert.deepEqual(listing.params.modelProviders, []);
      const beforeInvalid = fake.requests.length;
      const invalid = await mcp.call('tools/call', {
        name: 'send_message',
        arguments: {
          threadId: 'test-thread',
          grantId: 'grant',
          text: 'hello',
          controllerId: 'other',
          approvalPolicy: 'never',
        },
      });
      assert.equal(invalid.isError, true);
      assert.equal(fake.requests.length, beforeInvalid);
      const pending = textResult(
        await mcp.call('tools/call', {
          name: 'request_control',
          arguments: {
            threadId: 'test-thread',
            requestId: 'attempt-1',
            reason: 'User requested a follow-up',
          },
        }),
      );
      assert.equal(pending.state.request.status, 'pending');
      assert(!fake.requests.some((request) => request.method === 'thread/control/input'));
      const accepted = textResult(
        await mcp.call('tools/call', {
          name: 'send_message',
          arguments: {
            threadId: 'test-thread',
            grantId: 'grant',
            text: 'hello',
            expectedTurnId: 'active-turn',
          },
        }),
      );
      assert.equal(accepted.turnId, 'accepted-turn');
      const input = fake.requests.find((request) => request.method === 'thread/control/input')!;
      assert.deepEqual(input.params, {
        threadId: 'test-thread',
        grantId: 'grant',
        expectedTurnId: 'active-turn',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      });
      fake.dropInput();
      const uncertain = await mcp.call('tools/call', {
        name: 'send_message',
        arguments: {
          threadId: 'test-thread',
          grantId: 'grant',
          text: 'do not replay',
        },
      });
      assert.equal(uncertain.isError, true);
      assert.equal(JSON.parse(uncertain.content[0].text).outcomeUnknown, true);
      textResult(await mcp.call('tools/call', { name: 'read_control', arguments: { threadId: 'test-thread' } }));
      assert.equal(fake.requests.filter((request) => request.method === 'thread/control/input').length, 2);
      assert.equal(fake.connections.length, 2);
      assert.equal(fake.connections[1]?.[2]?.method, 'controller/register');
      fake.observeApproval();
      // A subsequent RPC response follows the notification on the same WebSocket.
      await mcp.call('tools/call', { name: 'read_control', arguments: { threadId: 'test-thread' } });
      const events = textResult(await mcp.call('tools/call', { name: 'read_events', arguments: {} }));
      assert(
        events.events.some(
          (event: any) => event.method === 'serverRequest/observed' && event.params.request.id === 'human-approval',
        ),
      );
      assert(!fake.requests.some((request) => request.id === 'human-approval'));
    } finally {
      await mcp.close();
      await fake.close();
    }
  },
);

test('unsupported controller registration fails closed before tools are exposed', { timeout: 10_000 }, async () => {
  const fake = await fakeServer();
  fake.denyRegistration();
  const mcp = mcpProcess(fake.socketPath);
  try {
    await assert.rejects(mcp.initialize(), /Unsupported controller/);
    assert(!fake.requests.some((request) => request.method === 'event/firehose'));
  } finally {
    await mcp.close();
    await fake.close();
  }
});

test('timed-out input reports uncertainty and is never replayed on reconnect', { timeout: 10_000 }, async () => {
  const fake = await fakeServer();
  const client = createAppClient(fake.socketPath, 100);
  try {
    await client.connect();
    // Suppress the response while retaining the connection to exercise the deadline path.
    fake.holdInput();
    await assert.rejects(
      client.call('thread/control/input', { threadId: 'test-thread' }),
      (error: unknown) =>
        error instanceof RpcFailure && error.details.outcomeUnknown === true && /timed out/.test(error.message),
    );
    await client.call('thread/control/read', { threadId: 'test-thread' });
    assert.equal(fake.requests.filter((request) => request.method === 'thread/control/input').length, 1);
  } finally {
    client.close();
    await fake.close();
  }
});

test('bounded live events expose eviction, process resets and oversized omissions', () => {
  const buffer = createEventBuffer(1000);
  buffer.append('first', {});
  const cursor = buffer.read(undefined, 10).nextCursor;
  for (let index = 0; index < 20; index++) buffer.append('later', { text: 'x'.repeat(200) });
  assert.equal(buffer.read(cursor, 10).gap, true);
  assert.equal(buffer.read('old-process:1', 10).resetRequired, true);
  buffer.append('large', { text: 'x'.repeat(100_000) });
  assert.equal(buffer.read(undefined, 50).events.at(-1)?.omitted, true);
});

test(
  'live shared server: discover sessions and read this session through MCP',
  {
    skip: process.env.DOT_MCP_LIVE !== '1',
    timeout: 30_000,
  },
  async () => {
    const mcp = mcpProcess(undefined);
    try {
      await mcp.initialize();
      const invoke = async (name: string, args: unknown) =>
        textResult(await mcp.call('tools/call', { name, arguments: args }));
      const health = await invoke('connection_status', {});
      assert.equal(health.controllerId, 'dot');
      assert.equal(health.connected, true);
      const loaded = await invoke('list_loaded_threads', {});
      assert(Array.isArray(loaded.data));
      const saved = await invoke('list_threads', { limit: 2 });
      assert(Array.isArray(saved.data));
      const threadId = process.env.CODEX_THREAD_ID ?? loaded.data[0];
      assert(threadId, 'A loaded thread is required for the live test');
      const metadata = await invoke('read_thread', { threadId });
      assert.equal(metadata.thread.id, threadId);
      const control = await invoke('read_control', { threadId });
      assert.equal(control.state.threadId, threadId);
      await invoke('list_turns', { threadId, limit: 1 });
      await invoke('list_items', { threadId, limit: 1 });
      await invoke('read_events', {});
    } finally {
      await mcp.close();
    }
  },
);
