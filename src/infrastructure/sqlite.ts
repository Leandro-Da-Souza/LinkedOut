import type { ResearchDraftContext } from '../domain/research-draft.js';
import type {
  ContentIdea,
  ResearchItem,
  ResearchResult,
} from '../domain/research.js';
import type { ReviewArtifact } from '../domain/assessment.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Draft, ExecutionContext } from '../domain/contracts.js';
import { AppError, groundingDiagnosticSchema } from '../domain/errors.js';
import type { ErrorCode, GroundingDiagnostic } from '../domain/errors.js';

export interface Run {
  id: string;
  userId: string;
  kind: 'draft' | 'agent' | 'research';
  actor: ExecutionContext['actor'];
  status: 'running' | 'succeeded' | 'failed';
  createdAt: string;
  finishedAt: string | null;
  parentRunId: string | null;
  errorCode: ErrorCode | null;
  groundingDiagnostic: GroundingDiagnostic | null;
  draftId: string | null;
  reviewArtifactId: string | null;
  planning: unknown;
  researchOrigin?: {
    ideaId: string;
    researchRunId: string;
    acceptanceRevision: number;
    evidenceHash: string;
  };
  researchResultId?: string | null;
}

// Numbered migrations stay append-only. BEGIN IMMEDIATE serializes startup migrations.
const migrations = [
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
    actor TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
    created_at TEXT NOT NULL, finished_at TEXT, parent_run_id TEXT REFERENCES runs(id),
    error_code TEXT, draft_id TEXT, planning_json TEXT
  );
  CREATE TABLE tool_executions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    user_id TEXT NOT NULL, idempotency_key TEXT, request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
    draft_id TEXT, error_code TEXT, UNIQUE(user_id, idempotency_key)
  );
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    created_at TEXT NOT NULL, draft_json TEXT NOT NULL
  );
  CREATE INDEX drafts_owner_order ON drafts(user_id, created_at DESC, id DESC);
  CREATE INDEX runs_owner_order ON runs(user_id, created_at DESC, id DESC);`,
  `ALTER TABLE runs ADD COLUMN grounding_diagnostic_json TEXT;
  ALTER TABLE tool_executions ADD COLUMN grounding_diagnostic_json TEXT;`,
  `CREATE TABLE review_artifacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    created_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
    parent_revision_id TEXT, artifact_json TEXT NOT NULL
  );
  CREATE INDEX artifacts_owner_order ON review_artifacts(user_id, created_at DESC, id DESC);
  ALTER TABLE runs ADD COLUMN review_artifact_id TEXT;
  ALTER TABLE tool_executions ADD COLUMN review_artifact_id TEXT;`,
  `CREATE TABLE research_items (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, identity TEXT NOT NULL,
    content_hash TEXT NOT NULL, retrieved_at TEXT NOT NULL, item_json TEXT NOT NULL,
    UNIQUE(user_id, identity, content_hash)
  );
  CREATE TABLE research_cache (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE research_run_items (
    run_id TEXT NOT NULL REFERENCES runs(id), item_id TEXT NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
    PRIMARY KEY(run_id, item_id)
  );
  CREATE TABLE research_results (
    run_id TEXT PRIMARY KEY REFERENCES runs(id), user_id TEXT NOT NULL, result_json TEXT NOT NULL
  );
  CREATE TABLE content_ideas (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
    item_id TEXT NOT NULL REFERENCES research_items(id), identity TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')), idea_json TEXT NOT NULL,
    UNIQUE(user_id, identity)
  );
  CREATE TABLE idea_reviews (
    id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES content_ideas(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, status TEXT NOT NULL
  );
  ALTER TABLE runs ADD COLUMN research_result_id TEXT;
  ALTER TABLE tool_executions ADD COLUMN research_result_id TEXT;`,
  `ALTER TABLE content_ideas ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE research_draft_links (
    run_id TEXT PRIMARY KEY REFERENCES runs(id), user_id TEXT NOT NULL,
    idea_id TEXT NOT NULL, research_run_id TEXT NOT NULL,
    acceptance_revision INTEGER NOT NULL, evidence_hash TEXT NOT NULL
  );
  CREATE INDEX research_draft_origin ON research_draft_links(user_id, research_run_id);`,
];

export class SqliteStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const file = join(dataDir, 'linkedout.sqlite');
      this.db = new DatabaseSync(file);
      if (process.platform !== 'win32') chmodSync(file, 0o600);
      this.db.exec(
        'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;',
      );
      this.transaction(() => {
        const version = Number(
          this.db.prepare('PRAGMA user_version').get()?.['user_version'],
        );
        if (version > migrations.length)
          throw new AppError(
            'STORAGE_ERROR',
            'Database schema is newer than this application.',
          );
        for (let index = version; index < migrations.length; index++) {
          this.db.exec(migrations[index]!);
          this.db.exec(`PRAGMA user_version = ${index + 1};`);
        }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'STORAGE_ERROR',
        'Cannot open local draft storage. Check directory permissions.',
      );
    }
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private guarded<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('STORAGE_ERROR', 'Local storage operation failed.');
    }
  }
  private insertRun(
    userId: string,
    kind: Run['kind'],
    context: ExecutionContext,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO runs (id, user_id, kind, actor, status, created_at, parent_run_id)
      VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        userId,
        kind,
        context.actor,
        new Date().toISOString(),
        context.parentRunId ?? null,
      );
    return id;
  }
  reserveResearch(
    userId: string,
    requestHash: string,
    request: unknown,
    key: string | undefined,
    context: ExecutionContext,
  ): { runId: string; result?: ResearchResult } {
    return this.guarded(() =>
      this.transaction(() => {
        if (key) {
          const previous = this.db
            .prepare(
              'SELECT * FROM tool_executions WHERE user_id = ? AND idempotency_key = ?',
            )
            .get(userId, key);
          if (previous) {
            if (previous['request_hash'] !== requestHash)
              throw new AppError(
                'IDEMPOTENCY_CONFLICT',
                'This key belongs to different input or execution kind.',
              );
            if (previous['status'] === 'running')
              throw new AppError(
                'IN_PROGRESS',
                'Research is running or was interrupted. Inspect history; use a new key for deliberate retry.',
              );
            if (previous['status'] === 'failed')
              throw new AppError(
                'PREVIOUS_FAILURE',
                'Research previously failed. Use a new key for deliberate retry.',
                previous['grounding_diagnostic_json']
                  ? groundingDiagnosticSchema.parse(
                      JSON.parse(String(previous['grounding_diagnostic_json'])),
                    )
                  : undefined,
              );
            const result = this.db
              .prepare(
                'SELECT result_json FROM research_results WHERE run_id = ? AND user_id = ?',
              )
              .get(String(previous['run_id']), userId);
            if (!result)
              throw new AppError(
                'NOT_FOUND',
                'The historical research result was deleted. Use a new key for new research.',
              );
            return {
              runId: String(previous['run_id']),
              result: JSON.parse(
                String(result['result_json']),
              ) as ResearchResult,
            };
          }
        }
        const runId = this.insertRun(userId, 'research', context);
        this.db
          .prepare(
            "INSERT INTO tool_executions (id, run_id, user_id, idempotency_key, request_hash, request_json, status) VALUES (?, ?, ?, ?, ?, ?, 'running')",
          )
          .run(
            randomUUID(),
            runId,
            userId,
            key ?? null,
            requestHash,
            JSON.stringify(request),
          );
        return { runId };
      }),
    );
  }
  getResearchCache(key: string): unknown {
    return this.guarded(() => {
      const row = this.db
        .prepare('SELECT value_json FROM research_cache WHERE key = ?')
        .get(key);
      return row
        ? (JSON.parse(String(row['value_json'])) as unknown)
        : undefined;
    });
  }
  setResearchCache(key: string, value: unknown): void {
    this.guarded(() =>
      this.db
        .prepare(
          'INSERT INTO research_cache (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
        )
        .run(key, JSON.stringify(value)),
    );
  }
  saveResearchItems(
    userId: string,
    items: ResearchItem[],
    runId: string,
  ): ResearchItem[] {
    return this.guarded(() =>
      this.transaction(() =>
        items.map((item) => {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO research_items (id, user_id, identity, content_hash, retrieved_at, item_json) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              item.id,
              userId,
              item.identity,
              item.contentHash,
              item.retrievedAt,
              JSON.stringify(item),
            );
          const row = this.db
            .prepare(
              'SELECT id FROM research_items WHERE user_id = ? AND identity = ? AND content_hash = ?',
            )
            .get(userId, item.identity, item.contentHash)!;
          const current = { ...item, id: String(row['id']) };
          this.db
            .prepare(
              'UPDATE research_items SET retrieved_at = ?, item_json = ? WHERE id = ?',
            )
            .run(item.retrievedAt, JSON.stringify(current), current.id);
          this.db
            .prepare(
              'INSERT OR IGNORE INTO research_run_items (run_id, item_id) VALUES (?, ?)',
            )
            .run(runId, current.id);
          return current;
        }),
      ),
    );
  }
  researchIdentitySeen(userId: string, identity: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT id FROM content_ideas WHERE user_id = ? AND identity = ?',
        )
        .get(userId, identity),
    );
  }
  completeResearch(userId: string, result: ResearchResult): void {
    this.guarded(() =>
      this.transaction(() => {
        // A concurrent run may have proposed the same release after initial selection.
        result.ideas = result.ideas.filter(
          (idea) => !this.researchIdentitySeen(userId, idea.identity),
        );
        for (const idea of result.ideas)
          this.db
            .prepare(
              'INSERT INTO content_ideas (id, user_id, run_id, item_id, identity, status, idea_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              idea.id,
              userId,
              result.runId,
              idea.itemId,
              idea.identity,
              idea.status,
              JSON.stringify(idea),
            );
        this.db
          .prepare(
            'INSERT INTO research_results (run_id, user_id, result_json) VALUES (?, ?, ?)',
          )
          .run(result.runId, userId, JSON.stringify(result));
        this.db
          .prepare(
            "UPDATE runs SET status = 'succeeded', finished_at = ?, research_result_id = ?, planning_json = ? WHERE id = ? AND status = 'running'",
          )
          .run(
            new Date().toISOString(),
            result.runId,
            JSON.stringify({
              coverage: result.coverage,
              ideaCount: result.ideas.length,
              requests: result.requests,
              modelCalls: result.modelCalls,
              outcomes: result.outcomes,
              generation: result.generation,
            }),
            result.runId,
          );
        this.db
          .prepare(
            "UPDATE tool_executions SET status = 'succeeded', research_result_id = ? WHERE run_id = ? AND status = 'running'",
          )
          .run(result.runId, result.runId);
      }),
    );
  }
  listResearchItems(userId: string, limit: number, offset: number) {
    return this.guarded(() =>
      this.db
        .prepare(
          'SELECT id, item_json FROM research_items WHERE user_id = ? ORDER BY retrieved_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(userId, limit, offset)
        .map((row) => {
          const item = JSON.parse(String(row['item_json'])) as ResearchItem;
          return {
            id: item.id,
            repository: item.repository,
            title: item.title,
            publishedAt: item.publishedAt,
            retrievedAt: item.retrievedAt,
            url: item.url,
            dateQuality: item.dateQuality,
          };
        }),
    );
  }
  getResearchItem(userId: string, id: string): ResearchItem {
    return this.guarded(() => {
      const row = this.db
        .prepare(
          'SELECT item_json FROM research_items WHERE user_id = ? AND id = ?',
        )
        .get(userId, id);
      if (!row) throw new AppError('NOT_FOUND', 'Research item not found.');
      return JSON.parse(String(row['item_json'])) as ResearchItem;
    });
  }
  listIdeas(userId: string, limit: number, offset: number, status?: string) {
    return this.guarded(() =>
      this.db
        .prepare(
          'SELECT idea_json, status FROM content_ideas WHERE user_id = ? AND (? IS NULL OR status = ?) ORDER BY (SELECT created_at FROM runs WHERE runs.id = content_ideas.run_id) DESC, run_id DESC, rowid ASC LIMIT ? OFFSET ?',
        )
        .all(userId, status ?? null, status ?? null, limit, offset)
        .map((row) => {
          const idea = JSON.parse(String(row['idea_json'])) as ContentIdea;
          return {
            id: idea.id,
            runId: idea.runId,
            title: idea.title,
            angle: idea.angle,
            score: idea.score.total,
            status: String(row['status']),
            publishedAt: idea.publicEvidence.publishedAt,
            reviewRequired: true,
          };
        }),
    );
  }
  getIdea(userId: string, id: string): ContentIdea {
    return this.guarded(() => {
      const row = this.db
        .prepare(
          'SELECT idea_json, status FROM content_ideas WHERE user_id = ? AND id = ?',
        )
        .get(userId, id);
      if (!row) throw new AppError('NOT_FOUND', 'Idea not found.');
      return {
        ...(JSON.parse(String(row['idea_json'])) as ContentIdea),
        status: row['status'] as ContentIdea['status'],
      };
    });
  }
  getIdeaDraftState(userId: string, id: string) {
    return this.guarded(() => {
      const idea = this.getIdea(userId, id);
      const row = this.db
        .prepare(
          'SELECT review_revision FROM content_ideas WHERE user_id = ? AND id = ?',
        )
        .get(userId, id)!;
      const result = this.db
        .prepare(
          'SELECT result_json FROM research_results WHERE user_id = ? AND run_id = ?',
        )
        .get(userId, idea.runId);
      if (!result)
        throw new AppError(
          'RESEARCH_EVIDENCE_INVALID',
          'The original research snapshot is unavailable.',
        );
      return {
        idea,
        revision: Number(row['review_revision']),
        result: JSON.parse(String(result['result_json'])) as ResearchResult,
      };
    });
  }
  hasNewerResearchRevision(userId: string, item: ResearchItem): boolean {
    return this.guarded(() =>
      Boolean(
        this.db
          .prepare(
            'SELECT 1 FROM research_items WHERE user_id = ? AND identity = ? AND content_hash <> ? AND retrieved_at > ? LIMIT 1',
          )
          .get(userId, item.identity, item.contentHash, item.retrievedAt),
      ),
    );
  }
  private assertResearchAcceptance(
    userId: string,
    origin: ResearchDraftContext,
  ): void {
    const row = this.db
      .prepare(
        'SELECT status, review_revision FROM content_ideas WHERE user_id = ? AND id = ? AND run_id = ?',
      )
      .get(userId, origin.ideaId, origin.researchRunId);
    if (
      !row ||
      row['status'] !== 'accepted' ||
      Number(row['review_revision']) !== origin.acceptanceRevision
    )
      throw new AppError(
        'RESEARCH_REVIEW_CHANGED',
        'Idea acceptance changed. Generation is not draft approval; review the idea again.',
      );
  }
  reviewIdea(
    userId: string,
    id: string,
    status: ContentIdea['status'],
  ): ContentIdea {
    return this.guarded(() =>
      this.transaction(() => {
        const idea = this.getIdea(userId, id);
        if (idea.status !== status) {
          this.db
            .prepare(
              'UPDATE content_ideas SET status = ?, review_revision = review_revision + 1 WHERE id = ? AND user_id = ?',
            )
            .run(status, id, userId);
          this.db
            .prepare(
              'INSERT INTO idea_reviews (id, idea_id, created_at, status) VALUES (?, ?, ?, ?)',
            )
            .run(randomUUID(), id, new Date().toISOString(), status);
        }
        return { ...idea, status };
      }),
    );
  }
  deleteResearchRun(userId: string, runId: string) {
    return this.guarded(() =>
      this.transaction(() => {
        const run = this.getRun(userId, runId);
        if (run.kind !== 'research')
          throw new AppError('NOT_FOUND', 'Research run not found.');
        if (run.status === 'running')
          throw new AppError(
            'IN_PROGRESS',
            'Cannot delete an active or interrupted research run.',
          );
        const derivatives = this.db
          .prepare(
            'SELECT r.id, r.status, r.draft_id, r.review_artifact_id FROM research_draft_links l JOIN runs r ON r.id = l.run_id WHERE l.user_id = ? AND l.research_run_id = ?',
          )
          .all(userId, runId);
        if (derivatives.some((row) => row['status'] === 'running'))
          throw new AppError(
            'IN_PROGRESS',
            'A linked drafting run is active or interrupted. Research cannot be deleted.',
          );
        this.db
          .prepare('DELETE FROM content_ideas WHERE user_id = ? AND run_id = ?')
          .run(userId, runId);
        this.db
          .prepare(
            'DELETE FROM research_results WHERE user_id = ? AND run_id = ?',
          )
          .run(userId, runId);
        this.db
          .prepare(
            "UPDATE tool_executions SET request_json = '{}', research_result_id = NULL WHERE user_id = ? AND run_id = ?",
          )
          .run(userId, runId);
        this.db
          .prepare(
            'UPDATE runs SET research_result_id = NULL, planning_json = NULL WHERE user_id = ? AND id = ?',
          )
          .run(userId, runId);
        const linked = this.db
          .prepare('SELECT item_id FROM research_run_items WHERE run_id = ?')
          .all(runId);
        this.db
          .prepare('DELETE FROM research_run_items WHERE run_id = ?')
          .run(runId);
        for (const row of linked)
          this.db
            .prepare(
              'DELETE FROM research_items WHERE user_id = ? AND id = ? AND id NOT IN (SELECT item_id FROM content_ideas) AND id NOT IN (SELECT item_id FROM research_run_items)',
            )
            .run(userId, String(row['item_id']));
        this.db
          .prepare("DELETE FROM research_cache WHERE key <> 'github-cooldown'")
          .run();
        return {
          retainedDerivatives: derivatives.map((row) => ({
            runId: String(row['id']),
            draftId: row['draft_id'] as string | null,
            reviewArtifactId: row['review_artifact_id'] as string | null,
          })),
        };
      }),
    );
  }
  pruneResearch(userId: string, before: string): void {
    this.guarded(() =>
      this.transaction(() => {
        this.db
          .prepare(
            'DELETE FROM research_items WHERE user_id = ? AND retrieved_at < ? AND id NOT IN (SELECT item_id FROM content_ideas)',
          )
          .run(userId, before);
        this.db
          .prepare(
            "DELETE FROM research_cache WHERE json_extract(value_json, '$.savedAt') < ?",
          )
          .run(Date.parse(before));
      }),
    );
  }

  reserveAgent(
    userId: string,
    hash: string,
    request: unknown,
    key: string | undefined,
    context: ExecutionContext,
  ): { runId: string; draft?: Draft } {
    return this.reserveRun('agent', userId, hash, request, key, context);
  }
  reserveDraft(
    userId: string,
    requestHash: string,
    request: unknown,
    key: string | undefined,
    context: ExecutionContext,
    origin?: ResearchDraftContext,
  ): { runId: string; draft?: Draft } {
    return this.reserveRun(
      'draft',
      userId,
      requestHash,
      request,
      key,
      context,
      origin,
    );
  }
  private reserveRun(
    kind: Run['kind'],
    userId: string,
    requestHash: string,
    request: unknown,
    key: string | undefined,
    context: ExecutionContext,
    origin?: ResearchDraftContext,
  ): { runId: string; draft?: Draft } {
    return this.guarded(() =>
      this.transaction(() => {
        if (origin) this.assertResearchAcceptance(userId, origin);
        if (key) {
          const previous = this.db
            .prepare(
              'SELECT * FROM tool_executions WHERE user_id = ? AND idempotency_key = ?',
            )
            .get(userId, key);
          if (previous) {
            if (previous['request_hash'] !== requestHash)
              throw new AppError(
                'IDEMPOTENCY_CONFLICT',
                'This key was used with different input, preferences, or generation settings.',
              );
            if (previous['status'] === 'running')
              throw new AppError(
                'IN_PROGRESS',
                'This request is in progress or was interrupted. Inspect its run; use a new key for a deliberate retry.',
              );
            if (previous['status'] === 'failed')
              throw new AppError(
                'PREVIOUS_FAILURE',
                'The original request failed. Inspect its run; use a new key for a deliberate retry.',
                undefined,
                previous['review_artifact_id']
                  ? String(previous['review_artifact_id'])
                  : undefined,
              );
            return {
              runId: String(previous['run_id']),
              draft: this.getDraft(userId, String(previous['draft_id'])),
            };
          }
        }
        const runId = this.insertRun(userId, kind, context);
        this.db
          .prepare(
            `INSERT INTO tool_executions (id, run_id, user_id, idempotency_key, request_hash, request_json, status)
        VALUES (?, ?, ?, ?, ?, ?, 'running')`,
          )
          .run(
            randomUUID(),
            runId,
            userId,
            key ?? null,
            requestHash,
            JSON.stringify(request),
          );
        if (origin)
          this.db
            .prepare(
              'INSERT INTO research_draft_links (run_id, user_id, idea_id, research_run_id, acceptance_revision, evidence_hash) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(
              runId,
              userId,
              origin.ideaId,
              origin.researchRunId,
              origin.acceptanceRevision,
              origin.evidenceHash,
            );
        return { runId };
      }),
    );
  }
  recordPlan(runId: string, planning: unknown): void {
    this.guarded(() =>
      this.db
        .prepare('UPDATE runs SET planning_json = ? WHERE id = ?')
        .run(JSON.stringify(planning), runId),
    );
  }
  completeDraft(draft: Draft, validateResearch?: () => void): void {
    this.guarded(() =>
      this.transaction(() => {
        if (draft.provenance.research) {
          this.assertResearchAcceptance(
            draft.userId,
            draft.provenance.research,
          );
          validateResearch?.();
        }
        this.db
          .prepare(
            'INSERT INTO drafts (id, user_id, run_id, created_at, draft_json) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            draft.id,
            draft.userId,
            draft.runId,
            draft.createdAt,
            JSON.stringify(draft),
          );
        this.finishRun(draft.runId, draft.id);
      }),
    );
  }
  completeAgent(runId: string, draftId: string): void {
    this.guarded(() => this.transaction(() => this.finishRun(runId, draftId)));
  }
  private finishRun(runId: string, draftId: string): void {
    this.db
      .prepare(
        "UPDATE runs SET status = 'succeeded', finished_at = ?, draft_id = ? WHERE id = ? AND status = 'running'",
      )
      .run(new Date().toISOString(), draftId, runId);
    this.db
      .prepare(
        "UPDATE tool_executions SET status = 'succeeded', draft_id = ? WHERE run_id = ? AND status = 'running'",
      )
      .run(draftId, runId);
  }
  failRun(
    runId: string,
    code: ErrorCode,
    diagnostic?: GroundingDiagnostic,
    reviewArtifactId?: string,
  ): void {
    this.guarded(() =>
      this.transaction(() =>
        this.failRunWithinTransaction(
          runId,
          code,
          diagnostic,
          reviewArtifactId,
        ),
      ),
    );
  }
  private failRunWithinTransaction(
    runId: string,
    code: ErrorCode,
    diagnostic?: GroundingDiagnostic,
    reviewArtifactId?: string,
  ): void {
    // Runtime allowlisting strips extra properties; never serialize arbitrary
    // errors, rejected text, source IDs, or provider-supplied fields.
    const parsed = groundingDiagnosticSchema.safeParse(diagnostic);
    const diagnosticJson =
      parsed.success &&
      (code === 'UNGROUNDED_OUTPUT' ||
        (code === 'INVALID_OUTPUT' && parsed.data.scope === 'research'))
        ? JSON.stringify(parsed.data)
        : null;
    const finishedAt = new Date().toISOString();
    for (const table of ['runs', 'tool_executions'] as const) {
      const key = table === 'runs' ? 'id' : 'run_id';
      this.db
        .prepare(
          `UPDATE ${table} SET status = 'failed', ${table === 'runs' ? 'finished_at = ?,' : ''} error_code = ?, grounding_diagnostic_json = ?, review_artifact_id = ? WHERE ${key} = ? AND status = 'running'`,
        )
        .run(
          ...(table === 'runs' ? [finishedAt] : []),
          code,
          diagnosticJson,
          reviewArtifactId ?? null,
          runId,
        );
    }
  }
  failWithArtifact(
    artifact: ReviewArtifact,
    diagnostic?: GroundingDiagnostic,
  ): void {
    this.guarded(() =>
      this.transaction(() => {
        const run = this.db
          .prepare(
            "SELECT id FROM runs WHERE id = ? AND user_id = ? AND status = 'running'",
          )
          .get(artifact.runId, artifact.userId);
        if (!run)
          throw new AppError(
            'STORAGE_ERROR',
            'Cannot attach artifact to a completed or missing run.',
          );
        this.db
          .prepare(
            'INSERT INTO review_artifacts (id, user_id, run_id, created_at, revision, parent_revision_id, artifact_json) VALUES (?, ?, ?, ?, 1, NULL, ?)',
          )
          .run(
            artifact.id,
            artifact.userId,
            artifact.runId,
            artifact.createdAt,
            JSON.stringify(artifact),
          );
        this.failRunWithinTransaction(
          artifact.runId,
          artifact.failureCode,
          diagnostic,
          artifact.id,
        );
      }),
    );
  }
  getReviewArtifact(userId: string, id: string): ReviewArtifact {
    return this.guarded(() => {
      const row = this.db
        .prepare(
          'SELECT artifact_json FROM review_artifacts WHERE user_id = ? AND id = ?',
        )
        .get(userId, id);
      if (!row)
        throw new AppError(
          'NOT_FOUND',
          'Review artifact not found for the configured user.',
        );
      return JSON.parse(String(row['artifact_json'])) as ReviewArtifact;
    });
  }
  listReviewArtifacts(userId: string, limit = 20, offset = 0) {
    return this.guarded(() => ({
      artifacts: this.db
        .prepare(
          'SELECT id, run_id, created_at, revision FROM review_artifacts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(userId, limit, offset)
        .map((row) => ({
          id: String(row['id']),
          runId: String(row['run_id']),
          createdAt: String(row['created_at']),
          revision: Number(row['revision']),
          status: 'blocked' as const,
          publishable: false as const,
        })),
      total: Number(
        this.db
          .prepare(
            'SELECT count(*) AS total FROM review_artifacts WHERE user_id = ?',
          )
          .get(userId)?.['total'],
      ),
    }));
  }
  deleteReviewArtifact(userId: string, id: string): void {
    this.guarded(() =>
      this.transaction(() => {
        const result = this.db
          .prepare('DELETE FROM review_artifacts WHERE user_id = ? AND id = ?')
          .run(userId, id);
        if (!result.changes)
          throw new AppError(
            'NOT_FOUND',
            'Review artifact not found for the configured user.',
          );
        this.db
          .prepare(
            'UPDATE runs SET review_artifact_id = NULL WHERE user_id = ? AND review_artifact_id = ?',
          )
          .run(userId, id);
        this.db
          .prepare(
            'UPDATE tool_executions SET review_artifact_id = NULL WHERE user_id = ? AND review_artifact_id = ?',
          )
          .run(userId, id);
      }),
    );
  }
  getDraft(userId: string, id: string): Draft {
    return this.guarded(() => {
      const row = this.db
        .prepare('SELECT draft_json FROM drafts WHERE user_id = ? AND id = ?')
        .get(userId, id);
      if (!row)
        throw new AppError(
          'NOT_FOUND',
          'Draft not found for the configured user.',
        );
      return JSON.parse(String(row['draft_json'])) as Draft;
    });
  }
  listDrafts(
    userId: string,
    limit = 20,
    offset = 0,
  ): {
    drafts: Pick<Draft, 'id' | 'createdAt' | 'status' | 'runId'>[];
    total: number;
  } {
    return this.guarded(() => ({
      drafts: this.db
        .prepare(
          'SELECT id, created_at, run_id FROM drafts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(userId, limit, offset)
        .map((row) => ({
          id: String(row['id']),
          createdAt: String(row['created_at']),
          runId: String(row['run_id']),
          status: 'draft',
        })),
      total: Number(
        this.db
          .prepare('SELECT count(*) AS total FROM drafts WHERE user_id = ?')
          .get(userId)?.['total'],
      ),
    }));
  }
  getRun(userId: string, id: string): Run {
    return this.guarded(() => {
      const row = this.db
        .prepare('SELECT * FROM runs WHERE user_id = ? AND id = ?')
        .get(userId, id);
      if (!row)
        throw new AppError(
          'NOT_FOUND',
          'Run not found for the configured user.',
        );
      return this.runFromRow(row);
    });
  }
  listRuns(userId: string, limit = 20, offset = 0): Run[] {
    return this.guarded(() =>
      this.db
        .prepare(
          'SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(userId, limit, offset)
        .map((row) => this.runFromRow(row)),
    );
  }
  private runFromRow(row: Record<string, unknown>): Run {
    const link = this.db
      .prepare(
        'SELECT * FROM research_draft_links WHERE run_id = ? AND user_id = ?',
      )
      .get(String(row['id']), String(row['user_id']));
    return {
      ...(link
        ? {
            researchOrigin: {
              ideaId: String(link['idea_id']),
              researchRunId: String(link['research_run_id']),
              acceptanceRevision: Number(link['acceptance_revision']),
              evidenceHash: String(link['evidence_hash']),
            },
          }
        : {}),
      id: String(row['id']),
      userId: String(row['user_id']),
      kind: row['kind'] as Run['kind'],
      actor: row['actor'] as Run['actor'],
      status: row['status'] as Run['status'],
      createdAt: String(row['created_at']),
      finishedAt: row['finished_at'] as string | null,
      parentRunId: row['parent_run_id'] as string | null,
      errorCode: row['error_code'] as ErrorCode | null,
      groundingDiagnostic: row['grounding_diagnostic_json']
        ? groundingDiagnosticSchema.parse(
            JSON.parse(String(row['grounding_diagnostic_json'])),
          )
        : null,
      draftId: row['draft_id'] as string | null,
      reviewArtifactId: row['review_artifact_id'] as string | null,
      ...(row['kind'] === 'research'
        ? { researchResultId: row['research_result_id'] as string | null }
        : {}),
      planning: row['planning_json']
        ? (JSON.parse(String(row['planning_json'])) as unknown)
        : null,
    };
  }
}
