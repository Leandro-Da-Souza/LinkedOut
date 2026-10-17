import type { ExecutionContext } from '../domain/contracts.js';
import { getDraftSchema, parseInput } from '../domain/contracts.js';
import { AppError, checkAbort } from '../domain/errors.js';
import { LOCAL_INTERRUPTION_NOTICE } from '../domain/recovery.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import type { Logger } from '../infrastructure/logger.js';

export class RecoveryService {
  constructor(
    private readonly store: SqliteStore,
    private readonly userId: string,
    private readonly logger: Logger,
  ) {}
  inspect(raw: unknown, context: ExecutionContext) {
    checkAbort(context.signal);
    if (!context.permissions.has('read_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'Local read permission is required.',
      );
    const { id } = parseInput(getDraftSchema, raw);
    return {
      ...this.store.inspectRecovery(this.userId, id),
      notice: LOCAL_INTERRUPTION_NOTICE,
    };
  }
  reconcile(raw: unknown, context: ExecutionContext) {
    checkAbort(context.signal);
    if (context.actor !== 'cli' || !context.permissions.has('recover_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'CLI maintenance permission is required.',
      );
    const { id } = parseInput(getDraftSchema, raw);
    const result = this.store.reconcileRun(this.userId, id);
    if (result.changed)
      this.logger.log({
        event: 'run_interrupted',
        runId: id,
        actor: 'cli',
        code: 'INTERRUPTED',
      });
    return { ...result, notice: LOCAL_INTERRUPTION_NOTICE };
  }
}
