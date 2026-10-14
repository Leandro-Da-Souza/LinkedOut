import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import type { Application } from './app.js';
import { publicError } from '../domain/errors.js';

export function createMcpServer(
  app: Application,
  shutdownSignal: AbortSignal,
  active: Set<Promise<unknown>> = new Set(),
): McpServer {
  const server = new McpServer(
    { name: 'linkedout', version: '0.1.0' },
    { maxToolInputElements: 200 },
  );
  for (const tool of app.tools.all()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: tool.readOnly,
          openWorldHint: !tool.readOnly,
        },
      },
      async (input, ctx) => {
        const operation = (async () => {
          try {
            const result = await app.tools.invoke(tool.name, input, {
              actor: 'mcp',
              permissions: new Set(['read_local', 'draft_local']),
              signal: AbortSignal.any([ctx.mcpReq.signal, shutdownSignal]),
            });
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(result) },
              ],
              structuredContent: result as Record<string, unknown>,
            };
          } catch (error) {
            const safe = publicError(error);
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: { code: safe.code, message: safe.message },
                  }),
                },
              ],
            };
          }
        })();
        active.add(operation);
        try {
          return await operation;
        } finally {
          active.delete(operation);
        }
      },
    );
  }
  return server;
}

export function startMcp(
  app: Application,
  transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 128 * 1024,
  }),
) {
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  const handle = serveStdio(
    () => createMcpServer(app, controller.signal, active),
    {
      legacy: 'serve',
      transport,
      onerror: () => {
        process.stderr.write(
          '{"error":{"code":"PROTOCOL_ERROR","message":"MCP transport error."}}\n',
        );
      },
    },
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    controller.abort();
    try {
      await handle.close();
    } finally {
      // Transport teardown does not wait for application handlers. Let cancelled
      // requests finish their audit writes before closing SQLite.
      await Promise.allSettled([...active]);
      app.close();
      app.logger.log({ event: 'server_stopped' });
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.stdin.removeListener('end', onSignal);
    }
  };
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', onSignal);
  app.logger.log({ event: 'server_started' });
  return { close };
}
