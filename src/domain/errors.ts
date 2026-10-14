export type ErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIGURATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IN_PROGRESS'
  | 'PREVIOUS_FAILURE'
  | 'PERMISSION_DENIED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_REFUSAL'
  | 'INVALID_OUTPUT'
  | 'WORKFLOW_LIMIT'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'STORAGE_ERROR'
  | 'PROTOCOL_ERROR'
  | 'UNGROUNDED_OUTPUT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Raw errors may contain request bodies, credentials, or local paths.
  return new AppError(
    'INTERNAL_ERROR',
    'The operation failed. Inspect the local run history.',
  );
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError(
      signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
        ? 'TIMEOUT'
        : 'CANCELLED',
      'The operation was cancelled or exceeded its deadline.',
    );
  }
}
