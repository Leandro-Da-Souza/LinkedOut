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
  kind: 'draft' | 'agent';
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
  ): { runId: string; draft?: Draft } {
    return this.reserveRun('draft', userId, requestHash, request, key, context);
  }
  private reserveRun(
    kind: Run['kind'],
    userId: string,
    requestHash: string,
    request: unknown,
    key: string | undefined,
    context: ExecutionContext,
  ): { runId: string; draft?: Draft } {
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
  completeDraft(draft: Draft): void {
    this.guarded(() =>
      this.transaction(() => {
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
      code === 'UNGROUNDED_OUTPUT' && parsed.success
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
    return {
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
      planning: row['planning_json']
        ? (JSON.parse(String(row['planning_json'])) as unknown)
        : null,
    };
  }
}
