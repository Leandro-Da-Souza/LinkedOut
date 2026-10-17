import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RecoveryService } from '../src/application/recovery.js';
import type { Draft, ExecutionContext } from '../src/domain/contracts.js';
import { userProfileSchema } from '../src/domain/contracts.js';
import type { ReviewArtifact } from '../src/domain/assessment.js';
import type { ResearchResult } from '../src/domain/research.js';
import { EMPTY_KNOWLEDGE } from '../src/domain/knowledge.js';
import type {
  ProcessInspector,
  ProcessObservation,
} from '../src/domain/recovery.js';
import { LinuxProcessInspector } from '../src/infrastructure/process-identity.js';
import { SqliteStore } from '../src/infrastructure/sqlite.js';
import { createApplication } from '../src/entrypoints/app.js';
import { runCli } from '../src/entrypoints/cli.js';

const context: ExecutionContext = {
  actor: 'cli',
  permissions: new Set(['read_local', 'recover_local']),
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-recovery-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let state: ProcessObservation['state'] = 'active';
  const inspector: ProcessInspector = {
    capture: () => ({
      instanceId: randomUUID(),
      platform: 'linux',
      pid: 123,
      identity: { start: '456', boot: randomUUID(), scope: 'synthetic' },
    }),
    inspect: (owner) => ({
      state: owner ? state : 'unknown',
      reason: !owner
        ? 'IDENTITY_UNAVAILABLE'
        : state === 'abandoned'
          ? 'PROCESS_ABSENT'
          : state === 'active'
            ? 'OWNER_ALIVE'
            : 'INSPECTION_UNAVAILABLE',
      observedAt: new Date().toISOString(),
    }),
  };
  const open = () => {
    const store = new SqliteStore(dir, inspector);
    cleanups.push(() => store.close());
    return store;
  };
  const store = open();
  const db = new DatabaseSync(join(dir, 'linkedout.sqlite'));
  cleanups.push(() => db.close());
  const reserve = () =>
    store.reserveDraft(
      'local',
      'hash',
      { private: 'synthetic evidence' },
      'key',
      context,
    ).runId;
  return {
    dir,
    store,
    db,
    open,
    inspector,
    reserve,
    abandon: () => {
      state = 'abandoned';
    },
  };
}
function draft(runId: string): Draft {
  return {
    id: randomUUID(),
    userId: 'local',
    runId,
    createdAt: new Date().toISOString(),
    status: 'draft',
    body: 'Synthetic body.',
    claims: [],
    warnings: [],
    promptVersion: 'fixture',
    provenance: {
      origin: 'user_provided',
      profile: userProfileSchema.parse({}),
      input: { brief: 'Synthetic' },
    },
    generation: { provider: 'fixture', model: 'fixture' },
  };
}
function artifact(runId: string): ReviewArtifact {
  const d = draft(runId);
  return {
    ...d,
    status: 'blocked',
    revision: 1,
    parentRevisionId: null,
    publishable: false,
    reviewRequired: true,
    bodyHash: 'synthetic',
    knowledgeHash: 'synthetic',
    failureCode: 'INVALID_OUTPUT',
  };
}
function research(runId: string): ResearchResult {
  return {
    runId,
    createdAt: new Date().toISOString(),
    lookbackDays: 14,
    coverage: 'complete',
    outcomes: [],
    ideas: [],
    requests: 0,
    modelCalls: 0,
    knowledge: EMPTY_KNOWLEDGE,
    evidenceSnapshot: [],
  };
}

describe('execution ownership and reconciliation', () => {
  it('keeps active reservations blocked, reconciles death once, and retains the key and private snapshot', () => {
    const f = fixture(),
      runId = f.reserve(),
      other = f.open();
    expect(other.inspectRecovery('local', runId)).toMatchObject({
      eligible: false,
      observation: { state: 'active' },
    });
    expect(() => other.reconcileRun('local', runId)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_UNSAFE' }),
    );
    expect(() => other.reconcileRun('other', runId)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    f.abandon();
    const first = other.reconcileRun('local', runId);
    expect(first).toMatchObject({
      changed: true,
      status: 'interrupted',
      event: { reason: 'PROCESS_ABSENT' },
    });
    expect(f.store.reconcileRun('local', runId)).toEqual({
      ...first,
      changed: false,
    });
    expect(
      f.db.prepare('SELECT count(*) n FROM run_reconciliations').get()?.n,
    ).toBe(1);
    expect(
      f.db.prepare('SELECT request_json FROM tool_executions').get()
        ?.request_json,
    ).toContain('synthetic evidence');
    expect(() => f.reserve()).toThrow(
      expect.objectContaining({ code: 'PREVIOUS_FAILURE' }),
    );
    expect(() =>
      f.store.reserveDraft('local', 'different', {}, 'key', context),
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(f.open().getRun('local', runId).status).toBe('interrupted');
    expect(() =>
      f.db.prepare('UPDATE runs SET owner_json = NULL WHERE id = ?').run(runId),
    ).toThrow();
    expect(() => f.db.exec('DELETE FROM run_reconciliations')).toThrow();
  });

  it('refuses another instance and wrong user before any payload write', () => {
    const f = fixture(),
      runId = f.reserve(),
      other = f.open();
    for (const operation of [
      () => other.completeDraft(draft(runId)),
      () => other.failWithArtifact(artifact(runId)),
      () => other.failRun(runId, 'CANCELLED'),
      () => other.recordPlan(runId, { private: 'no' }),
      () => f.store.completeDraft({ ...draft(runId), userId: 'other' }),
      () =>
        other.reserveDraft('local', 'child', {}, undefined, {
          ...context,
          parentRunId: runId,
        }),
    ])
      expect(operation).toThrow(
        expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
      );
    expect(f.store.listDrafts('local').total).toBe(0);
    expect(f.store.listReviewArtifacts('local').total).toBe(0);
    expect(f.store.listRuns('local')).toHaveLength(1);
    expect(f.store.getRun('local', runId)).toMatchObject({
      status: 'running',
      planning: null,
    });
  });

  it('rejects all late writes after interruption, including scoped cache and pruning', () => {
    const f = fixture();
    const runId = f.store.reserveResearch(
      'local',
      'research',
      {},
      'research-key',
      context,
    ).runId;
    const cache = f.store.researchCacheFor('local', runId);
    f.abandon();
    f.open().reconcileRun('local', runId);
    for (const operation of [
      () => f.store.completeResearch('local', research(runId)),
      () => f.store.saveResearchItems('local', [], runId),
      () => f.store.recordPlan(runId, { private: 'no' }),
      () => f.store.failRun(runId, 'CANCELLED'),
      () => cache.setResearchCache('synthetic', { evidence: 'no' }),
      () => f.store.pruneResearch('local', new Date().toISOString(), runId),
    ])
      expect(operation).toThrow(
        expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
      );
    expect(f.store.getResearchCache('synthetic')).toBeUndefined();
    expect(
      f.db.prepare('SELECT count(*) n FROM research_results').get()?.n,
    ).toBe(0);
    expect(() =>
      f.store.reserveResearch('local', 'research', {}, 'research-key', context),
    ).toThrow(expect.objectContaining({ code: 'PREVIOUS_FAILURE' }));
    f.store.deleteResearchRun('local', runId);
    expect(f.store.getRun('local', runId).status).toBe('interrupted');
  });

  it.each(['draft', 'artifact', 'research'] as const)(
    'rolls back every %s payload if the final execution update affects no rows',
    (kind) => {
      const f = fixture();
      const runId =
        kind === 'research'
          ? f.store.reserveResearch('local', 'r', {}, undefined, context).runId
          : f.reserve();
      // Fault injection after payload insertion and the runs update: no final row is changed.
      f.db.exec(
        `CREATE TRIGGER suppress_execution_update BEFORE UPDATE OF status ON tool_executions BEGIN SELECT RAISE(IGNORE); END;`,
      );
      const operation =
        kind === 'draft'
          ? () => f.store.completeDraft(draft(runId))
          : kind === 'artifact'
            ? () => f.store.failWithArtifact(artifact(runId))
            : () => f.store.completeResearch('local', research(runId));
      expect(operation).toThrow(
        expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
      );
      for (const table of [
        'drafts',
        'review_artifacts',
        'research_results',
        'content_ideas',
      ])
        expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(
          0,
        );
      expect(f.store.getRun('local', runId)).toMatchObject({
        status: 'running',
        finishedAt: null,
      });
      expect(
        f.db
          .prepare('SELECT status FROM tool_executions WHERE run_id = ?')
          .get(runId)?.status,
      ).toBe('running');
    },
  );

  it('rolls back reconciliation if audit persistence fails and never splits terminal states', () => {
    const f = fixture(),
      runId = f.reserve();
    f.abandon();
    f.db.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON run_reconciliations BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    expect(() => f.open().reconcileRun('local', runId)).toThrow(
      expect.objectContaining({ code: 'STORAGE_ERROR' }),
    );
    expect(f.store.getRun('local', runId).status).toBe('running');
    expect(
      f.db.prepare('SELECT status FROM tool_executions').get()?.status,
    ).toBe('running');
    f.db.exec('DROP TRIGGER reject_audit');
    expect(f.open().reconcileRun('local', runId).changed).toBe(true);
  });

  it('does not change success after response loss, failure, or completed child when its parent is interrupted', () => {
    const f = fixture();
    const parent = f.store.reserveAgent(
      'local',
      'parent',
      {},
      'parent',
      context,
    ).runId;
    const child = f.store.reserveDraft('local', 'child', {}, 'child', {
      ...context,
      parentRunId: parent,
    }).runId;
    const saved = draft(child);
    f.store.completeDraft(saved);
    f.abandon();
    const other = f.open();
    expect(other.reconcileRun('local', child)).toMatchObject({
      changed: false,
      status: 'succeeded',
    });
    other.reconcileRun('local', parent);
    expect(() => f.store.completeAgent(parent, saved.id)).toThrow(
      expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
    );
    expect(() =>
      f.store.reserveDraft('local', 'later', {}, undefined, {
        ...context,
        parentRunId: parent,
      }),
    ).toThrow();
    expect(other.getDraft('local', saved.id)).toEqual(saved);
    expect(
      other.reserveDraft('local', 'child', {}, 'child', context).draft,
    ).toEqual(saved);
    const failed = f.reserve();
    f.store.failRun(failed, 'TIMEOUT');
    expect(other.reconcileRun('local', failed)).toMatchObject({
      changed: false,
      status: 'failed',
    });
  });

  it('migrates legacy reservations without assigning ownership or permitting reconciliation', () => {
    const f = fixture(),
      runId = f.reserve();
    f.db.exec(
      'DROP TRIGGER immutable_run_owner; DROP TABLE run_reconciliations; ALTER TABLE runs DROP COLUMN owner_json; PRAGMA user_version = 5;',
    );
    const migrated = f.open();
    f.abandon();
    expect(migrated.inspectRecovery('local', runId)).toMatchObject({
      eligible: false,
      observation: { state: 'unknown' },
    });
    expect(() => migrated.reconcileRun('local', runId)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_UNSAFE' }),
    );
    expect(() =>
      migrated.reserveDraft('local', 'hash', {}, 'key', context),
    ).toThrow(expect.objectContaining({ code: 'IN_PROGRESS' }));
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => f.store.recordPlan(runId, {})).toThrow();
  });

  it('rejects mismatched execution state and rolls back a failed migration', () => {
    const f = fixture(),
      runId = f.reserve();
    f.db
      .prepare("UPDATE tool_executions SET status = 'failed' WHERE run_id = ?")
      .run(runId);
    expect(() => f.store.completeDraft(draft(runId))).toThrow(
      expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
    );
    expect(f.store.listDrafts('local').total).toBe(0);
    f.abandon();
    expect(() => f.store.reconcileRun('local', runId)).toThrow(
      expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
    );
    f.db.exec(
      'DROP TRIGGER immutable_run_owner; DROP TABLE run_reconciliations; ALTER TABLE runs DROP COLUMN owner_json; PRAGMA user_version = 5; CREATE TABLE run_reconciliations (id TEXT);',
    );
    expect(() => new SqliteStore(f.dir)).toThrow(
      expect.objectContaining({ code: 'STORAGE_ERROR' }),
    );
    expect(f.db.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    expect(
      f.db
        .prepare('PRAGMA table_info(runs)')
        .all()
        .some((row) => row.name === 'owner_json'),
    ).toBe(false);
    f.db.exec('DROP TABLE run_reconciliations');
    expect(f.open().getRun('local', runId).status).toBe('running');
  });

  it('rejects late draft completion, artifact persistence, and failure after reconciliation', () => {
    const f = fixture(),
      runId = f.reserve();
    f.abandon();
    f.open().reconcileRun('local', runId);
    for (const operation of [
      () => f.store.completeDraft(draft(runId)),
      () => f.store.failWithArtifact(artifact(runId)),
      () => f.store.failRun(runId, 'CANCELLED'),
    ])
      expect(operation).toThrow(
        expect.objectContaining({ code: 'EXECUTION_STATE_CONFLICT' }),
      );
    expect(f.store.listDrafts('local').total).toBe(0);
    expect(f.store.listReviewArtifacts('local').total).toBe(0);
    expect(f.store.getRun('local', runId)).toMatchObject({
      status: 'interrupted',
      errorCode: 'INTERRUPTED',
    });
  });

  it('checks CLI maintenance permission independently of actor and never registers recovery tools', async () => {
    const f = fixture(),
      runId = f.reserve();
    f.abandon();
    const logs: unknown[] = [];
    const service = new RecoveryService(f.store, 'local', {
      log: (event) => {
        logs.push(event);
      },
    });
    for (const denied of [
      { ...context, actor: 'mcp' as const },
      { ...context, permissions: new Set(['read_local'] as const) },
    ])
      expect(() => service.reconcile({ id: runId }, denied)).toThrow(
        expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      );
    expect(service.reconcile({ id: runId }, context).notice).toContain(
      'billing are unknown',
    );
    service.reconcile({ id: runId }, context);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('synthetic evidence');
    const app = createApplication({
      dataDir: f.dir,
      knowledgeDir: join(f.dir, 'knowledge'),
      profile: userProfileSchema.parse({}),
      runTimeoutMs: 1000,
    });
    cleanups.push(() => app.close());
    expect(
      app.tools
        .all()
        .some(
          (tool) =>
            tool.permission === 'recover_local' ||
            /reconcil|recovery/.test(tool.name),
        ),
    ).toBe(false);
    expect(
      await runCli(['runs', 'inspect-recovery', runId], app),
    ).toMatchObject({ status: 'interrupted' });
    expect(await runCli(['runs', 'reconcile', runId], app)).toMatchObject({
      changed: false,
    });
    await expect(
      runCli(['runs', 'reconcile', runId, '--force'], app),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

function fakeProc() {
  const boot = randomUUID();
  const stat = (pid: number, start: string) =>
    `${pid} (strange ) name) S ${Array(18).fill('0').join(' ')} ${start} 0`;
  const files = new Map([
    ['/proc/sys/kernel/random/boot_id', boot],
    ['/proc/self/mountinfo', '12 1 0:1 / /proc rw - proc proc rw'],
    ['/proc/self/stat', stat(42, '100')],
    ['/proc/42/stat', stat(42, '100')],
    ['/proc/self/status', 'Uid:\t1000\t1000\t1000\t1000\n'],
  ]);
  const os = {
    platform: 'linux',
    pid: 42,
    read(path: string) {
      const value = files.get(path);
      if (value === undefined)
        throw Object.assign(new Error(), { code: 'ENOENT' });
      return value;
    },
    link: (path: string) => `${path.split('/').at(-1)}:[123]`,
  };
  const inspector = new LinuxProcessInspector(os);
  const owner = { ...inspector.capture(), pid: 99 };
  return { files, os, inspector, owner, stat };
}
describe('Linux process identity', () => {
  it('distinguishes matching identity, death and PID reuse without timestamps or signals', () => {
    const f = fakeProc();
    expect(f.owner.identity).not.toBeNull();
    expect(f.inspector.inspect(f.owner)).toMatchObject({
      state: 'abandoned',
      reason: 'PROCESS_ABSENT',
    });
    f.files.set('/proc/99/stat', f.stat(99, '100'));
    expect(f.inspector.inspect(f.owner).state).toBe('active');
    f.files.set('/proc/99/stat', f.stat(99, '101'));
    expect(f.inspector.inspect(f.owner)).toMatchObject({
      state: 'abandoned',
      reason: 'PID_REUSED',
    });
  });
  it.each([
    'permission',
    'malformed',
    'boot',
    'namespace',
    'hidepid',
    'mount',
    'pid-scope',
    'platform',
    'missing',
  ])('fails closed for %s limitations', (kind) => {
    const f = fakeProc();
    if (kind === 'permission') {
      const read = f.os.read;
      f.os.read = (path) => {
        if (path === '/proc/99/stat')
          throw Object.assign(new Error(), { code: 'EACCES' });
        return read(path);
      };
    }
    if (kind === 'malformed') f.files.set('/proc/99/stat', 'bad');
    if (kind === 'boot')
      f.files.set('/proc/sys/kernel/random/boot_id', randomUUID());
    if (kind === 'namespace')
      f.os.link = (path) => `${path.split('/').at(-1)}:[999]`;
    if (kind === 'hidepid')
      f.files.set(
        '/proc/self/mountinfo',
        '12 1 0:1 / /proc rw - proc proc rw,hidepid=2',
      );
    if (kind === 'mount')
      f.files.set(
        '/proc/self/mountinfo',
        '12 1 0:1 / /proc rw - proc proc rw\n13 12 0:2 / /proc/99/stat rw - tmpfs tmpfs rw',
      );
    if (kind === 'pid-scope') f.files.set('/proc/self/stat', f.stat(43, '100'));
    if (kind === 'platform') f.os.platform = 'darwin';
    if (kind === 'missing') f.owner.identity = null;
    expect(f.inspector.inspect(f.owner).state).toBe('unknown');
  });
  it('fails closed when visibility changes during observation', () => {
    const f = fakeProc(),
      read = f.os.read;
    f.os.read = (path) => {
      if (path === '/proc/99/stat') {
        f.files.set(
          '/proc/self/mountinfo',
          '12 1 0:1 / /proc rw - proc proc rw,hidepid=2',
        );
      }
      return read(path);
    };
    expect(f.inspector.inspect(f.owner).state).toBe('unknown');
  });
});
