import { z } from 'zod';

// Only enum values and positions may cross the diagnostic persistence boundary.
export const researchDiagnosticSchema = z.object({
  scope: z.literal('research'),
  stage: z.enum([
    'output_schema',
    'candidate_count',
    'public_evidence',
    'private_evidence',
  ]),
  reason: z.enum([
    'INVALID_SCHEMA',
    'COUNT_MISMATCH',
    'EXCERPT_TOO_SHORT',
    'EXCERPT_TOO_LONG',
    'QUOTE_NOT_IN_SOURCE',
    'SELECTION_OUT_OF_RANGE',
    'SOURCE_NOT_RELEVANT',
  ]),
  index: z.number().int().min(0).max(4).nullable(),
});
export type ResearchDiagnostic = z.infer<typeof researchDiagnosticSchema>;

export const groundingDiagnosticSchema = z.discriminatedUnion('scope', [
  researchDiagnosticSchema,
  z.object({
    scope: z.literal('claim'),
    reason: z.enum([
      'UNKNOWN_SOURCE',
      'CLAIM_TOO_SHORT',
      'QUOTE_TOO_SHORT',
      'QUOTE_MISMATCH',
      'QUOTE_NOT_IN_SOURCE',
      'CLAIM_NOT_IN_BODY',
    ]),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    scope: z.literal('sentence'),
    reason: z.enum([
      'UNSUPPORTED_PERSONAL_ACTION',
      'UNSUPPORTED_PERSONAL_ROLE',
      'UNSUPPORTED_PROJECT_ACTION',
      'UNSUPPORTED_METRIC',
    ]),
    index: z.number().int().nonnegative(),
  }),
]);
export type GroundingDiagnostic = z.infer<typeof groundingDiagnosticSchema>;

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
    public readonly groundingDiagnostic?: GroundingDiagnostic,
    public readonly reviewArtifactId?: string,
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

export function researchFailure(
  stage: ResearchDiagnostic['stage'],
  reason: ResearchDiagnostic['reason'],
  index: number | null,
): AppError {
  return new AppError(
    stage === 'output_schema' || stage === 'candidate_count'
      ? 'INVALID_OUTPUT'
      : 'UNGROUNDED_OUTPUT',
    'Research validation failed. Inspect the structured diagnostic.',
    { scope: 'research', stage, reason, index },
  );
}

// Transport output is independently allowlisted; never forward raw error properties.
export function researchErrorDetails(error: AppError): {
  groundingDiagnostic?: ResearchDiagnostic;
} {
  const parsed = researchDiagnosticSchema.safeParse(error.groundingDiagnostic);
  return parsed.success ? { groundingDiagnostic: parsed.data } : {};
}
