import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evidencePrefix,
  validateResearchQuote,
} from '../src/application/research-evidence.js';
import { ResearchWorkflow } from '../src/application/research.js';
import {
  researchFailure,
  researchErrorDetails,
  AppError,
} from '../src/domain/errors.js';
import type { ResearchDiagnostic } from '../src/domain/errors.js';
import {
  userProfileSchema,
  type ExecutionContext,
} from '../src/domain/contracts.js';
import {
  RESEARCH_SOURCES,
  type ResearchFeed,
  type ResearchPlanner,
  type ResearchResult,
} from '../src/domain/research.js';
import type { KnowledgeContext } from '../src/domain/knowledge.js';
import { SqliteStore } from '../src/infrastructure/sqlite.js';
import { reportFailure } from '../src/entrypoints/main.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const context: ExecutionContext = {
  actor: 'test',
  permissions: new Set(['research_local']),
};
const now = () => new Date('2026-10-16T12:00:00Z');
const secret = 'PRIVATE_REJECTED_MODEL_VALUE';
function fixture(
  output: unknown,
  privateText = 'A synthetic TypeScript project with factual private evidence.',
) {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-evidence-'));
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new SqliteStore(dir);
  cleanup.push(() => store.close());
  const source = RESEARCH_SOURCES[0]!;
  const feed: ResearchFeed = {
    collect: vi.fn<ResearchFeed['collect']>(async () => ({
      items: [
        {
          id: 'application-public-id',
          identity: 'microsoft/typescript:1',
          repository: source.repository,
          releaseId: 1,
          url: 'https://github.com/microsoft/TypeScript/releases/tag/v1',
          title: 'Fixture release',
          tag: 'v1',
          publishedAt: '2026-10-15T00:00:00Z',
          rawPublicationDate: '2026-10-15T00:00:00Z',
          dateQuality: 'valid',
          retrievedAt: now().toISOString(),
          excerpt: 'Release notes: ' + 'TypeScript support. '.repeat(70),
          contentHash: 'fixture-hash',
          prerelease: false,
          truncated: false,
          source,
          verification: 'publisher_reported',
        },
      ],
      outcomes: [
        {
          repository: source.repository,
          status: 'ok',
          count: 1,
          truncated: false,
        },
      ],
      requests: 1,
    })),
  };
  const knowledge: KnowledgeContext = {
    revision: 'synthetic',
    issues: [],
    sources: [
      {
        id: 'application-private-id',
        documentId: 'synthetic-doc',
        path: 'synthetic.md',
        contentHash: 'synthetic-hash',
        excerpt: privateText,
        page: null,
        startLine: 1,
      },
    ],
  };
  const planResearch = vi.fn<ResearchPlanner['planResearch']>(async () => ({
    output,
    metadata: { provider: 'fixture', model: 'fixture' },
  }));
  const planner: ResearchPlanner = {
    provider: 'fixture',
    model: 'fixture',
    planResearch,
  };
  const service = new ResearchWorkflow(
    store,
    feed,
    planner,
    userProfileSchema.parse({}),
    { retrieve: async () => knowledge },
    { log() {} },
    14,
    120_000,
    now,
  );
  return { dir, store, service, planResearch, knowledge, feed };
}

describe('application-owned evidence prefixes', () => {
  it('preserves exact text and avoids a dangling high surrogate at the UTF-16 boundary', () => {
    const text = 'x'.repeat(799) + '😀tail';
    expect(evidencePrefix(text)).toBe('x'.repeat(799));
    expect(evidencePrefix('x'.repeat(798) + '😀tail')).toHaveLength(800);
    expect(evidencePrefix('  exact whitespace\nretained  ')).toBe(
      '  exact whitespace\nretained  ',
    );
    expect(evidencePrefix('')).toBe('');
  });
  it('constructs public and private quotations without model identifiers or quotation copying', async () => {
    const f = fixture(
      { ideas: [{ angle: 'experiment', personalEvidenceIndex: 0 }] },
      'TypeScript ' + 'synthetic private evidence '.repeat(50),
    );
    const run = await f.service.run({}, context);
    const idea = run.result.ideas[0]!;
    expect(idea.publicEvidence.itemId).toBe('application-public-id');
    expect(idea.publicEvidence.quote).toBe(
      run.result.evidenceSnapshot[0]!.excerpt.slice(0, 800),
    );
    expect(idea.personalEvidence).toMatchObject({
      sourceId: 'application-private-id',
      quote: f.knowledge.sources[0]!.excerpt.slice(0, 800),
      source: { contentHash: 'synthetic-hash', path: 'synthetic.md' },
    });
    expect(idea.publicEvidence.quote).not.toContain(
      'synthetic private evidence',
    );
    expect(f.planResearch).toHaveBeenCalledTimes(1);
    const request = f.planResearch.mock.calls[0]!;
    expect(JSON.stringify(request[0])).not.toContain('application-public-id');
    expect(JSON.stringify(request[0])).not.toContain('"personalSourceId"');
  });
  it('filters short private options and validates against the offered prefix, not later text', async () => {
    const short = fixture(
      { ideas: [{ angle: 'experiment', personalEvidenceIndex: 0 }] },
      'TypeScript',
    );
    await expect(short.service.run({}, context)).rejects.toMatchObject({
      groundingDiagnostic: { reason: 'SELECTION_OUT_OF_RANGE' },
    });
    const late = fixture(
      { ideas: [{ angle: 'experiment', personalEvidenceIndex: 0 }] },
      'z'.repeat(801) + ' TypeScript',
    );
    await expect(late.service.run({}, context)).rejects.toMatchObject({
      groundingDiagnostic: { reason: 'SOURCE_NOT_RELEVANT' },
    });
  });
});

const failures: {
  output: unknown;
  stage: ResearchDiagnostic['stage'];
  reason: ResearchDiagnostic['reason'];
  index: number | null;
  privateText?: string;
}[] = [
  {
    output: { ideas: [{ angle: secret, personalEvidenceIndex: null }] },
    stage: 'output_schema',
    reason: 'INVALID_SCHEMA',
    index: 0,
  },
  {
    output: {
      ideas: [
        { angle: 'experiment', personalEvidenceIndex: null, [secret]: secret },
      ],
    },
    stage: 'output_schema',
    reason: 'INVALID_SCHEMA',
    index: 0,
  },
  {
    output: { [secret]: secret },
    stage: 'output_schema',
    reason: 'INVALID_SCHEMA',
    index: null,
  },
  {
    output: { ideas: [] },
    stage: 'candidate_count',
    reason: 'COUNT_MISMATCH',
    index: null,
  },
  {
    output: {
      ideas: [
        { angle: 'experiment', personalEvidenceIndex: null },
        { angle: 'experiment', personalEvidenceIndex: null },
      ],
    },
    stage: 'candidate_count',
    reason: 'COUNT_MISMATCH',
    index: null,
  },
  ...[-1, 1, 999].map((index) => ({
    output: { ideas: [{ angle: 'experiment', personalEvidenceIndex: index }] },
    stage: 'private_evidence' as const,
    reason: 'SELECTION_OUT_OF_RANGE' as const,
    index: 0,
  })),
  {
    output: { ideas: [{ angle: 'experiment', personalEvidenceIndex: 0.5 }] },
    stage: 'output_schema',
    reason: 'INVALID_SCHEMA',
    index: 0,
  },
  {
    output: { ideas: [{ angle: 'experiment', personalEvidenceIndex: 0 }] },
    stage: 'private_evidence',
    reason: 'SOURCE_NOT_RELEVANT',
    index: 0,
    privateText: 'Unrelated synthetic culinary experience.',
  },
];

it.each(failures)(
  'persists precise $stage / $reason diagnostics without rejected data',
  async ({ output, stage, reason, index, privateText }) => {
    const f = fixture(output, privateText);
    const diagnostic = { scope: 'research', stage, reason, index };
    await expect(f.service.run({}, context)).rejects.toMatchObject({
      groundingDiagnostic: diagnostic,
    });
    const runId = f.store.listRuns('local')[0]!.id;
    const reopened = new SqliteStore(f.dir);
    cleanup.push(() => reopened.close());
    expect(reopened.getRun('local', runId).groundingDiagnostic).toEqual(
      diagnostic,
    );
    expect(reopened.listIdeas('local', 20, 0)).toEqual([]);
    const db = new DatabaseSync(join(f.dir, 'linkedout.sqlite'));
    cleanup.push(() => db.close());
    const execution = db
      .prepare('SELECT * FROM tool_executions WHERE run_id = ?')
      .get(runId)!;
    expect(JSON.parse(String(execution['grounding_diagnostic_json']))).toEqual(
      diagnostic,
    );
    expect(JSON.stringify(execution)).not.toContain(secret);
    expect(JSON.stringify(reopened.getRun('local', runId))).not.toContain(
      secret,
    );
  },
);

it.each([
  ['EXCERPT_TOO_SHORT', 'x'.repeat(30), 'short'],
  ['EXCERPT_TOO_LONG', 'x'.repeat(801), 'x'.repeat(801)],
  ['QUOTE_NOT_IN_SOURCE', 'x'.repeat(30), 'y'.repeat(20)],
] as const)(
  'records the precise deterministic quote rejection: %s',
  (reason, source, quote) => {
    const f = fixture({});
    for (const stage of ['public_evidence', 'private_evidence'] as const) {
      let failure: AppError | undefined;
      try {
        validateResearchQuote(source, quote, stage, 0);
      } catch (error) {
        failure = error as AppError;
      }
      expect(failure?.groundingDiagnostic).toEqual({
        scope: 'research',
        stage,
        reason,
        index: 0,
      });
      const reservation = f.store.reserveResearch(
        'local',
        'fixture',
        {},
        undefined,
        context,
      );
      f.store.failRun(
        reservation.runId,
        failure!.code,
        failure!.groundingDiagnostic,
      );
      expect(
        f.store.getRun('local', reservation.runId).groundingDiagnostic,
      ).toEqual(failure!.groundingDiagnostic);
    }
  },
);

it('allowlists CLI diagnostics and keeps existing drafting error output unchanged', () => {
  const write = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  const exitCode = process.exitCode;
  try {
    const error = researchFailure(
      'private_evidence',
      'SELECTION_OUT_OF_RANGE',
      0,
    );
    Object.assign(error.groundingDiagnostic!, {
      raw: secret,
      url: secret,
      quote: secret,
    });
    reportFailure(error);
    const printed = String(write.mock.calls[0]![0]);
    expect(JSON.parse(printed).error.groundingDiagnostic).toEqual({
      scope: 'research',
      stage: 'private_evidence',
      reason: 'SELECTION_OUT_OF_RANGE',
      index: 0,
    });
    expect(printed).not.toContain(secret);
    expect(
      researchErrorDetails(
        new AppError('UNGROUNDED_OUTPUT', 'draft failure', {
          scope: 'claim',
          reason: 'UNKNOWN_SOURCE',
          index: 0,
        }),
      ),
    ).toEqual({});
  } finally {
    write.mockRestore();
    process.exitCode = exitCode;
  }
});

it('replays a historical result shape unchanged without executing the new contract', async () => {
  const f = fixture({
    ideas: [{ angle: 'experiment', personalEvidenceIndex: null }],
  });
  const first = await f.service.run({ idempotencyKey: 'historical' }, context);
  const oldResult: ResearchResult = structuredClone(first.result);
  oldResult.ideas[0]!.publicEvidence.quote =
    'Historical model-selected substring';
  const db = new DatabaseSync(join(f.dir, 'linkedout.sqlite'));
  db.prepare(
    'UPDATE research_results SET result_json = ? WHERE run_id = ?',
  ).run(JSON.stringify(oldResult), first.result.runId);
  db.prepare(
    'UPDATE tool_executions SET request_json = ? WHERE run_id = ?',
  ).run(JSON.stringify({ version: 'research-v1' }), first.result.runId);
  db.close();
  const replay = await f.service.run({ idempotencyKey: 'historical' }, context);
  expect(replay.result).toEqual(oldResult);
  expect(replay.execution).toBe('historical_replay');
  expect(f.feed.collect).toHaveBeenCalledTimes(1);
  expect(f.planResearch).toHaveBeenCalledTimes(1);
});
