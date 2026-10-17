import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import {
  userProfileSchema,
  type ExecutionContext,
} from '../src/domain/contracts.js';
import { EMPTY_KNOWLEDGE } from '../src/domain/knowledge.js';
import {
  RESEARCH_SOURCES,
  type ResearchPlanner,
  type ResearchPlanningRequest,
  type ResearchResult,
} from '../src/domain/research.js';
import { GithubResearchFeed } from '../src/infrastructure/github-research.js';
import { SqliteStore } from '../src/infrastructure/sqlite.js';
import { KnowledgeIndex } from '../src/infrastructure/knowledge-index.js';
import { loadConfig } from '../src/infrastructure/config.js';
import { ResearchWorkflow } from '../src/application/research.js';
import { createApplication } from '../src/entrypoints/app.js';
import { runCli } from '../src/entrypoints/cli.js';
import { createMcpServer } from '../src/entrypoints/mcp-server.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const now = () => new Date('2026-10-16T12:00:00Z');
const profile = userProfileSchema.parse({
  interests: ['TypeScript', 'frontend', 'local ai'],
  writingSamples: ['NEVER_SEND_STYLE'],
  name: 'NEVER_SEND_NAME',
});
const context: ExecutionContext = {
  actor: 'test',
  permissions: new Set([
    'research_local',
    'read_local',
    'review_local',
    'delete_local',
  ]),
};
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-research-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function release(repository: string, changes: Record<string, unknown> = {}) {
  return {
    id: 1,
    html_url: `https://github.com/${repository}/releases/tag/v1.0.0`,
    name: 'New release',
    tag_name: 'v1.0.0',
    body: 'New TypeScript support and migration features for frontend architecture.',
    published_at: '2026-10-15T12:00:00Z',
    draft: false,
    prerelease: false,
    ...changes,
  };
}
function fetchFixture(changes: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (url) => {
    const repository = new URL(String(url)).pathname
      .split('/')
      .slice(2, 4)
      .join('/');
    return Response.json([release(repository, changes)]);
  });
}
function planner() {
  const planResearch = vi.fn(async (request: ResearchPlanningRequest) => ({
    output: {
      ideas: request.candidates.map(() => ({
        angle: 'experiment',
        personalEvidenceIndex: null,
      })),
    },
    metadata: {
      provider: 'fixture',
      model: 'fixture',
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  }));
  return { provider: 'fixture', model: 'fixture', planResearch };
}
function setup(changes: Record<string, unknown> = {}) {
  const dir = root();
  const store = new SqliteStore(dir);
  cleanup.push(() => store.close());
  const fetcher = fetchFixture(changes);
  const feed = new GithubResearchFeed(fetcher, now, store);
  const model = planner();
  const knowledge = {
    retrieve: vi.fn(async () => structuredClone(EMPTY_KNOWLEDGE)),
  };
  const logger = { log: vi.fn() };
  const service = new ResearchWorkflow(
    store,
    feed,
    model,
    profile,
    knowledge,
    logger,
    14,
    120_000,
    now,
  );
  return { dir, store, fetcher, feed, model, knowledge, logger, service };
}

describe('research persistence and bounded planning', () => {
  it('ranks before planning, persists separate evidence, and replays history without any I/O', async () => {
    const env = setup();
    const first = await env.service.run({ idempotencyKey: 'first' }, context);
    expect(first).toMatchObject({
      replayed: false,
      execution: 'new_research',
      result: { modelCalls: 1, lookbackDays: 14, coverage: 'complete' },
    });
    expect(first.result.ideas.length).toBe(5);
    expect(env.model.planResearch).toHaveBeenCalledTimes(1);
    expect(env.fetcher).toHaveBeenCalledTimes(6);
    const request = env.model.planResearch.mock.calls[0]![0];
    expect(JSON.stringify(request)).not.toMatch(/NEVER_SEND/);
    expect(request.candidates.map((item) => item.score.total)).toEqual(
      [...request.candidates.map((item) => item.score.total)].sort(
        (a, b) => b - a,
      ),
    );
    const idea = first.result.ideas[0]!;
    expect(env.store.listIdeas(profile.id, 100, 0)[0]!.id).toBe(idea.id);
    env.store.reviewIdea(profile.id, idea.id, 'rejected');
    env.fetcher.mockRejectedValue(new Error('Must not fetch'));
    env.knowledge.retrieve.mockRejectedValue(
      new Error('Must not retrieve private knowledge'),
    );
    const restartedStore = new SqliteStore(env.dir);
    cleanup.push(() => restartedStore.close());
    const restarted = new ResearchWorkflow(
      restartedStore,
      env.feed,
      env.model,
      { ...profile, interests: ['changed'] },
      env.knowledge,
      env.logger,
      90,
      120_000,
      now,
    );
    const replay = await restarted.run({ idempotencyKey: 'first' }, context);
    expect(replay).toMatchObject({
      replayed: true,
      execution: 'historical_replay',
    });
    expect(replay.result).toEqual(first.result);
    expect(restartedStore.getIdea(profile.id, idea.id).status).toBe('rejected');
    expect(env.fetcher).toHaveBeenCalledTimes(6);
    expect(env.knowledge.retrieve).toHaveBeenCalledTimes(1);
    expect(env.model.planResearch).toHaveBeenCalledTimes(1);
    await expect(
      restarted.run({ idempotencyKey: 'first', lookbackDays: 30 }, context),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(restartedStore.listRuns(profile.id)[0]).toMatchObject({
      kind: 'research',
      status: 'succeeded',
      researchResultId: first.result.runId,
    });
  });
  it('new runs suppress persisted and rejected release identities even after note revisions', async () => {
    const env = setup();
    const first = await env.service.run({}, context);
    for (const idea of first.result.ideas)
      env.store.reviewIdea(profile.id, idea.id, 'rejected');
    env.fetcher.mockImplementation(async (url) =>
      Response.json([
        release(
          new URL(String(url)).pathname.split('/').slice(2, 4).join('/'),
          {
            body: 'Changed TypeScript support and migration with new security features.',
          },
        ),
      ]),
    );
    const second = await env.service.run({ idempotencyKey: 'new' }, context);
    expect(
      second.result.ideas.every(
        (idea) =>
          !first.result.ideas.some((old) => old.identity === idea.identity),
      ),
    ).toBe(true);
    expect(second.replayed).toBe(false);
    expect(env.store.listIdeas(profile.id, 100, 0, 'rejected')).toHaveLength(5);
  });
  it('enforces configurable lookback without changing publication dates', async () => {
    const env = setup({ published_at: '2026-08-16T12:00:00Z' });
    const recent = await env.service.run({}, context);
    expect(recent.result.ideas).toHaveLength(0);
    expect(env.model.planResearch).not.toHaveBeenCalled();
    const older = await env.service.run({ lookbackDays: 90 }, context);
    expect(older.result.ideas).toHaveLength(5);
    expect(older.result.ideas[0]!.publicEvidence.publishedAt).toBe(
      '2026-08-16T12:00:00.000Z',
    );
    for (const days of [6, 91, 7.5])
      await expect(
        env.service.run({ lookbackDays: days }, context),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      loadConfig({ LINKEDOUT_RESEARCH_LOOKBACK_DAYS: '30' })
        .researchLookbackDays,
    ).toBe(30);
    expect(() =>
      loadConfig({ LINKEDOUT_RESEARCH_LOOKBACK_DAYS: '91' }),
    ).toThrow();
  });
  it.each([
    { prerelease: true },
    { published_at: null },
    { published_at: '2026-10-17T12:00:00Z' },
    { published_at: '2026-02-30T12:00:00Z' },
    { body: '' },
  ])(
    'never fills an empty shortlist with stale or ineligible data: %j',
    async (changes) => {
      const env = setup(changes);
      const run = await env.service.run({}, context);
      expect(run.result.ideas).toHaveLength(0);
      expect(run.result.modelCalls).toBe(0);
    },
  );
  it('rejects obsolete model quotation fields atomically and sanitizes logs', async () => {
    const env = setup();
    env.model.planResearch.mockImplementation(async (request) => ({
      output: {
        ideas: request.candidates.map(() => ({
          angle: 'experiment',
          publicQuote: 'INVENTED_SECRET_CLAIM_NOT_IN_NOTES',
          personalEvidenceIndex: null,
        })),
      },
      metadata: {
        provider: 'fixture',
        model: 'fixture',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    }));
    await expect(
      env.service.run({ idempotencyKey: 'bad' }, context),
    ).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      groundingDiagnostic: {
        scope: 'research',
        stage: 'output_schema',
        reason: 'INVALID_SCHEMA',
        index: 0,
      },
    });
    expect(env.store.listIdeas(profile.id, 100, 0)).toEqual([]);
    expect(env.store.listRuns(profile.id)[0]!.status).toBe('failed');
    expect(
      env.store.listResearchItems(profile.id, 100, 0).length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(env.logger.log.mock.calls)).not.toMatch(
      /INVENTED_SECRET|TypeScript|NEVER_SEND/,
    );
    await expect(
      env.service.run({ idempotencyKey: 'bad' }, context),
    ).rejects.toMatchObject({ code: 'PREVIOUS_FAILURE' });
  });
  it('uses isolated real knowledge, validates personal quotes and preserves missing-evidence warnings', async () => {
    const env = setup();
    const path = join(env.dir, 'knowledge');
    mkdirSync(path);
    writeFileSync(
      join(path, 'synthetic.md'),
      'I maintained TypeScript frontend architecture in a synthetic demonstration project.',
    );
    const knowledge = new KnowledgeIndex(path);
    cleanup.push(() => knowledge.close());
    const model: ResearchPlanner = {
      provider: 'fixture',
      model: 'fixture',
      planResearch: async (request) => ({
        output: {
          ideas: request.candidates.map(() => ({
            angle: 'team_discussion',
            personalEvidenceIndex: 0,
          })),
        },
        metadata: { provider: 'fixture', model: 'fixture' },
      }),
    };
    const feed = {
      collect: async (signal: AbortSignal) => {
        const collected = await env.feed.collect(signal);
        return {
          ...collected,
          items: collected.items.filter(
            (item) => item.repository === 'microsoft/TypeScript',
          ),
        };
      },
    };
    const service = new ResearchWorkflow(
      env.store,
      feed,
      model,
      profile,
      knowledge,
      env.logger,
      14,
      120_000,
      now,
    );
    const run = await service.run({}, context);
    expect(run.result.ideas[0]!.personalEvidence?.quote).toContain(
      'synthetic demonstration',
    );
    expect(run.result.ideas[0]!.publicEvidence.quote).not.toContain(
      'synthetic demonstration',
    );
    expect(run.result.ideas[0]!.score.personal).toBeGreaterThan(0);
  });
  it('rejects fabricated private references and does not commit ideas', async () => {
    const env = setup();
    const badModel: ResearchPlanner = {
      provider: 'fixture',
      model: 'fixture',
      planResearch: async (request) => ({
        output: {
          ideas: request.candidates.map(() => ({
            angle: 'experiment',
            personalEvidenceIndex: 999,
          })),
        },
        metadata: { provider: 'fixture', model: 'fixture' },
      }),
    };
    const service = new ResearchWorkflow(
      env.store,
      env.feed,
      badModel,
      profile,
      env.knowledge,
      env.logger,
      14,
      120_000,
      now,
    );
    await expect(service.run({}, context)).rejects.toMatchObject({
      code: 'UNGROUNDED_OUTPUT',
    });
    expect(env.store.listIdeas(profile.id, 100, 0)).toEqual([]);
  });
  it('rolls back all ideas and the result when an atomic commit fails', async () => {
    const env = setup();
    const db = new DatabaseSync(join(env.dir, 'linkedout.sqlite'));
    db.exec(
      "CREATE TRIGGER fail_second_idea BEFORE INSERT ON content_ideas WHEN (SELECT count(*) FROM content_ideas) > 0 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    );
    db.close();
    await expect(
      env.service.run({ idempotencyKey: 'atomic' }, context),
    ).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(env.store.listIdeas(profile.id, 100, 0)).toEqual([]);
    expect(env.store.listRuns(profile.id)[0]!.status).toBe('failed');
    await expect(
      env.service.run({ idempotencyKey: 'atomic' }, context),
    ).rejects.toMatchObject({ code: 'PREVIOUS_FAILURE' });
  });
  it('cancels an in-flight model operation without committing a result or retrying', async () => {
    const env = setup();
    const controller = new AbortController();
    const model: ResearchPlanner = {
      provider: 'fixture',
      model: 'fixture',
      planResearch: vi.fn(async (request, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        return env.model.planResearch(request);
      }),
    };
    const service = new ResearchWorkflow(
      env.store,
      env.feed,
      model,
      profile,
      env.knowledge,
      env.logger,
      14,
      120_000,
      now,
    );
    await expect(
      service.run({}, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(model.planResearch).toHaveBeenCalledTimes(1);
    expect(env.store.listIdeas(profile.id, 100, 0)).toEqual([]);
    expect(env.store.listRuns(profile.id)[0]!.errorCode).toBe('CANCELLED');
  });
  it('protects keys across workflows and concurrent research reservations', async () => {
    const env = setup();
    const first = env.service.run({ idempotencyKey: 'concurrent' }, context);
    await expect(
      env.service.run({ idempotencyKey: 'concurrent' }, context),
    ).rejects.toMatchObject({ code: 'IN_PROGRESS' });
    await first;
    expect(() =>
      env.store.reserveDraft(
        profile.id,
        'different',
        {},
        'concurrent',
        context,
      ),
    ).toThrow();
    expect(env.model.planResearch).toHaveBeenCalledTimes(1);
  });
  it('deletes research payloads while preserving a non-replayable key tombstone and ownership', async () => {
    const env = setup();
    const run = await env.service.run({ idempotencyKey: 'deleted' }, context);
    const idea = run.result.ideas[0]!;
    expect(() => env.store.getIdea('other', idea.id)).toThrow();
    expect(() => env.store.reviewIdea('other', idea.id, 'accepted')).toThrow();
    expect(() =>
      env.store.deleteResearchRun('other', run.result.runId),
    ).toThrow();
    env.store.deleteResearchRun(profile.id, run.result.runId);
    expect(env.store.listIdeas(profile.id, 100, 0)).toEqual([]);
    await expect(
      env.service.run({ idempotencyKey: 'deleted' }, context),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(env.fetcher).toHaveBeenCalledTimes(6);
  });
  it('rejects permissions and cancellation before any outbound work', async () => {
    const env = setup();
    await expect(
      env.service.run({}, { ...context, permissions: new Set(['read_local']) }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      env.service.run({}, { ...context, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(env.fetcher).not.toHaveBeenCalled();
  });
});

describe('GitHub HTTP boundary with local fetch fixtures', () => {
  it('uses only fixed endpoints, disables redirects, preserves inert markup and enforces excerpt limits', async () => {
    const fetcher = fetchFixture({
      body: '<script>untrusted</script>\u001b[31m' + 'x'.repeat(4000),
    });
    const result = await new GithubResearchFeed(fetcher, now).collect(
      new AbortController().signal,
    );
    expect(result.requests).toBe(6);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api.github.com\/repos\//);
      expect(options?.redirect).toBe('error');
    }
    expect(result.items[0]!.excerpt).toContain('<script>untrusted</script>');
    expect(result.items[0]!.excerpt).not.toContain(String.fromCharCode(27));
    expect(result.items[0]).toMatchObject({
      truncated: true,
      verification: 'publisher_reported',
    });
    expect(result.items[0]!.excerpt).toHaveLength(2400);
  });
  it('persists rate-limit cooldown and stops requests across runs', async () => {
    const env = setup();
    env.fetcher.mockResolvedValue(
      Response.json({}, { status: 429, headers: { 'retry-after': '600' } }),
    );
    const first = await env.feed.collect(new AbortController().signal);
    expect(first.requests).toBe(1);
    expect(first.outcomes).toHaveLength(6);
    const second = await env.feed.collect(new AbortController().signal);
    expect(second.requests).toBe(0);
    expect(
      second.outcomes.every(
        (outcome) => outcome.code === 'RATE_LIMIT_COOLDOWN',
      ),
    ).toBe(true);
  });
  it('revalidates ETags on new collection without substituting cache on failure', async () => {
    const env = setup();
    env.fetcher.mockImplementation(async (url) =>
      Response.json(
        [
          release(
            new URL(String(url)).pathname.split('/').slice(2, 4).join('/'),
          ),
        ],
        { headers: { etag: 'fixture-etag' } },
      ),
    );
    const initial = await env.feed.collect(new AbortController().signal);
    env.fetcher.mockImplementation(async (_url, options) => {
      expect(options?.headers).toMatchObject({
        'If-None-Match': 'fixture-etag',
      });
      return new Response(null, { status: 304 });
    });
    const revalidated = await env.feed.collect(new AbortController().signal);
    expect(revalidated.items).toEqual(initial.items);
    env.fetcher.mockRejectedValue(new Error('private raw error'));
    expect(
      (await env.feed.collect(new AbortController().signal)).items,
    ).toEqual([]);
  });
  it.each([
    () =>
      Response.json([
        {
          ...release('microsoft/TypeScript'),
          html_url: 'http://127.0.0.1/secrets',
        },
      ]),
    () =>
      new Response('x'.repeat(1_048_577), {
        headers: { 'content-type': 'application/json' },
      }),
    () => new Response('not json'),
  ])(
    'rejects unsafe links and invalid/oversized payloads without raw diagnostics',
    async (response) => {
      const feed = new GithubResearchFeed(async () => response(), now);
      const result = await feed.collect(new AbortController().signal);
      expect(result.items).toHaveLength(0);
      expect(
        result.outcomes.every((outcome) => outcome.status === 'failed'),
      ).toBe(true);
      expect(JSON.stringify(result.outcomes)).not.toContain('127.0.0.1');
    },
  );
  it('reports partial and all-failed runs explicitly', async () => {
    const env = setup();
    env.fetcher.mockImplementation(async (url) =>
      String(url).includes('/react/react/')
        ? Response.json({}, { status: 500 })
        : Response.json([
            release(
              new URL(String(url)).pathname.split('/').slice(2, 4).join('/'),
            ),
          ]),
    );
    expect((await env.service.run({}, context)).result.coverage).toBe(
      'partial',
    );
    env.fetcher.mockRejectedValue(new Error('private provider URL'));
    await expect(env.service.run({}, context)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(
      env.store.listRuns(profile.id).find((run) => run.status === 'failed')
        ?.planning,
    ).toMatchObject({ requests: 6 });
  });
});

it('shares research and review behavior between CLI and the official MCP client over serialized stdio', async () => {
  const dir = root();
  const model = planner();
  const app = createApplication(
    {
      dataDir: dir,
      profile,
      runTimeoutMs: 120_000,
      knowledgeDir: join(dir, 'knowledge'),
    },
    {
      researchFeed: new GithubResearchFeed(
        fetchFixture({
          published_at: new Date(Date.now() - 86_400_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
        }),
        () => new Date(),
      ),
      researchPlanner: model,
      logger: { log() {} },
    },
  );
  cleanup.push(() => app.close());
  const cliResult = (await runCli(
    ['research', 'run', '--lookback-days', '30', '--idempotency-key', 'shared'],
    app,
  )) as { result: ResearchResult };
  const input = new PassThrough(),
    output = new PassThrough();
  const controller = new AbortController();
  const handle = serveStdio(() => createMcpServer(app, controller.signal), {
    legacy: 'serve',
    transport: new StdioServerTransport(input, output),
  });
  const client = new Client({ name: 'research-tests', version: '1' });
  try {
    await client.connect(new StdioServerTransport(output, input));
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === 'research_run')?.annotations
        ?.openWorldHint,
    ).toBe(true);
    const replay = await client.callTool({
      name: 'research_run',
      arguments: { lookbackDays: 30, idempotencyKey: 'shared' },
    });
    expect(replay.structuredContent).toMatchObject({
      replayed: true,
      execution: 'historical_replay',
      result: { runId: cliResult.result.runId },
    });
    const id = cliResult.result.ideas[0]!.id;
    const reviewed = await client.callTool({
      name: 'review_content_idea',
      arguments: { id, status: 'rejected' },
    });
    expect(reviewed.structuredContent).toMatchObject({
      idea: { status: 'rejected', reviewRequired: true },
    });
    expect(
      await runCli(['ideas', 'list', '--status', 'rejected'], app),
    ).toMatchObject({ ideas: [{ id, status: 'rejected' }] });
    const unsafe = await client.callTool({
      name: 'research_run',
      arguments: { url: 'http://localhost/private' },
    });
    expect(unsafe.isError).toBe(true);
    model.planResearch.mockImplementation(async (request) => ({
      output: {
        ideas: request.candidates.map(() => ({
          angle: 'PRIVATE_REJECTED_ANGLE',
          personalEvidenceIndex: null,
        })),
      },
      metadata: {
        provider: 'fixture',
        model: 'fixture',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    }));
    const failure = await client.callTool({
      name: 'research_run',
      arguments: { idempotencyKey: 'diagnostic' },
    });
    expect(failure.isError).toBe(true);
    const encoded = JSON.stringify(failure);
    expect(encoded).not.toContain('PRIVATE_REJECTED_ANGLE');
    const block = failure.content.find((block) => block.type === 'text');
    if (block?.type !== 'text') throw new Error('Missing diagnostic text');
    const diagnostic = {
      scope: 'research',
      stage: 'output_schema',
      reason: 'INVALID_SCHEMA',
      index: 0,
    };
    expect(JSON.parse(block.text)).toMatchObject({
      error: { code: 'INVALID_OUTPUT', groundingDiagnostic: diagnostic },
    });
    const failedRun = app.store
      .listRuns(profile.id)
      .find((run) => run.status === 'failed')!;
    expect(await runCli(['runs', 'get', failedRun.id], app)).toMatchObject({
      run: { groundingDiagnostic: diagnostic },
    });
    const calls = model.planResearch.mock.calls.length;
    const repeated = await client.callTool({
      name: 'research_run',
      arguments: { idempotencyKey: 'diagnostic' },
    });
    expect(JSON.stringify(repeated)).toContain('PREVIOUS_FAILURE');
    expect(JSON.stringify(repeated)).toContain('INVALID_SCHEMA');
    expect(model.planResearch).toHaveBeenCalledTimes(calls);
    expect(RESEARCH_SOURCES).toHaveLength(6);
  } finally {
    controller.abort();
    await handle.close();
    await client.close();
    input.destroy();
    output.destroy();
  }
});

it.each([
  'Versions <2 are unsupported; versions >4 are recommended.',
  'Use `Map<Key, Value>` only when x < y && y > z.',
  'Not supported: <experimental>. Requires ≥4; avoid ≤2.',
  '<del>Supported</del> is a retracted claim; <em>not</em> supported.',
])(
  'preserves release evidence and deterministic identity: %s',
  async (body) => {
    const feed = new GithubResearchFeed(fetchFixture({ body }), now);
    const first = (await feed.collect(new AbortController().signal)).items[0]!;
    const second = (await feed.collect(new AbortController().signal)).items[0]!;
    expect(first.excerpt).toBe(body);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.identity).toBe(first.identity);
    expect(second.source).toEqual(first.source);
    expect(second.url).toBe(first.url);
  },
);
