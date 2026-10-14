import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/infrastructure/config.js';
import { createLogger } from '../src/infrastructure/logger.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'linkedout-config-'));
  directories.push(directory);
  return directory;
}

describe('configuration and lightweight user preferences', () => {
  it('supports keyless local read operations with defaults without creating storage', () => {
    const cwd = tempDirectory();
    const config = loadConfig({}, cwd);
    expect(config).toMatchObject({
      dataDir: join(cwd, '.linkedout'),
      runTimeoutMs: 120_000,
      profile: {
        id: 'local',
        interests: [],
        writingSamples: [],
        language: 'English',
      },
    });
    expect(config).not.toHaveProperty('apiKey');
    expect(config).not.toHaveProperty('model');
    expect(existsSync(config.dataDir)).toBe(false);
  });

  it('normalizes optional blank credentials and trims explicit environment values', () => {
    expect(
      loadConfig({ OPENAI_API_KEY: '  ', OPENAI_MODEL: '' }),
    ).not.toHaveProperty('apiKey');
    expect(
      loadConfig({ OPENAI_API_KEY: '  ', OPENAI_MODEL: '' }),
    ).not.toHaveProperty('model');
    const config = loadConfig({
      OPENAI_API_KEY: ' secret-fixture ',
      OPENAI_MODEL: ' fixture-model ',
      LINKEDOUT_RUN_TIMEOUT_MS: '2000',
    });
    expect(config).toMatchObject({
      apiKey: 'secret-fixture',
      model: 'fixture-model',
      runTimeoutMs: 2000,
    });
  });

  it('loads relative preference paths with schema defaults and normalized identity', () => {
    const cwd = tempDirectory();
    writeFileSync(
      join(cwd, 'profile.json'),
      JSON.stringify({
        id: ' alice ',
        name: ' Alice ',
        interests: [' TypeScript '],
        writingSamples: [' My sample. '],
      }),
    );
    const config = loadConfig(
      {
        LINKEDOUT_PROFILE_PATH: 'profile.json',
        LINKEDOUT_DATA_DIR: 'private-data',
      },
      cwd,
    );
    expect(config.profile).toMatchObject({
      id: 'alice',
      name: 'Alice',
      interests: ['TypeScript'],
      writingSamples: ['My sample.'],
      audience: 'Professional peers',
    });
    expect(config.dataDir).toBe(join(cwd, 'private-data'));
    expect(existsSync(config.dataDir)).toBe(false);
  });

  it.each([
    { LINKEDOUT_RUN_TIMEOUT_MS: '999' },
    { LINKEDOUT_RUN_TIMEOUT_MS: '300001' },
    { LINKEDOUT_RUN_TIMEOUT_MS: 'NaN' },
    { LINKEDOUT_DATA_DIR: '  ' },
    { OPENAI_MODEL: 'x'.repeat(201) },
  ])(
    'rejects invalid environment without exposing values: %j',
    (environment) => {
      expect(() =>
        loadConfig({ ...environment, OPENAI_API_KEY: 'sk-sensitive-fixture' }),
      ).toThrowError('Invalid environment configuration. Check .env.example.');
    },
  );

  it.each([
    '{"malformed":',
    JSON.stringify({ id: '../unsafe' }),
    JSON.stringify({ interests: Array(21).fill('TypeScript') }),
    JSON.stringify({ writingSamples: ['x'.repeat(4001)] }),
    JSON.stringify({ unknownPermission: 'publish' }),
    JSON.stringify({ name: 'x'.repeat(70_000) }),
  ])(
    'rejects invalid or oversized profile files without exposing content',
    (contents) => {
      const cwd = tempDirectory();
      writeFileSync(join(cwd, 'profile.json'), contents);
      expect(() =>
        loadConfig({ LINKEDOUT_PROFILE_PATH: 'profile.json' }, cwd),
      ).toThrowError(
        'Cannot load user preferences. Supply a valid profile JSON file.',
      );
    },
  );

  it('sanitizes missing-file errors without exposing personal filesystem paths', () => {
    const cwd = tempDirectory();
    expect(() =>
      loadConfig(
        { LINKEDOUT_PROFILE_PATH: 'private-personal-preferences.json' },
        cwd,
      ),
    ).toThrowError(
      'Cannot load user preferences. Supply a valid profile JSON file.',
    );
    expect(existsSync(join(cwd, '.linkedout'))).toBe(false);
  });
});

describe('structured stderr logger', () => {
  it('serializes only safe fields even if a caller supplies extra runtime properties', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const payload = {
      event: 'run_failed' as const,
      runId: 'fixture-run',
      actor: 'test',
      tool: 'draft_post',
      code: 'PROVIDER_ERROR' as const,
      apiKey: 'sk-private-fixture',
      prompt: 'private writing sample',
      body: 'private draft',
      error: new Error('raw sensitive error'),
    };
    logger.log(payload);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'run_failed',
      runId: 'fixture-run',
      actor: 'test',
      tool: 'draft_post',
      code: 'PROVIDER_ERROR',
    });
    expect(lines[0]).not.toMatch(
      /sk-private-fixture|private writing sample|private draft|sensitive error/,
    );
  });
});
