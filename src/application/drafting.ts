import { createHash, randomUUID } from 'node:crypto';
import type {
  DraftProvider,
  DraftResult,
  ExecutionContext,
  GenerationRequest,
  UserProfile,
} from '../domain/contracts.js';
import {
  draftInputSchema,
  generatedDraftSchema,
  parseInput,
} from '../domain/contracts.js';
import { AppError, checkAbort, publicError } from '../domain/errors.js';
import type { Logger } from '../infrastructure/logger.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import { EMPTY_KNOWLEDGE } from '../domain/knowledge.js';
import type { KnowledgeReader } from '../domain/knowledge.js';
import { groundDraft } from './grounding.js';

export const PROMPT_VERSION = 'draft-v2-knowledge';
export class DraftService {
  constructor(
    private readonly store: SqliteStore,
    private readonly provider: DraftProvider,
    private readonly profile: UserProfile,
    private readonly logger: Logger,
    private readonly timeoutMs: number = 120_000,
    private readonly knowledge?: KnowledgeReader,
  ) {}
  async create(raw: unknown, context: ExecutionContext): Promise<DraftResult> {
    if (!context.permissions.has('draft_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'Local drafting permission is required.',
      );
    checkAbort(context.signal);
    const input = parseInput(draftInputSchema, raw);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = context.signal
      ? AbortSignal.any([deadline, context.signal])
      : deadline;
    const knowledge =
      context.knowledge ??
      (await this.knowledge?.retrieve(input.brief, signal)) ??
      EMPTY_KNOWLEDGE;
    checkAbort(signal);
    const request: GenerationRequest = {
      input: {
        brief: input.brief,
        audience: input.audience ?? this.profile.audience,
        tone: input.tone ?? this.profile.tone,
        language: input.language ?? this.profile.language,
        writingSamples: input.writingSamples ?? this.profile.writingSamples,
      },
      profile: this.profile,
      knowledge,
    };
    // Fixed construction order makes normalized effective inputs deterministic.
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          request,
          provider: this.provider.provider,
          model: this.provider.model,
          promptVersion: PROMPT_VERSION,
        }),
      )
      .digest('hex');
    const reservation = this.store.reserveDraft(
      this.profile.id,
      hash,
      request,
      input.idempotencyKey,
      context,
    );
    if (reservation.draft) return { draft: reservation.draft, replayed: true };
    const runId = reservation.runId;
    this.logger.log({
      event: 'run_started',
      runId,
      actor: context.actor,
      tool: 'draft_post',
    });
    try {
      const generated = await this.provider.generateDraft(request, signal);
      checkAbort(signal);
      const validated = generatedDraftSchema.safeParse(generated.output);
      if (!validated.success)
        throw new AppError(
          'INVALID_OUTPUT',
          'The provider returned an invalid draft. Nothing was stored as a draft.',
        );
      const grounded = groundDraft(validated.data, knowledge, this.profile);
      const draft = {
        ...grounded.output,
        review: grounded.review,
        id: randomUUID(),
        userId: this.profile.id,
        runId,
        createdAt: new Date().toISOString(),
        status: 'draft' as const,
        promptVersion: PROMPT_VERSION,
        provenance: {
          origin: 'user_provided' as const,
          profile: this.profile,
          input: request.input,
          knowledge,
        },
        generation: generated.metadata,
      };
      this.store.completeDraft(draft);
      this.logger.log({
        event: 'run_succeeded',
        runId,
        actor: context.actor,
        tool: 'draft_post',
      });
      return { draft, replayed: false };
    } catch (error) {
      const safe = signal.aborted
        ? (() => {
            try {
              checkAbort(signal);
            } catch (abort) {
              return publicError(abort);
            }
            return publicError(error);
          })()
        : publicError(error);
      try {
        this.store.failRun(runId, safe.code);
      } catch {
        /* A broken store leaves a visible incomplete run, never a false success. */
      }
      this.logger.log({
        event: 'run_failed',
        runId,
        actor: context.actor,
        tool: 'draft_post',
        code: safe.code,
      });
      throw safe;
    }
  }
}
