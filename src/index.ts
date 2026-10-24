import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAppClient, defaultSocketPath } from './client.js';
import { createMcpServer } from './server.js';

const client = createAppClient(defaultSocketPath());
try {
  // Fail closed: register the restricted connection before exposing any MCP tools.
  await client.connect();
  const handle = serveStdio(() => createMcpServer(client));
  const shutdown = () => {
    client.close();
    void handle.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', () => client.close());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  client.close();
  process.exitCode = 1;
}
