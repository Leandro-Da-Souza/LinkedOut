import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { createApplication } from '../src/entrypoints/app.js';
import { createMcpServer } from '../src/entrypoints/mcp-server.js';
import { runCli } from '../src/entrypoints/cli.js';
import { DraftService } from '../src/application/drafting.js';
import {
  resolveResearchDraft,
  researchAttachment,
} from '../src/application/research-drafting.js';
import { digest } from '../src/application/assessment.js';
import { GithubResearchFeed } from '../src/infrastructure/github-research.js';
import { SqliteStore } from '../src/infrastructure/sqlite.js';
import { userProfileSchema } from '../src/domain/contracts.js';
import type {
  DraftProvider,
  DraftResult,
  ExecutionContext,
} from '../src/domain/contracts.js';
import { RESEARCH_SOURCES } from '../src/domain/research.js';
import { EMPTY_KNOWLEDGE } from '../src/domain/knowledge.js';
import { diagnosticKnowledge } from './fixtures/grounding.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const context: ExecutionContext = {
  actor: 'test',
  permissions: new Set([
    'draft_local',
    'research_local',
    'read_local',
    'review_local',
    'delete_local',
  ]),
};
const metadata = { provider: 'fixture', model: 'fixture' };
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-research-draft-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const provider: DraftProvider = {
    ...metadata,
    generateDraft: vi.fn(async () => ({
      output: {
        body: 'What would you evaluate before adopting this?',
        warnings: [],
      },
      metadata,
    })),
    assessDraft: vi.fn<DraftProvider['assessDraft']>(async (request) => ({
      output: {
        units: request.units.map((unit) => ({
          id: unit.id,
          category: 'advice_opinion_question',
          evidence: null,
        })),
      },
      metadata,
    })),
    proposeTools: vi.fn(async () => {
      throw new Error('No planning allowed');
    }),
  };
  const feed = new GithubResearchFeed(
    vi.fn(async () =>
      Response.json([
        {
          id: 1,
          html_url: 'https://github.com/microsoft/TypeScript/releases/tag/v1',
          name: 'TypeScript release',
          tag_name: 'v1',
          body: 'We shipped TypeScript support for synthetic projects. 😀',
          published_at: new Date(Date.now() - 86_400_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
          draft: false,
          prerelease: false,
        },
      ]),
    ),
  );
  const app = createApplication(
    {
      dataDir: dir,
      knowledgeDir: join(dir, 'knowledge'),
      profile: userProfileSchema.parse({}),
      runTimeoutMs: 120_000,
    },
    {
      provider,
      researchFeed: feed,
      logger: { log() {} },
      researchPlanner: {
        ...metadata,
        planResearch: async (request) => ({
          output: {
            ideas: request.candidates.map(() => ({
              angle: 'experiment',
              personalEvidenceIndex: null,
            })),
          },
          metadata,
        }),
      },
    },
  );
  cleanup.push(() => app.close());
  const result = await app.research.run({}, context);
  const idea = result.result.ideas[0]!;
  await runCli(['ideas', 'review', idea.id, '--status', 'accepted'], app);
  const db = new DatabaseSync(join(dir, 'linkedout.sqlite'));
  cleanup.push(() => db.close());
  return { dir, app, provider, idea, result: result.result, db };
}
const invoke = (f: Awaited<ReturnType<typeof setup>>, key = 'draft-key') =>
  f.app.tools.invoke(
    'draft_from_idea',
    { ideaId: f.idea.id, idempotencyKey: key },
    context,
  ) as Promise<DraftResult>;

describe('accepted research to shared drafting', () => {
  it('creates an attachment and separate citations, preserves lineage, replays across CLI/MCP and restart', async () => {
    const f = await setup();
    const first = (await runCli(
      ['ideas', 'draft', f.idea.id, '--idempotency-key', 'shared'],
      f.app,
    )) as DraftResult;
    const draft = first.draft;
    expect(draft.status).toBe('draft');
    expect(draft.review?.required).toBe(true);
    expect(draft.provenance.origin).toBe('accepted_content_idea');
    expect(draft.provenance.research).toMatchObject({
      ideaId: f.idea.id,
      acceptanceRevision: 1,
    });
    const citation = draft.publicCitations![0]!;
    expect(draft.body.slice(citation.quoteStart, citation.quoteEnd)).toBe(
      f.idea.publicEvidence.quote,
    );
    expect(citation.kind).toBe('research_attachment');
    expect(draft.claims).toEqual([]);
    expect(draft.assessment?.bodyHash).toBe(digest(draft.body));
    expect(draft.body.slice(draft.assessment!.units[0]!.start)).toBe(
      'What would you evaluate before adopting this?',
    );
    expect(
      f.app.store.getRun('local', draft.runId).researchOrigin,
    ).toMatchObject({ ideaId: f.idea.id, researchRunId: f.result.runId });
    const reopened = new SqliteStore(f.dir);
    cleanup.push(() => reopened.close());
    expect(reopened.getDraft('local', draft.id)).toEqual(draft);
    const service = new DraftService(
      reopened,
      f.provider,
      f.app.config.profile,
      { log() {} },
      120_000,
      f.app.knowledge,
    );
    expect(
      (
        await service.createFromIdea(
          { ideaId: f.idea.id, idempotencyKey: 'shared' },
          context,
        )
      ).draft,
    ).toEqual(draft);
    const input = new PassThrough(),
      output = new PassThrough();
    const handle = serveStdio(
      () => createMcpServer(f.app, new AbortController().signal),
      { legacy: 'serve', transport: new StdioServerTransport(input, output) },
    );
    const client = new Client({ name: 'research-drafting-test', version: '1' });
    try {
      await client.connect(new StdioServerTransport(output, input));
      expect(
        (await client.listTools()).tools.find(
          (tool) => tool.name === 'draft_from_idea',
        )?.annotations?.openWorldHint,
      ).toBe(true);
      const replay = await client.callTool({
        name: 'draft_from_idea',
        arguments: { ideaId: f.idea.id, idempotencyKey: 'shared' },
      });
      expect(replay.structuredContent).toMatchObject({
        replayed: true,
        draft: { id: draft.id },
      });
      f.app.store.reviewIdea('local', f.idea.id, 'rejected');
      const blocked = await client.callTool({
        name: 'draft_from_idea',
        arguments: { ideaId: f.idea.id },
      });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain('IDEA_NOT_ACCEPTED');
    } finally {
      await handle.close();
      await client.close();
      input.destroy();
      output.destroy();
    }
    expect(f.provider.generateDraft).toHaveBeenCalledTimes(1);
    expect(f.provider.assessDraft).toHaveBeenCalledTimes(1);
    expect(f.provider.proposeTools).not.toHaveBeenCalled();
  });

  it.each(['proposed', 'rejected'] as const)(
    'rejects %s ideas before model work',
    async (status) => {
      const f = await setup();
      f.app.store.reviewIdea('local', f.idea.id, status);
      await expect(invoke(f)).rejects.toMatchObject({
        code: 'IDEA_NOT_ACCEPTED',
      });
      expect(f.provider.generateDraft).not.toHaveBeenCalled();
    },
  );
  it('enforces permissions, ownership, strict input and missing IDs', async () => {
    const f = await setup();
    await expect(
      f.app.tools.invoke(
        'draft_from_idea',
        { ideaId: f.idea.id },
        { ...context, permissions: new Set(['read_local']) },
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      f.app.tools.invoke(
        'draft_from_idea',
        { ideaId: f.idea.id, approved: true },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const foreign = new DraftService(
      f.app.store,
      f.provider,
      userProfileSchema.parse({ id: 'another' }),
      { log() {} },
    );
    await expect(
      foreign.createFromIdea({ ideaId: f.idea.id }, context),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.provider.generateDraft).not.toHaveBeenCalled();
  });
  it.each(['quote', 'url', 'date', 'hash', 'policy', 'missing'] as const)(
    'rejects inconsistent stored %s before generation',
    async (change) => {
      const f = await setup();
      const result = structuredClone(f.result);
      const item = result.evidenceSnapshot[0]!;
      if (change === 'quote')
        result.ideas[0]!.publicEvidence.quote =
          'A fabricated quotation that is not in the source.';
      if (change === 'url') item.url = 'https://evil.example/releases/tag/v1';
      if (change === 'date') item.publishedAt = 'invalid';
      if (change === 'hash') item.contentHash = 'a'.repeat(64);
      if (change === 'policy') item.source.permittedUses = [];
      if (change === 'missing') result.evidenceSnapshot = [];
      f.db
        .prepare('UPDATE research_results SET result_json = ? WHERE run_id = ?')
        .run(JSON.stringify(result), f.result.runId);
      await expect(invoke(f)).rejects.toMatchObject({
        code: 'RESEARCH_EVIDENCE_INVALID',
      });
      expect(f.provider.generateDraft).not.toHaveBeenCalled();
    },
  );
  it('uses reviewed snapshots with age/revision warnings without changing replay fingerprints', async () => {
    const f = await setup();
    const origin = resolveResearchDraft(
      f.app.store,
      'local',
      f.idea.id,
      new Date(Date.now() + 30 * 86_400_000),
    );
    expect(origin.warnings.join(' ')).toContain('outside the original');
    const first = await invoke(f);
    const item = f.result.evidenceSnapshot[0]!;
    const newer = {
      ...item,
      id: 'newer',
      contentHash: 'b'.repeat(64),
      excerpt: 'New TypeScript content that changes the source.',
      retrievedAt: new Date(Date.now() + 1000).toISOString(),
    };
    f.app.store.saveResearchItems('local', [newer], f.result.runId);
    const second = await invoke(f, 'new-key');
    expect(second.draft.warnings.join(' ')).toContain('more recently observed');
    expect(second.draft.publicCitations).toEqual(first.draft.publicCitations);
    expect((await invoke(f)).draft).toEqual(first.draft);
  });
  it('allows exact private facts separately and conflicts when current private evidence changes', async () => {
    const f = await setup();
    let knowledge = structuredClone(diagnosticKnowledge);
    const service = new DraftService(
      f.app.store,
      f.provider,
      f.app.config.profile,
      { log() {} },
      120_000,
      { retrieve: async () => knowledge },
    );
    vi.mocked(f.provider.generateDraft).mockResolvedValue({
      output: { body: knowledge.sources[0]!.excerpt, warnings: [] },
      metadata,
    });
    vi.mocked(f.provider.assessDraft).mockImplementation(async (request) => ({
      output: {
        units: request.units.map((unit) => ({
          id: unit.id,
          category: 'personal_fact',
          evidence: { sourceId: knowledge.sources[0]!.id, quote: unit.text },
        })),
      },
      metadata,
    }));
    const input = { ideaId: f.idea.id, idempotencyKey: 'private' };
    const first = await service.createFromIdea(input, context);
    expect(first.draft.claims).toHaveLength(1);
    expect(first.draft.publicCitations).toHaveLength(1);
    expect(first.draft.provenance.knowledge?.sources[0]?.id).toBe(
      'synthetic-source',
    );
    knowledge = structuredClone(EMPTY_KNOWLEDGE);
    await expect(service.createFromIdea(input, context)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(f.provider.generateDraft).toHaveBeenCalledTimes(1);
  });
  it.each([
    'personal_fact',
    'general_fact',
    'advice_opinion_question',
  ] as const)(
    'retains public-to-personal claims classified as %s as blocked artifacts',
    async (category) => {
      const f = await setup();
      vi.mocked(f.provider.generateDraft).mockResolvedValue({
        output: {
          body: 'We shipped TypeScript support for synthetic projects.',
          warnings: [],
        },
        metadata,
      });
      vi.mocked(f.provider.assessDraft).mockImplementation(async (request) => ({
        output: {
          units: request.units.map((unit) => ({
            id: unit.id,
            category,
            evidence:
              category === 'advice_opinion_question'
                ? null
                : { sourceId: f.idea.itemId, quote: unit.text },
          })),
        },
        metadata,
      }));
      await expect(invoke(f)).rejects.toMatchObject({
        code: 'UNGROUNDED_OUTPUT',
        reviewArtifactId: expect.any(String),
      });
      const run = f.app.store
        .listRuns('local')
        .find((entry) => entry.kind === 'draft')!;
      const artifact = f.app.store.getReviewArtifact(
        'local',
        run.reviewArtifactId!,
      );
      expect(artifact).toMatchObject({
        publishable: false,
        status: 'blocked',
        reviewRequired: true,
        publicCitations: [{ verification: 'publisher_reported' }],
      });
      expect(artifact.bodyHash).toBe(digest(artifact.body));
      expect(f.app.store.listDrafts('local').total).toBe(0);
      await expect(invoke(f)).rejects.toMatchObject({
        code: 'PREVIOUS_FAILURE',
        reviewArtifactId: artifact.id,
      });
      expect(f.provider.generateDraft).toHaveBeenCalledTimes(1);
    },
  );
  it('protects concurrent review transitions, reservations and deletion', async () => {
    const f = await setup();
    const other = new SqliteStore(f.dir);
    cleanup.push(() => other.close());
    vi.mocked(f.provider.generateDraft).mockImplementation(async () => {
      await expect(invoke(f)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
      expect(() => other.deleteResearchRun('local', f.result.runId)).toThrow(
        /linked drafting run/,
      );
      other.reviewIdea('local', f.idea.id, 'rejected');
      other.reviewIdea('local', f.idea.id, 'accepted');
      return {
        output: { body: 'What would you evaluate?', warnings: [] },
        metadata,
      };
    });
    await expect(invoke(f)).rejects.toMatchObject({
      code: 'RESEARCH_REVIEW_CHANGED',
      reviewArtifactId: expect.any(String),
    });
    expect(f.app.store.listDrafts('local').total).toBe(0);
    expect(f.app.store.listReviewArtifacts('local').total).toBe(1);
  });
  it('retains derivatives and frozen evidence on research deletion while preventing generation', async () => {
    const f = await setup();
    const first = await invoke(f);
    const deletion = await runCli(
      ['research', 'delete-run', f.result.runId],
      f.app,
    );
    expect(deletion).toMatchObject({
      deleted: true,
      retainedDerivatives: [{ draftId: first.draft.id }],
    });
    expect(f.app.store.getDraft('local', first.draft.id)).toEqual(first.draft);
    await expect(invoke(f)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.provider.generateDraft).toHaveBeenCalledTimes(1);
  });
  it('retains overlength candidates and invalid assessments, without a successful draft', async () => {
    const f = await setup();
    vi.mocked(f.provider.generateDraft).mockResolvedValueOnce({
      output: { body: 'x'.repeat(2990), warnings: [] },
      metadata,
    });
    await expect(invoke(f)).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
      reviewArtifactId: expect.any(String),
    });
    expect(f.provider.assessDraft).not.toHaveBeenCalled();
    vi.mocked(f.provider.assessDraft).mockResolvedValueOnce({
      output: { units: [] },
      metadata,
    });
    await expect(invoke(f, 'malformed')).rejects.toMatchObject({
      code: 'UNGROUNDED_OUTPUT',
      reviewArtifactId: expect.any(String),
    });
  });
  it('retains the assembled body on cancellation during assessment', async () => {
    const f = await setup();
    const controller = new AbortController();
    vi.mocked(f.provider.assessDraft).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('raw failure');
    });
    await expect(
      f.app.tools.invoke(
        'draft_from_idea',
        { ideaId: f.idea.id },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      reviewArtifactId: expect.any(String),
    });
    const artifact = f.app.store.getReviewArtifact(
      'local',
      f.app.store.listRuns('local').find((run) => run.kind === 'draft')!
        .reviewArtifactId!,
    );
    expect(artifact.body).toContain('Publisher report:');
  });
  it('renders Unicode/multiline quotations exactly without model-controlled spans', async () => {
    const f = await setup();
    const { research } = resolveResearchDraft(f.app.store, 'local', f.idea.id);
    research.quote = '  😀 A multiline quotation.\nSecond line!  ';
    const { prefix, citation } = researchAttachment(research);
    expect(prefix.slice(citation.quoteStart, citation.quoteEnd)).toBe(
      research.quote,
    );
    expect(prefix.slice(citation.end)).toBe('\n\n');
  });
});

it('migrates accepted v4 ideas with original planning-only policies without inventing acceptance', async () => {
  const f = await setup();
  const old = structuredClone(f.result);
  old.evidenceSnapshot[0]!.source.permittedUses = [
    'local_research',
    'model_planning',
  ];
  f.db
    .prepare('UPDATE research_results SET result_json = ? WHERE run_id = ?')
    .run(JSON.stringify(old), old.runId);
  f.db
    .prepare('UPDATE research_items SET item_json = ? WHERE id = ?')
    .run(JSON.stringify(old.evidenceSnapshot[0]), f.idea.itemId);
  const reviews = f.db.prepare('SELECT count(*) AS n FROM idea_reviews').get()![
    'n'
  ];
  f.db.exec(
    'DROP TABLE research_draft_links; ALTER TABLE content_ideas DROP COLUMN review_revision; PRAGMA user_version = 4;',
  );
  const reopened = new SqliteStore(f.dir);
  cleanup.push(() => reopened.close());
  const service = new DraftService(reopened, f.provider, f.app.config.profile, {
    log() {},
  });
  const drafted = await service.createFromIdea({ ideaId: f.idea.id }, context);
  expect(drafted.draft.provenance.research?.acceptanceRevision).toBe(0);
  expect(drafted.draft.provenance.research?.item.source.permittedUses).toEqual([
    'local_research',
    'model_planning',
  ]);
  expect(drafted.draft.provenance.research?.policy.permittedUses).toContain(
    'model_drafting',
  );
  expect(
    f.db.prepare('SELECT count(*) AS n FROM idea_reviews').get()!['n'],
  ).toBe(reviews);
});

it('requires current source drafting permission before model work', async () => {
  const f = await setup();
  const source = RESEARCH_SOURCES[0]!;
  const uses = source.permittedUses;
  try {
    source.permittedUses = ['local_research', 'model_planning'];
    await expect(invoke(f)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(f.provider.generateDraft).not.toHaveBeenCalled();
  } finally {
    source.permittedUses = uses;
  }
});

it('atomically rolls back failed successful completion and retains a blocked artifact', async () => {
  const f = await setup();
  f.db.exec(
    "CREATE TRIGGER fail_draft_success BEFORE UPDATE ON runs WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  await expect(invoke(f)).rejects.toMatchObject({
    code: 'STORAGE_ERROR',
    reviewArtifactId: expect.any(String),
  });
  expect(f.app.store.listDrafts('local').total).toBe(0);
  const run = f.app.store
    .listRuns('local')
    .find((entry) => entry.kind === 'draft')!;
  expect(run.status).toBe('failed');
  expect(run.researchOrigin?.ideaId).toBe(f.idea.id);
  expect(
    f.app.store.getReviewArtifact('local', run.reviewArtifactId!)
      .publicCitations,
  ).toHaveLength(1);
});

it('excludes historical private quotations from current generation and preserves the warning', async () => {
  const f = await setup();
  const old = structuredClone(f.result);
  const source = diagnosticKnowledge.sources[0]!;
  old.ideas[0]!.personalEvidence = {
    sourceId: source.id,
    quote: source.excerpt,
    source,
  };
  f.db
    .prepare('UPDATE research_results SET result_json = ? WHERE run_id = ?')
    .run(JSON.stringify(old), old.runId);
  f.db
    .prepare('UPDATE content_ideas SET idea_json = ? WHERE id = ?')
    .run(JSON.stringify(old.ideas[0]), f.idea.id);
  const drafted = await invoke(f);
  expect(drafted.draft.warnings.join(' ')).toContain(
    'historical private quotation was not supplied',
  );
  expect(
    JSON.stringify(vi.mocked(f.provider.generateDraft).mock.calls[0]![0]),
  ).not.toContain(source.excerpt);
});

it('rechecks acceptance after retrieval and conflicts with existing research keys', async () => {
  const f = await setup();
  const service = new DraftService(
    f.app.store,
    f.provider,
    f.app.config.profile,
    { log() {} },
    120_000,
    {
      retrieve: async () => {
        f.app.store.reviewIdea('local', f.idea.id, 'rejected');
        return EMPTY_KNOWLEDGE;
      },
    },
  );
  await expect(
    service.createFromIdea({ ideaId: f.idea.id }, context),
  ).rejects.toMatchObject({ code: 'RESEARCH_REVIEW_CHANGED' });
  expect(f.provider.generateDraft).not.toHaveBeenCalled();
  f.app.store.reviewIdea('local', f.idea.id, 'accepted');
  f.app.store.reserveResearch(
    'local',
    'research-hash',
    {},
    'shared-research',
    context,
  );
  await expect(invoke(f, 'shared-research')).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
});
