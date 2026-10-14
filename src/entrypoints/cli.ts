import { parseArgs } from 'node:util';
import { createApplication } from './app.js';
import type { Application } from './app.js';
import type { ExecutionContext } from '../domain/contracts.js';
import {
  getDraftSchema,
  listDraftsSchema,
  parseInput,
} from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';
import { isMain, reportFailure } from './main.js';

export async function runCli(
  args: string[],
  app: Application,
  signal?: AbortSignal,
): Promise<unknown> {
  const [group, action, ...rest] = args;
  const context: ExecutionContext = {
    actor: 'cli',
    permissions: new Set(['read_local', 'draft_local']),
    ...(signal ? { signal } : {}),
  };
  if (group === 'knowledge' && action === 'index') {
    if (rest.length) throw usage();
    return app.knowledge.index(signal);
  }
  if (group === 'knowledge' && action === 'search') {
    const { values, positionals } = readArgs(rest, {
      query: { type: 'string' },
    });
    if (
      positionals.length ||
      !values['query']?.trim() ||
      values['query'].length > 8000
    )
      throw usage();
    return app.knowledge.retrieve(values['query'], signal);
  }
  if (
    (group === 'drafts' && action === 'create') ||
    (group === 'agent' && action === 'run')
  ) {
    const { values, positionals } = readArgs(rest, {
      brief: { type: 'string' },
      'idempotency-key': { type: 'string' },
      audience: { type: 'string' },
      tone: { type: 'string' },
      language: { type: 'string' },
    });
    if (positionals.length) throw usage();
    const input = {
      brief: values['brief'],
      ...(values['idempotency-key'] !== undefined
        ? { idempotencyKey: values['idempotency-key'] }
        : {}),
      ...(values['audience'] !== undefined
        ? { audience: values['audience'] }
        : {}),
      ...(values['tone'] !== undefined ? { tone: values['tone'] } : {}),
      ...(values['language'] !== undefined
        ? { language: values['language'] }
        : {}),
    };
    return group === 'agent'
      ? app.agent.run(input, { ...context, actor: 'agent' })
      : app.tools.invoke('draft_post', input, context);
  }
  if ((group === 'drafts' || group === 'runs') && action === 'list') {
    const { values, positionals } = readArgs(rest, {
      limit: { type: 'string' },
      offset: { type: 'string' },
    });
    if (positionals.length) throw usage();
    const input = parseInput(listDraftsSchema, {
      ...(values['limit'] !== undefined
        ? { limit: integerFlag(values['limit']) }
        : {}),
      ...(values['offset'] !== undefined
        ? { offset: integerFlag(values['offset']) }
        : {}),
    });
    return group === 'drafts'
      ? app.tools.invoke('list_drafts', input, context)
      : {
          runs: app.store.listRuns(
            app.config.profile.id,
            input.limit,
            input.offset,
          ),
        };
  }
  if ((group === 'drafts' || group === 'runs') && action === 'get') {
    if (rest.length !== 1) throw usage();
    const { id } = parseInput(getDraftSchema, { id: rest[0] });
    return group === 'drafts'
      ? app.tools.invoke('get_draft', { id }, context)
      : { run: app.store.getRun(app.config.profile.id, id) };
  }
  throw usage();
}
function readArgs(args: string[], options: Record<string, { type: 'string' }>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch {
    throw usage();
  }
}
function integerFlag(value: string): number {
  if (!/^\d+$/.test(value))
    throw new AppError(
      'INVALID_INPUT',
      'Pagination flags must be nonnegative integers.',
    );
  return Number(value);
}
function usage(): AppError {
  return new AppError(
    'INVALID_INPUT',
    'Usage: agent run --brief TEXT; drafts create --brief TEXT; drafts|runs list [--limit N --offset N]; drafts|runs get UUID; knowledge index; knowledge search --query TEXT.',
  );
}

if (isMain(import.meta.url)) {
  let app: Application | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    app = createApplication();
    const result = await runCli(process.argv.slice(2), app, controller.signal);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    reportFailure(error);
  } finally {
    app?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
