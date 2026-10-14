import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftResult } from '../src/domain/contracts.js';

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-cli-'));
  roots.push(dir);
  const profile = join(dir, 'user.json');
  writeFileSync(
    profile,
    JSON.stringify({
      name: 'Ada',
      interests: ['TypeScript'],
      tone: 'Warm',
      language: 'Swedish',
    }),
  );
  return {
    LINKEDOUT_DATA_DIR: dir,
    LINKEDOUT_KNOWLEDGE_DIR: join(dir, 'knowledge'),
    LINKEDOUT_PROFILE_PATH: profile,
    OPENAI_API_KEY: '',
    OPENAI_MODEL: '',
  };
}

function cli(env: Record<string, string>, args: string[], production = false) {
  const stdoutPath = join(env.LINKEDOUT_DATA_DIR!, 'test.stdout');
  const stderrPath = join(env.LINKEDOUT_DATA_DIR!, 'test.stderr');
  const stdout = openSync(stdoutPath, 'w'),
    stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(
          production ? 'dist/entrypoints/cli.js' : 'tests/fixtures/cli.mjs',
        ),
        ...args,
      ],
      {
        env: { ...process.env, ...env },
        // Regular files work where this sandbox denies child stdio pipes.
        stdio: ['ignore', stdout, stderr],
        timeout: 10_000,
      },
    );
    if (result.error) throw result.error;
    return {
      ...result,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

describe('CLI and agent subprocesses', () => {
  it('exposes safe grounding diagnostics through list and get in new processes', () => {
    const env = workspace();
    // The injected fixture echoes the brief into its synthetic output.
    const failed = cli(env, [
      'drafts',
      'create',
      '--brief',
      'I built PRIVATE_PROJECT.',
    ]);
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain('UNGROUNDED_OUTPUT');
    expect(failed.stderr).not.toContain('PRIVATE_PROJECT');
    const listed = cli(env, ['runs', 'list'], true);
    expect(listed.status, listed.stderr).toBe(0);
    const run = JSON.parse(listed.stdout).runs[0];
    const diagnostic = {
      scope: 'sentence',
      reason: 'UNSUPPORTED_PERSONAL_ACTION',
      index: 0,
    };
    expect(run.groundingDiagnostic).toEqual(diagnostic);
    const read = cli(env, ['runs', 'get', run.id], true);
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).run.groundingDiagnostic).toEqual(diagnostic);
    expect(listed.stdout + read.stdout).not.toContain('PRIVATE_PROJECT');
    const artifacts = cli(env, ['artifacts', 'list'], true);
    const summary = JSON.parse(artifacts.stdout);
    expect(summary).toMatchObject({
      total: 1,
      artifacts: [{ id: run.reviewArtifactId, publishable: false }],
    });
    expect(artifacts.stdout).not.toContain('PRIVATE_PROJECT');
    const artifact = cli(env, ['artifacts', 'get', run.reviewArtifactId], true);
    expect(JSON.parse(artifact.stdout)).toMatchObject({
      artifact: {
        publishable: false,
        body: expect.stringContaining('PRIVATE_PROJECT'),
      },
    });
    expect(
      cli(env, ['artifacts', 'delete', run.reviewArtifactId], true).status,
    ).toBe(0);
    expect(
      JSON.parse(cli(env, ['runs', 'get', run.id], true).stdout).run
        .reviewArtifactId,
    ).toBeNull();
  });

  it('indexes and searches private knowledge without credentials and passes evidence into the agent', () => {
    const env = workspace();
    mkdirSync(env.LINKEDOUT_KNOWLEDGE_DIR!);
    writeFileSync(
      join(env.LINKEDOUT_KNOWLEDGE_DIR!, 'cv.md'),
      'PRIVATE_CV_EVIDENCE: TypeScript reporting application.',
    );
    const indexed = cli(env, ['knowledge', 'index'], true);
    expect(indexed.status, indexed.stderr).toBe(0);
    expect(JSON.parse(indexed.stdout)).toMatchObject({
      documents: 1,
      chunks: 1,
      issues: [],
    });
    const searched = cli(
      env,
      ['knowledge', 'search', '--query', 'TypeScript'],
      true,
    );
    expect(searched.status, searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout).sources[0].excerpt).toContain(
      'PRIVATE_CV_EVIDENCE',
    );
    const drafted = cli(env, [
      'agent',
      'run',
      '--brief',
      'Reflect on TypeScript reliability',
    ]);
    expect(drafted.status, drafted.stderr).toBe(0);
    const result = JSON.parse(drafted.stdout) as DraftResult;
    expect(result.draft.provenance.knowledge?.sources[0]?.path).toBe('cv.md');
    expect(result.draft.review?.required).toBe(true);
    expect(drafted.stderr).not.toContain('PRIVATE_CV_EVIDENCE');
    for (const args of [
      ['knowledge', 'search'],
      ['knowledge', 'search', '--query', ' '],
      ['knowledge', 'index', 'unexpected'],
    ]) {
      expect(cli(env, args, true).status).toBe(1);
    }
  });

  it('runs the bounded agent using two SDK calls, persists preferences and replays without another call', () => {
    const env = workspace();
    const args = [
      'agent',
      'run',
      '--brief',
      'PRIVATE_BRIEF about testing',
      '--tone',
      'Direct',
      '--idempotency-key',
      'agent-replay',
    ];
    const first = cli(env, args);
    expect(first.status, first.stderr).toBe(0);
    const saved = JSON.parse(first.stdout) as DraftResult & {
      workflowRunId: string;
    };
    expect(saved.draft.status).toBe('draft');
    expect(saved.draft.body).toContain('Ada');
    expect(saved.draft.body).toContain('Direct; Swedish');
    expect(saved.draft.provenance.profile.name).toBe('Ada');
    expect(saved.draft.provenance.input.brief).toBe(
      'PRIVATE_BRIEF about testing',
    );
    expect(first.stderr).toContain('"fixtureRequests":3');
    expect(first.stderr).not.toContain('PRIVATE_BRIEF');
    expect(first.stderr).not.toContain('fixture-key-secret');
    expect(first.stderr).not.toContain(saved.draft.body);
    const replay = cli(env, args);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      replayed: true,
      draft: { id: saved.draft.id },
      workflowRunId: saved.workflowRunId,
    });
    expect(replay.stderr).toContain('"fixtureRequests":0');
    const read = cli(env, ['drafts', 'get', saved.draft.id], true);
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({ draft: saved.draft });
    const runs = cli(env, ['runs', 'list'], true);
    expect(runs.status, runs.stderr).toBe(0);
    expect(JSON.parse(runs.stdout).runs).toHaveLength(2);
    const listing = cli(env, ['drafts', 'list', '--limit', '1'], true);
    expect(listing.status, listing.stderr).toBe(0);
    expect(JSON.parse(listing.stdout)).toMatchObject({ total: 1, limit: 1 });
  });

  it('direct drafting shares persistence and respects user preferences', () => {
    const env = workspace();
    const result = cli(env, [
      'drafts',
      'create',
      '--brief',
      'Direct content drafting',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const saved = JSON.parse(result.stdout) as DraftResult;
    expect(saved.draft.body).toContain('Warm; Swedish');
    expect(result.stderr).toContain('"fixtureRequests":2');
    const read = cli(env, ['drafts', 'get', saved.draft.id], true);
    expect(JSON.parse(read.stdout)).toMatchObject({ draft: saved.draft });
  });

  it('rejects changed keyed requests without another provider call', () => {
    const env = workspace();
    expect(
      cli(env, [
        'agent',
        'run',
        '--brief',
        'First',
        '--idempotency-key',
        'same',
      ]).status,
    ).toBe(0);
    const changed = cli(env, [
      'agent',
      'run',
      '--brief',
      'Different',
      '--idempotency-key',
      'same',
    ]);
    expect(changed.status).toBe(1);
    expect(changed.stdout).toBe('');
    expect(changed.stderr).toContain('IDEMPOTENCY_CONFLICT');
    expect(changed.stderr).toContain('"fixtureRequests":0');
  });

  it('reports model refusal without a stored draft or successful stdout', () => {
    const env = { ...workspace(), LINKEDOUT_TEST_RESPONSE: 'refusal' };
    const result = cli(env, ['agent', 'run', '--brief', 'Refused']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('PROVIDER_REFUSAL');
    expect(result.stderr).not.toContain('Private fixture refusal context');
    const listing = cli(env, ['drafts', 'list'], true);
    expect(JSON.parse(listing.stdout)).toMatchObject({ total: 0 });
  });

  it('validates CLI input and allows keyless reads while generation fails explicitly', () => {
    const env = workspace();
    for (const args of [
      ['drafts', 'create', '--brief', 'x', '--idempotency-key', ''],
      ['drafts', 'create', '--brief', 'x', '--tone', ''],
      ['drafts', 'list', '--limit', ''],
      ['drafts', 'list', '--offset', ''],
      ['agent', 'run'],
      ['drafts', 'list', '--limit', '0'],
      [
        'drafts',
        'create',
        '--brief',
        'x',
        '--provider-url',
        'PRIVATE_ARGUMENT',
      ],
    ]) {
      const result = cli(env, args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('INVALID_INPUT');
      expect(result.stderr).not.toContain('PRIVATE_ARGUMENT');
      expect(result.stderr).toContain('"fixtureRequests":0');
    }
    const read = cli(env, ['drafts', 'list'], true);
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ total: 0 });
    const generate = cli(
      env,
      ['drafts', 'create', '--brief', 'Needs credentials'],
      true,
    );
    expect(generate.status).toBe(1);
    expect(generate.stdout).toBe('');
    expect(generate.stderr).toContain('CONFIGURATION_ERROR');
  });
});
