import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftResult } from '../src/domain/contracts.js';
import { PassThrough } from 'node:stream';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-mcp-'));
  roots.push(dir);
  const profile = join(dir, 'user.json');
  writeFileSync(
    profile,
    JSON.stringify({
      name: 'Ada',
      tone: 'Warm and clear',
      language: 'Swedish',
      interests: ['TypeScript'],
      writingSamples: ['PRIVATE_STYLE_SAMPLE'],
    }),
  );
  return {
    dir,
    env: {
      LINKEDOUT_DATA_DIR: dir,
      LINKEDOUT_KNOWLEDGE_DIR: join(dir, 'knowledge'),
      LINKEDOUT_PROFILE_PATH: profile,
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
    },
  };
}

async function connection(
  env: Record<string, string>,
  production = false,
  modern = false,
  lifecycle = false,
) {
  const appPath = '../dist/entrypoints/app.js';
  const configPath = '../dist/infrastructure/config.js';
  const serverPath = '../dist/entrypoints/mcp-server.js';
  const fixturePath = './fixtures/provider.mjs';
  const { createApplication } = (await import(
    appPath
  )) as typeof import('../src/entrypoints/app.js');
  const { loadConfig } = (await import(
    configPath
  )) as typeof import('../src/infrastructure/config.js');
  const { createMcpServer, startMcp } = (await import(
    serverPath
  )) as typeof import('../src/entrypoints/mcp-server.js');
  const { fixtureProvider } = await import(fixturePath);
  let stderr = '',
    requests = 0;
  const app = createApplication(loadConfig(env), {
    logger: {
      log(event) {
        stderr += `${JSON.stringify(event)}\n`;
      },
    },
    ...(!production
      ? {
          provider: fixtureProvider({
            reportExit: false,
            responseMode: env.LINKEDOUT_TEST_RESPONSE,
            onRequest: () => {
              requests += 1;
              stderr += '{"fixtureRequestStarted":true}\n';
            },
          }),
        }
      : {}),
  });
  const serverInput = new PassThrough(),
    serverOutput = new PassThrough();
  const controller = new AbortController();
  const serverTransport = new StdioServerTransport(serverInput, serverOutput);
  const handle = lifecycle
    ? startMcp(app, serverTransport)
    : serveStdio(() => createMcpServer(app, controller.signal), {
        legacy: 'serve',
        transport: serverTransport,
      });
  const transport = new StdioServerTransport(serverOutput, serverInput);
  const client = new Client(
    { name: 'linkedout-test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await handle.close();
    await client.close();
    if (!lifecycle) app.close();
    serverInput.destroy();
    serverOutput.destroy();
    stderr += `${JSON.stringify({ fixtureRequests: requests })}\n`;
  };
  try {
    await client.connect(transport, { timeout: 5000 });
  } catch (error) {
    await close();
    throw error;
  }
  return { client, transport, app, close, stderr: () => stderr };
}

const pipeProbe = spawnSync(
  process.execPath,
  ['-e', 'process.stdout.write("probe")'],
  { encoding: 'utf8' },
);
if (
  pipeProbe.error &&
  !('code' in pipeProbe.error && pipeProbe.error.code === 'EPERM')
)
  throw pipeProbe.error;
const pipesBlocked = Boolean(pipeProbe.error);

async function subprocessConnection(
  env: Record<string, string>,
  production = false,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(
        production
          ? 'dist/entrypoints/mcp.js'
          : 'tests/fixtures/stdio-server.mjs',
      ),
    ],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: 'linkedout-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 5000 });
  } catch (error) {
    await transport.close();
    throw error;
  }
  return { client, transport, stderr: () => stderr };
}

function body(result: CallToolResult): unknown {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Missing MCP text result');
  return JSON.parse(text.text);
}

describe('official MCP client over serialized stdio streams', () => {
  it('returns complete safe whole-unit diagnostics through the official client', async () => {
    const { env } = workspace();
    const connected = await connection({
      ...env,
      LINKEDOUT_TEST_RESPONSE: 'invalid-assessment',
    });
    try {
      const failed = await connected.client.callTool({
        name: 'draft_post',
        arguments: { brief: 'Consider testing. Consider profiling.' },
      });
      expect(failed.isError).toBe(true);
      const failure = body(failed) as { error: { reviewArtifactId: string } };
      const result = body(
        await connected.client.callTool({
          name: 'get_review_artifact',
          arguments: { id: failure.error.reviewArtifactId },
        }),
      ) as { artifact: { assessment: { units: { unitId: string }[] } } };
      expect(result).toMatchObject({
        artifact: {
          assessment: {
            version: 'assessment-v2',
            complete: false,
            blocked: true,
            findings: [],
            issues: ['INVALID_ASSESSMENT'],
            diagnostics: [
              { reason: 'UNKNOWN_UNIT' },
              {
                reason: 'MISSING_UNIT',
                unitId: result.artifact.assessment.units.at(-1)!.unitId,
              },
            ],
          },
        },
      });
      expect(result.artifact.assessment.units.length).toBeGreaterThan(1);
      expect(JSON.stringify(result) + connected.stderr()).not.toContain(
        'PRIVATE_INVALID_ID',
      );
    } finally {
      await connected.close();
    }
  });

  it('persists and retrieves selected private evidence through the real MCP protocol', async () => {
    const { dir, env } = workspace();
    mkdirSync(join(dir, 'knowledge'));
    writeFileSync(
      join(dir, 'knowledge', 'cv.md'),
      'PRIVATE_CV_EVIDENCE: TypeScript reporting application.',
    );
    writeFileSync(
      join(dir, 'knowledge', 'unrelated.txt'),
      'PRIVATE_UNRELATED_EVIDENCE: gardening and roses.',
    );
    const first = await connection(env);
    let saved: DraftResult;
    try {
      const result = await first.client.callTool({
        name: 'draft_post',
        arguments: { brief: 'Reflect on TypeScript reliability' },
      });
      expect(result.isError).not.toBe(true);
      saved = body(result) as DraftResult;
      expect(saved.draft.provenance.knowledge?.sources).toHaveLength(1);
      expect(saved.draft.provenance.knowledge?.sources[0]?.excerpt).toContain(
        'PRIVATE_CV_EVIDENCE',
      );
      expect(JSON.stringify(saved.draft)).not.toContain(
        'PRIVATE_UNRELATED_EVIDENCE',
      );
      expect(saved.draft.review?.required).toBe(true);
      expect(first.stderr()).not.toContain('PRIVATE_CV_EVIDENCE');
    } finally {
      await first.close();
    }
    const restarted = await connection(env, true);
    try {
      const result = await restarted.client.callTool({
        name: 'get_draft',
        arguments: { id: saved!.draft.id },
      });
      expect(result.isError).not.toBe(true);
      expect(body(result)).toEqual({ draft: saved!.draft });
    } finally {
      await restarted.close();
    }
  });

  it('discovers tools, drafts with preferences, replays, retrieves and survives keyless production restart', async () => {
    const { env } = workspace();
    const first = await connection(env);
    let saved: DraftResult;
    try {
      expect(first.client.getServerVersion()).toMatchObject({
        name: 'linkedout',
      });
      const listed = await first.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'delete_research_run',
        'delete_review_artifact',
        'draft_post',
        'get_content_idea',
        'get_draft',
        'get_research_item',
        'get_review_artifact',
        'list_content_ideas',
        'list_drafts',
        'list_research_items',
        'list_research_sources',
        'list_review_artifacts',
        'research_run',
        'review_content_idea',
      ]);
      const input = {
        brief: 'PRIVATE_BRIEF about reliable TypeScript',
        idempotencyKey: 'mcp-replay',
      };
      const result = await first.client.callTool({
        name: 'draft_post',
        arguments: input,
      });
      expect(result.isError).not.toBe(true);
      saved = body(result) as DraftResult;
      expect(saved.draft.body).toContain('Ada');
      expect(saved.draft.body).toContain('Warm and clear; Swedish');
      expect(saved.draft.provenance.profile.writingSamples).toEqual([
        'PRIVATE_STYLE_SAMPLE',
      ]);
      expect(result.structuredContent).toMatchObject({
        draft: { id: saved.draft.id },
      });
      expect(
        body(
          await first.client.callTool({ name: 'draft_post', arguments: input }),
        ),
      ).toMatchObject({ replayed: true, draft: { id: saved.draft.id } });
      expect(
        body(
          await first.client.callTool({ name: 'list_drafts', arguments: {} }),
        ),
      ).toMatchObject({ total: 1 });
      expect(
        body(
          await first.client.callTool({
            name: 'get_draft',
            arguments: { id: saved.draft.id },
          }),
        ),
      ).toMatchObject({ draft: saved.draft });
    } finally {
      await first.close();
    }
    expect(first.stderr()).toContain('"fixtureRequests":2');
    for (const secret of [
      'fixture-key-secret',
      'PRIVATE_BRIEF',
      'PRIVATE_STYLE_SAMPLE',
      'Draft for Ada',
    ])
      expect(first.stderr()).not.toContain(secret);
    const restarted = await connection(env, true);
    try {
      expect((await restarted.client.listTools()).tools).toHaveLength(14);
      expect(
        body(
          await restarted.client.callTool({
            name: 'get_draft',
            arguments: { id: saved!.draft.id },
          }),
        ),
      ).toMatchObject({ draft: saved!.draft });
      const unavailable = await restarted.client.callTool({
        name: 'draft_post',
        arguments: { brief: 'Requires configuration' },
      });
      expect(unavailable.isError).toBe(true);
      expect(body(unavailable)).toMatchObject({
        error: { code: 'CONFIGURATION_ERROR' },
      });
    } finally {
      await restarted.close();
    }
  });

  it('retains blocked bodies privately and retrieves/deletes artifacts after keyless restart', async () => {
    const { env } = workspace();
    const first = await connection(env);
    let artifactId: string;
    try {
      const result = await first.client.callTool({
        name: 'draft_post',
        arguments: {
          brief: 'I built PRIVATE_BLOCKED_PROJECT.',
          idempotencyKey: 'blocked-artifact',
        },
      });
      expect(result.isError).toBe(true);
      const failure = body(result) as {
        error: { code: string; reviewArtifactId: string };
      };
      expect(failure.error.code).toBe('UNGROUNDED_OUTPUT');
      artifactId = failure.error.reviewArtifactId;
      expect(artifactId).toBeTruthy();
      const summary = await first.client.callTool({
        name: 'list_review_artifacts',
        arguments: {},
      });
      expect(body(summary)).toMatchObject({
        total: 1,
        artifacts: [{ id: artifactId, publishable: false }],
      });
      expect(JSON.stringify(summary)).not.toContain('PRIVATE_BLOCKED_PROJECT');
      expect(
        body(
          await first.client.callTool({ name: 'list_drafts', arguments: {} }),
        ),
      ).toMatchObject({ total: 0 });
    } finally {
      await first.close();
    }
    expect(first.stderr()).not.toContain('PRIVATE_BLOCKED_PROJECT');
    const restarted = await connection(env, true);
    try {
      const result = body(
        await restarted.client.callTool({
          name: 'get_review_artifact',
          arguments: { id: artifactId },
        }),
      );
      expect(result).toMatchObject({
        artifact: {
          id: artifactId,
          status: 'blocked',
          publishable: false,
          revision: 1,
          body: expect.stringContaining('PRIVATE_BLOCKED_PROJECT'),
        },
      });
      expect(
        body(
          await restarted.client.callTool({
            name: 'delete_review_artifact',
            arguments: { id: artifactId },
          }),
        ),
      ).toEqual({ deleted: true });
      expect(
        (
          await restarted.client.callTool({
            name: 'get_review_artifact',
            arguments: { id: artifactId },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await restarted.close();
    }
  });

  it('returns sanitized errors for invalid tools and inputs without invoking a provider', async () => {
    const { env } = workspace();
    const server = await connection(env);
    try {
      await server.client.listTools();
      for (const request of [
        {
          name: 'publish_post',
          arguments: { body: 'PRIVATE_INVALID_PAYLOAD' },
        },
        {
          name: 'draft_post',
          arguments: { brief: '', providerUrl: 'PRIVATE_INVALID_PAYLOAD' },
        },
        { name: 'get_draft', arguments: { id: 'PRIVATE_INVALID_PAYLOAD' } },
      ]) {
        const outcome = await server.client.callTool(request).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        if ('result' in outcome) {
          expect(outcome.result.isError).toBe(true);
          expect(JSON.stringify(outcome.result)).not.toContain(
            'PRIVATE_INVALID_PAYLOAD',
          );
        } else {
          expect(String(outcome.error)).not.toContain(
            'PRIVATE_INVALID_PAYLOAD',
          );
        }
      }
      expect(
        body(
          await server.client.callTool({ name: 'list_drafts', arguments: {} }),
        ),
      ).toMatchObject({ total: 0 });
    } finally {
      await server.close();
    }
    expect(server.stderr()).toContain('"fixtureRequests":0');
  });

  it('supports the modern v2 protocol using the official pinned client', async () => {
    const { env } = workspace();
    const server = await connection(env, false, true);
    try {
      expect(server.client.getProtocolEra()).toBe('modern');
      expect(server.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(server.client.getDiscoverResult()).toBeDefined();
      expect((await server.client.listTools()).tools).toHaveLength(14);
      expect(
        body(
          await server.client.callTool({
            name: 'draft_post',
            arguments: { brief: 'Modern protocol' },
          }),
        ),
      ).toMatchObject({ draft: { status: 'draft' } });
    } finally {
      await server.close();
    }
  });

  it('cancels an in-flight provider call and records no successful draft', async () => {
    const { env } = workspace();
    const server = await connection({
      ...env,
      LINKEDOUT_TEST_RESPONSE: 'wait',
    });
    try {
      const controller = new AbortController();
      const pending = server.client.callTool(
        { name: 'draft_post', arguments: { brief: 'Cancel this request' } },
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toBeDefined();
      await expect
        .poll(() => server.stderr(), { timeout: 3000 })
        .toContain('"fixtureRequestStarted":true');
      controller.abort();
      await rejected;
      await expect
        .poll(() => server.stderr(), { timeout: 3000 })
        .toContain('"code":"CANCELLED"');
      expect(
        body(
          await server.client.callTool({ name: 'list_drafts', arguments: {} }),
        ),
      ).toMatchObject({ total: 0 });
    } finally {
      await server.close();
    }
  });

  it('drains cancelled audit writes before closing SQLite on server shutdown', async () => {
    const { env } = workspace();
    const server = await connection(
      { ...env, LINKEDOUT_TEST_RESPONSE: 'wait' },
      false,
      false,
      true,
    );
    try {
      const pending = server.client.callTool({
        name: 'draft_post',
        arguments: { brief: 'Interrupted by shutdown' },
      });
      const settled = pending.then(
        () => undefined,
        () => undefined,
      );
      await expect
        .poll(() => server.stderr(), { timeout: 3000 })
        .toContain('"fixtureRequestStarted":true');
      await server.close();
      await settled;
      expect(server.stderr()).toContain('"code":"CANCELLED"');
      expect(server.stderr()).toContain('server_stopped');
      const restarted = await connection(env, true);
      try {
        expect(
          body(
            await restarted.client.callTool({
              name: 'list_drafts',
              arguments: {},
            }),
          ),
        ).toMatchObject({ total: 0 });
        expect(restarted.app.store.listRuns('local', 20, 0)).toEqual([
          expect.objectContaining({ status: 'failed', errorCode: 'CANCELLED' }),
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await server.close();
    }
  });

  it.skipIf(pipesBlocked)(
    'official StdioClientTransport verifies a real process (sandbox EPERM blocks child pipes)',
    async () => {
      const { env } = workspace();
      const server = await subprocessConnection(env);
      let id: string;
      try {
        expect((await server.client.listTools()).tools).toHaveLength(14);
        const result = body(
          await server.client.callTool({
            name: 'draft_post',
            arguments: { brief: 'Subprocess draft' },
          }),
        ) as DraftResult;
        id = result.draft.id;
      } finally {
        await server.client.close();
      }
      const restarted = await subprocessConnection(env, true);
      try {
        expect(
          body(
            await restarted.client.callTool({
              name: 'get_draft',
              arguments: { id: id! },
            }),
          ),
        ).toMatchObject({ draft: { id: id! } });
      } finally {
        await restarted.client.close();
      }
    },
  );

  it.skipIf(pipesBlocked)(
    'exits promptly on stdin EOF (sandbox EPERM blocks child pipes)',
    async () => {
      const { env } = workspace();
      const child = spawn(
        process.execPath,
        [resolve('dist/entrypoints/mcp.js')],
        { env: { ...process.env, ...env }, stdio: 'pipe' },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        expect(await closed).toBe(0);
        expect(stdout).toBe('');
        expect(stderr).toContain('server_stopped');
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    },
  );
});
