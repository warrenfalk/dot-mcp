import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';

const methods = [
  'initialize',
  'controller/register',
  'event/firehose',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
  'thread/resume',
  'thread/control/read',
  'thread/control/request',
  'thread/control/input',
  'thread/control/interrupt',
  'thread/control/release',
] as const;
type Method = (typeof methods)[number];
const mutations = new Set<Method>(['thread/control/input', 'thread/control/interrupt']);
const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function defaultSocketPath() {
  const socketPath =
    process.env.CODEX_APP_SERVER_SOCKET ??
    join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
  if (!isAbsolute(socketPath)) throw new Error('CODEX_APP_SERVER_SOCKET must be an absolute Unix socket path');
  return socketPath;
}

// A cursor belongs to one adapter process. Reconnects are recorded as gaps; events are not durable history.
export function createEventBuffer(maxBytes = 4 * 1024 * 1024) {
  const epoch = randomUUID();
  let sequence = 0;
  let bytes = 0;
  let droppedThrough = 0;
  const events: { sequence: number; bytes: number; event: Record<string, unknown> }[] = [];
  function append(method: string, params: unknown) {
    const serialized = JSON.stringify(params ?? null);
    const event = {
      cursor: `${epoch}:${++sequence}`,
      receivedAt: new Date().toISOString(),
      method,
      ...(Buffer.byteLength(serialized) > 64 * 1024
        ? {
            omitted: true,
            reason: 'Event exceeds 64 KiB; read paginated history.',
            originalBytes: Buffer.byteLength(serialized),
          }
        : { params }),
    };
    const size = Buffer.byteLength(JSON.stringify(event));
    events.push({ sequence, bytes: size, event });
    bytes += size;
    while (bytes > maxBytes && events.length) {
      const removed = events.shift()!;
      bytes -= removed.bytes;
      droppedThrough = removed.sequence;
    }
  }
  function read(after: string | undefined, limit: number) {
    const index = after?.lastIndexOf(':') ?? -1;
    const cursorEpoch = after?.slice(0, index);
    const position = after === undefined ? droppedThrough : Number(after.slice(index + 1));
    const resetRequired =
      after !== undefined &&
      (cursorEpoch !== epoch || !Number.isSafeInteger(position) || position < 0 || position > sequence);
    const start = resetRequired ? droppedThrough : position;
    const page = events.filter((entry) => entry.sequence > start).slice(0, limit);
    return {
      events: page.map((entry) => entry.event),
      nextCursor: `${epoch}:${page.at(-1)?.sequence ?? Math.max(start, droppedThrough)}`,
      hasMore: (page.at(-1)?.sequence ?? start) < sequence,
      gap:
        resetRequired ||
        (after !== undefined && position < droppedThrough) ||
        page.some(({ event }) => event.method === 'adapter/connected' || event.method === 'adapter/disconnected'),
      resetRequired,
      history:
        'Live observations only. Use read_thread/list_turns/list_items for authoritative history and read_control for permission.',
    };
  }
  return { append, read };
}

export function createAppClient(socketPath: string, timeoutMs = 15_000) {
  const events = createEventBuffer();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      method: Method;
    }
  >();
  let socket: WebSocket | undefined;
  let connecting: Promise<void> | undefined;
  let ready = false;
  let closed = false;
  let nextId = 0;
  let generation = 0;
  let serverInfo: unknown;

  function failPending(reason: string) {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(
        new RpcFailure(reason, {
          method: request.method,
          outcomeUnknown: mutations.has(request.method),
          recovery: 'Do not replay input or interrupt. Reconnect and reconcile thread history and control state.',
        }),
      );
      pending.delete(id);
    }
  }
  function send(method: Method, params: unknown): Promise<unknown> {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('App-server disconnected'));
    const currentSocket = socket;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Terminate on timeout so no later operation can race an outstanding registration or mutation.
        failPending('App-server request timed out');
        ready = false;
        currentSocket.terminate();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      currentSocket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) currentSocket.terminate();
      });
    });
  }
  async function open() {
    if (closed) throw new Error('Adapter is closed');
    ready = false;
    const connection = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection(socketPath),
      handshakeTimeout: timeoutMs,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    });
    socket = connection;
    connection.on('error', () => {
      /* The open/close handlers settle callers. */
    });
    connection.on('close', () => {
      if (socket !== connection) return;
      ready = false;
      failPending('App-server connection lost');
      events.append('adapter/disconnected', { generation, gap: true });
    });
    connection.on('message', (data) => {
      try {
        const message = envelope.parse(JSON.parse(data.toString()));
        if (message.method) {
          // Never answer requests. Controllers observe approvals but cannot resolve them.
          if (message.id === undefined) events.append(message.method, message.params);
          return;
        }
        if (typeof message.id !== 'number') return;
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error)
          request.reject(
            new RpcFailure(message.error.message, {
              ...message.error,
              method: request.method,
              outcomeUnknown: false,
            }),
          );
        else request.resolve(message.result);
      } catch {
        failPending('Invalid app-server message');
        connection.terminate();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('open', resolve);
        connection.once('error', reject);
        connection.once('close', () => reject(new Error('App-server closed during handshake')));
      });
      serverInfo = await send('initialize', {
        clientInfo: { name: 'dot-mcp', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      connection.send(JSON.stringify({ method: 'initialized' }));
      // This must be the first request after initialize, on every connection.
      await send('controller/register', { controllerId: 'dot' });
      await send('event/firehose', {});
      ready = true;
      events.append('adapter/connected', { generation: ++generation, gap: true });
    } catch (error) {
      connection.terminate();
      throw error;
    }
  }
  async function connect() {
    if (ready) return;
    if (!connecting)
      connecting = open().finally(() => {
        connecting = undefined;
      });
    await connecting;
  }
  async function call(
    method: Exclude<Method, 'initialize' | 'controller/register' | 'event/firehose'>,
    params: unknown,
  ) {
    await connect();
    return send(method, params);
  }
  function close() {
    closed = true;
    ready = false;
    failPending('Adapter shutting down');
    socket?.terminate();
  }
  return {
    connect,
    call,
    close,
    events,
    health: () => ({ connected: ready, generation, controllerId: 'dot', socketPath, serverInfo }),
  };
}

export type AppClient = ReturnType<typeof createAppClient>;
