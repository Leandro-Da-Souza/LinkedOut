import {
  ASSESSMENT_VERSION,
  GROUNDING_POLICY_VERSION,
  type AssessmentReport,
  type ReviewArtifact,
} from '../domain/assessment.js';
import type { GeneratedBody, ModelMetadata } from '../domain/contracts.js';
import { assessBody, bodyUnits, digest } from './assessment.js';
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
  generatedBodySchema,
  parseInput,
} from '../domain/contracts.js';
import { AppError, checkAbort, publicError } from '../domain/errors.js';
import type { Logger } from '../infrastructure/logger.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import { EMPTY_KNOWLEDGE } from '../domain/knowledge.js';
import type { KnowledgeReader } from '../domain/knowledge.js';
import { groundDraft } from './grounding.js';

export const PROMPT_VERSION = 'draft-v4-body-only';
export const PIPELINE_VERSION = `${PROMPT_VERSION}:${ASSESSMENT_VERSION}:${GROUNDING_POLICY_VERSION}`;
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
    const knowledge = structuredClone(
      context.knowledge ??
        (await this.knowledge?.retrieve(input.brief, signal)) ??
        EMPTY_KNOWLEDGE,
    );
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
          promptVersion: PIPELINE_VERSION,
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
    let candidate: GeneratedBody | undefined;
    let generation: ModelMetadata | undefined;
    let assessment: AssessmentReport | undefined;
    const knowledgeHash = digest(knowledge);
    const provenance = structuredClone({
      origin: 'user_provided' as const,
      profile: this.profile,
      input: request.input,
      knowledge,
    });
    try {
      const generated = await this.provider.generateDraft(
        structuredClone(request),
        signal,
      );
      const validated = generatedBodySchema.safeParse(generated.output);
      if (!validated.success) {
        const rawBody =
          generated.output &&
          typeof generated.output === 'object' &&
          'body' in generated.output
            ? generated.output.body
            : undefined;
        const retainedBody = generatedBodySchema.shape.body.safeParse(rawBody);
        if (retainedBody.success) {
          candidate = { body: retainedBody.data, warnings: [] };
          generation = generated.metadata;
        }
        throw new AppError(
          'INVALID_OUTPUT',
          'The provider returned an invalid draft. Nothing was stored as a draft.',
        );
      }
      candidate = validated.data;
      generation = generated.metadata;
      checkAbort(signal);
      const bodyHash = digest(candidate.body);
      const assessed = await this.provider.assessDraft(
        {
          units: bodyUnits(candidate.body),
          sources: knowledge.sources.map(({ id, excerpt }) => ({
            id,
            excerpt,
          })),
        },
        signal,
      );
      const result = assessBody(
        candidate,
        knowledge,
        this.profile,
        assessed.output,
      );
      assessment = { ...result.report, metadata: assessed.metadata };
      checkAbort(signal);
      if (
        bodyHash !== digest(candidate.body) ||
        knowledgeHash !== digest(knowledge)
      ) {
        assessment.blocked = true;
        assessment.issues.push('SNAPSHOT_CHANGED');
      }
      if (assessment.blocked)
        throw new AppError(
          'UNGROUNDED_OUTPUT',
          'The generated body requires factual review. Inspect its private review artifact.',
          assessment.heuristicDiagnostic,
        );
      const grounded = groundDraft(
        { ...candidate, claims: result.claims },
        knowledge,
        this.profile,
      );
      const draft = {
        ...grounded.output,
        review: grounded.review,
        id: randomUUID(),
        userId: this.profile.id,
        runId,
        createdAt: new Date().toISOString(),
        status: 'draft' as const,
        promptVersion: PROMPT_VERSION,
        provenance,
        assessment,
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
      let safe = signal.aborted
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
        if (candidate && generation) {
          const artifact: ReviewArtifact = {
            ...candidate,
            warnings: groundDraft(
              { body: '', warnings: candidate.warnings, claims: [] },
              knowledge,
              this.profile,
            ).output.warnings,
            id: randomUUID(),
            userId: this.profile.id,
            runId,
            createdAt: new Date().toISOString(),
            revision: 1,
            parentRevisionId: null,
            status: 'blocked',
            publishable: false,
            reviewRequired: true,
            bodyHash: digest(candidate.body),
            knowledgeHash,
            promptVersion: PROMPT_VERSION,
            provenance,
            generation,
            ...(assessment ? { assessment } : {}),
            failureCode: safe.code,
          };
          this.store.failWithArtifact(artifact, safe.groundingDiagnostic);
          safe = new AppError(
            safe.code,
            safe.message,
            safe.groundingDiagnostic,
            artifact.id,
          );
        } else this.store.failRun(runId, safe.code, safe.groundingDiagnostic);
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
