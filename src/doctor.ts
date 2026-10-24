import { createAppClient, defaultSocketPath } from './client.js';

const client = createAppClient(defaultSocketPath());
try {
  await client.connect();
  const loaded = await client.call('thread/loaded/list', { limit: 100 });
  const control = process.env.CODEX_THREAD_ID
    ? await client.call('thread/control/read', { threadId: process.env.CODEX_THREAD_ID })
    : undefined;
  console.log(JSON.stringify({ ...client.health(), loaded, currentThreadControl: control }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.close();
}
