import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { userProfileSchema } from '../domain/contracts.js';
import type { UserProfile } from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';

const environmentSchema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).max(200).optional(),
  LINKEDOUT_DATA_DIR: z.string().trim().min(1).default('.linkedout'),
  LINKEDOUT_PROFILE_PATH: z.string().trim().min(1).optional(),
  LINKEDOUT_KNOWLEDGE_DIR: z.string().trim().min(1).default('knowledge'),
  LINKEDOUT_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(120_000),
});
export interface Config {
  apiKey?: string;
  model?: string;
  dataDir: string;
  profile: UserProfile;
  runTimeoutMs: number;
  knowledgeDir?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Config {
  const parsed = environmentSchema.safeParse({
    ...env,
    OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || undefined,
    OPENAI_MODEL: env.OPENAI_MODEL?.trim() || undefined,
  });
  if (!parsed.success)
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Invalid environment configuration. Check .env.example.',
    );
  const values = parsed.data;
  const knowledgeDir = resolve(cwd, values.LINKEDOUT_KNOWLEDGE_DIR);
  if (basename(knowledgeDir) !== 'knowledge')
    throw new AppError(
      'CONFIGURATION_ERROR',
      'The private knowledge directory must be named knowledge so ignore rules protect its contents.',
    );
  let profile: UserProfile;
  try {
    const file = values.LINKEDOUT_PROFILE_PATH;
    if (file && readFileSync(resolve(cwd, file)).byteLength > 65_536) {
      throw new Error('Profile exceeds size limit');
    }
    profile = userProfileSchema.parse(
      file ? JSON.parse(readFileSync(resolve(cwd, file), 'utf8')) : {},
    );
  } catch {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Cannot load user preferences. Supply a valid profile JSON file.',
    );
  }
  return {
    ...(values.OPENAI_API_KEY ? { apiKey: values.OPENAI_API_KEY } : {}),
    ...(values.OPENAI_MODEL ? { model: values.OPENAI_MODEL } : {}),
    dataDir: resolve(cwd, values.LINKEDOUT_DATA_DIR),
    knowledgeDir,
    profile,
    runTimeoutMs: values.LINKEDOUT_RUN_TIMEOUT_MS,
  };
}
