import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../infrastructure/config.js';
import { AppError } from '../domain/errors.js';
import { reportFailure } from './main.js';

const runProcess = promisify(execFile);
const draftResultSchema = z.object({
  draft: z.object({
    id: z.uuid(),
    body: z.string().min(1),
    status: z.literal('draft'),
    assessment: z.object({
      complete: z.literal(true),
      blocked: z.literal(false),
      metadata: z.object({ provider: z.string(), model: z.string() }),
    }),
  }),
});
const serverPath = fileURLToPath(new URL('./mcp.js', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.apiKey || !config.model)
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live verification requires OPENAI_API_KEY and OPENAI_MODEL. No live verification was completed.',
    );
  const env: Record<string, string> = {
    OPENAI_API_KEY: config.apiKey,
    OPENAI_MODEL: config.model,
    LINKEDOUT_DATA_DIR: config.dataDir,
    ...(config.knowledgeDir
      ? { LINKEDOUT_KNOWLEDGE_DIR: config.knowledgeDir }
      : {}),
    LINKEDOUT_RUN_TIMEOUT_MS: String(config.runTimeoutMs),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.LINKEDOUT_PROFILE_PATH
      ? { LINKEDOUT_PROFILE_PATH: process.env.LINKEDOUT_PROFILE_PATH }
      : {}),
  };
  async function connect() {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env,
      stderr: 'pipe',
    });
    // Drain safe operational stderr without printing or retaining provider inputs.
    transport.stderr?.on('data', () => {});
    const client = new Client({
      name: 'linkedout-live-smoke',
      version: '0.1.0',
    });
    try {
      await client.connect(transport);
    } catch {
      try {
        await transport.close();
      } catch {
        /* Keep the connection failure actionable and sanitized. */
      }
      throw new AppError(
        'PROTOCOL_ERROR',
        'Live verification could not connect to the MCP server. Check process permissions and configuration.',
      );
    }
    return client;
  }
  const client = await connect();
  let mcpId: string;
  try {
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === 'draft_post'))
      throw new AppError('INTERNAL_ERROR', 'Drafting tool was not discovered.');
    const result = await client.callTool(
      {
        name: 'draft_post',
        arguments: {
          brief:
            'Write a short general reflection on giving specific, useful code-review feedback. Do not claim personal experiences or research.',
          idempotencyKey: `smoke:mcp:${randomUUID()}`,
        },
      },
      { timeout: config.runTimeoutMs + 10_000 },
    );
    if (result.isError) {
      const block = result.content.find((item) => item.type === 'text');
      const parsed = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(block?.type === 'text' ? JSON.parse(block.text) : null);
      throw new AppError(
        'PROVIDER_ERROR',
        parsed.success
          ? `Live MCP verification failed: ${parsed.data.error.code}.`
          : 'Live MCP verification failed.',
      );
    }
    mcpId = draftResultSchema.parse(result.structuredContent).draft.id;
  } finally {
    await client.close();
  }
  const { stdout } = await runProcess(
    process.execPath,
    [
      cliPath,
      'agent',
      'run',
      '--brief',
      'Draft a concise general post about keeping technical documentation useful. Do not invent personal achievements or news.',
      '--idempotency-key',
      `smoke:agent:${randomUUID()}`,
    ],
    { env, timeout: config.runTimeoutMs + 10_000, maxBuffer: 1024 * 1024 },
  );
  const agentId = draftResultSchema.parse(JSON.parse(stdout)).draft.id;
  const restarted = await connect();
  try {
    for (const id of [mcpId, agentId]) {
      const result = await restarted.callTool({
        name: 'get_draft',
        arguments: { id },
      });
      if (
        result.isError ||
        draftResultSchema.parse(result.structuredContent).draft.id !== id
      ) {
        throw new AppError(
          'STORAGE_ERROR',
          'Live drafts were not retrievable after restart.',
        );
      }
    }
  } finally {
    await restarted.close();
  }
  process.stdout.write(
    `${JSON.stringify({ liveOpenAI: 'verified', mcpDraftId: mcpId, agentDraftId: agentId, persistedAfterRestart: true }, null, 2)}\n`,
  );
}

try {
  await main();
} catch (error) {
  reportFailure(error);
}
