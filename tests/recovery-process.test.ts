import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { LinuxProcessInspector } from '../src/infrastructure/process-identity.js';
import { SqliteStore } from '../src/infrastructure/sqlite.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const fixture = resolve('tests/fixtures/recovery-process.mjs');
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-crash-'));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function open(dir: string) {
  const store = new SqliteStore(dir);
  cleanups.push(() => store.close());
  return store;
}
function read(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

it.for([
  'reserve',
  'generation',
  'assessment',
  'before-commit',
  'research-items',
  'agent-child',
  'completed',
  'research-completed',
])('handles a real SIGKILL at %s without repeating work', (mode, { skip }) => {
  if (process.platform !== 'linux') skip('SIGKILL fixture requires Linux');
  const dir = directory(),
    output = join(dir, 'result.json');
  const child = spawnSync(process.execPath, [fixture, dir, mode, output], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (child.error && 'code' in child.error && child.error.code === 'EPERM')
    skip('Sandbox explicitly prohibits subprocess creation (EPERM)');
  if (child.error) throw child.error;
  expect(child.signal).toBe('SIGKILL');
  const recorded = read(output).runs as {
    id: string;
    status: string;
    kind: string;
  }[];
  const store = open(dir);
  const supported = new LinuxProcessInspector().capture().identity !== null;
  for (const run of recorded) {
    if (run.status === 'succeeded') {
      expect(store.reconcileRun('local', run.id)).toMatchObject({
        status: 'succeeded',
        changed: false,
      });
    } else if (!supported) {
      // Still exercise actual crashes on restricted hosts; never call unknown death proven.
      expect(store.inspectRecovery('local', run.id)).toMatchObject({
        observation: { state: 'unknown' },
        eligible: false,
      });
      expect(() => store.reconcileRun('local', run.id)).toThrow(
        expect.objectContaining({ code: 'RECOVERY_UNSAFE' }),
      );
    } else {
      expect(store.inspectRecovery('local', run.id)).toMatchObject({
        observation: { state: 'abandoned' },
        eligible: true,
      });
      expect(store.reconcileRun('local', run.id)).toMatchObject({
        status: 'interrupted',
        changed: true,
      });
      expect(store.reconcileRun('local', run.id).changed).toBe(false);
      if (run.kind === 'research') store.deleteResearchRun('local', run.id);
    }
  }
});

it('refuses a stopped live process, then serializes two real reconcilers after death', async ({
  skip,
}) => {
  if (process.platform !== 'linux')
    skip('Process suspension test requires Linux');
  if (!new LinuxProcessInspector().capture().identity)
    skip(
      'Restricted/ambiguous proc visibility: verified-death test requires an ordinary Linux proc mount',
    );
  const dir = directory(),
    output = join(dir, 'active.json');
  const child = spawn(process.execPath, [fixture, dir, 'active', output], {
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    for (let i = 0; i < 200 && !existsSync(output); i++) await delay(10);
    expect(existsSync(output)).toBe(true);
    const runId = read(output).runs[0].id as string;
    child.kill('SIGSTOP');
    const store = open(dir);
    expect(store.inspectRecovery('local', runId)).toMatchObject({
      observation: { state: 'active' },
    });
    expect(() => store.reconcileRun('local', runId)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_UNSAFE' }),
    );
    child.kill('SIGKILL');
    await exited;
    const results = await Promise.all(
      [0, 1].map(async (index) => {
        const path = join(dir, `reconcile-${index}.json`);
        const worker = spawn(
          process.execPath,
          [fixture, dir, 'reconcile', path, runId],
          { stdio: 'ignore' },
        );
        const [code] = await once(worker, 'exit');
        expect(code).toBe(0);
        return read(path);
      }),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results[0].event).toEqual(results[1].event);
    expect(store.getRun('local', runId).status).toBe('interrupted');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});
