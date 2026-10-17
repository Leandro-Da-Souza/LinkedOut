import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('persists research through actual CLI processes and replays with no configured provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkedout-research-cli-'));
  writeFileSync(join(dir, 'profile.json'), '{}');
  const invoke = (args: string[], fixture = false) => {
    const stdoutPath = join(dir, 'stdout'),
      stderrPath = join(dir, 'stderr');
    const stdout = openSync(stdoutPath, 'w'),
      stderr = openSync(stderrPath, 'w');
    try {
      const child = spawnSync(
        process.execPath,
        [
          resolve(
            fixture
              ? 'tests/fixtures/research-cli.mjs'
              : 'dist/entrypoints/cli.js',
          ),
          ...args,
        ],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
            OPENAI_MODEL: '',
            LINKEDOUT_PROFILE_PATH: join(dir, 'profile.json'),
            LINKEDOUT_DATA_DIR: dir,
            LINKEDOUT_KNOWLEDGE_DIR: join(dir, 'knowledge'),
            LINKEDOUT_RESEARCH_LOOKBACK_DAYS: '14',
          },
          stdio: ['ignore', stdout, stderr],
          timeout: 10_000,
        },
      );
      if (child.error) throw child.error;
      expect(child.status, readFileSync(stderrPath, 'utf8')).toBe(0);
      return JSON.parse(readFileSync(stdoutPath, 'utf8'));
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  };
  try {
    const run = invoke(
      [
        'research',
        'run',
        '--lookback-days',
        '30',
        '--idempotency-key',
        'process',
      ],
      true,
    );
    expect(run.execution).toBe('new_research');
    expect(run.result.ideas).toHaveLength(5);
    const replay = invoke([
      'research',
      'run',
      '--lookback-days',
      '30',
      '--idempotency-key',
      'process',
    ]);
    expect(replay.execution).toBe('historical_replay');
    expect(replay.result).toEqual(run.result);
    const id = run.result.ideas[0].id;
    expect(
      invoke(['ideas', 'review', id, '--status', 'rejected']).idea.status,
    ).toBe('rejected');
    expect(invoke(['ideas', 'list', '--status', 'rejected']).ideas[0].id).toBe(
      id,
    );
    expect(invoke(['runs', 'get', run.result.runId]).run.kind).toBe('research');
    expect(invoke(['research', 'sources']).sources).toHaveLength(6);
    invoke(['ideas', 'review', id, '--status', 'accepted']);
    const draft = invoke(
      ['ideas', 'draft', id, '--idempotency-key', 'draft-process'],
      true,
    );
    expect(draft.draft.publicCitations[0].kind).toBe('research_attachment');
    expect(draft.draft.review.required).toBe(true);
    expect(
      invoke(
        ['ideas', 'draft', id, '--idempotency-key', 'draft-process'],
        true,
      ),
    ).toMatchObject({ replayed: true, draft: { id: draft.draft.id } });
    expect(invoke(['drafts', 'get', draft.draft.id]).draft).toEqual(
      draft.draft,
    );
    expect(
      invoke(['runs', 'get', draft.draft.runId]).run.researchOrigin.ideaId,
    ).toBe(id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
