import {
  ideaDraftInputSchema,
  RESEARCH_DRAFT_VERSION,
} from '../domain/research-draft.js';
import type { ResearchDraftContext } from '../domain/research-draft.js';
import {
  resolveResearchDraft,
  researchAttachment,
  assertDraftPolicy,
} from './research-drafting.js';
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

export const PROMPT_VERSION = 'draft-v5-separated-facts';
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
    return this.createPrepared(raw, context);
  }
  async createFromIdea(
    raw: unknown,
    context: ExecutionContext,
  ): Promise<DraftResult> {
    if (!context.permissions.has('draft_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'Local drafting permission is required.',
      );
    checkAbort(context.signal);
    const input = parseInput(ideaDraftInputSchema, raw);
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    const resolved = resolveResearchDraft(
      this.store,
      this.profile.id,
      input.ideaId,
    );
    const { ideaId, ...preferences } = input;
    void ideaId;
    return this.createPrepared(
      {
        ...preferences,
        brief: `${resolved.idea.title}\n${resolved.idea.angle}`,
      },
      { ...context, signal },
      resolved,
    );
  }
  private async createPrepared(
    raw: unknown,
    context: ExecutionContext,
    resolved?: ReturnType<typeof resolveResearchDraft>,
  ): Promise<DraftResult> {
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
    const research: ResearchDraftContext | undefined = resolved?.research;
    const attachment = research ? researchAttachment(research) : undefined;
    const promptVersion = research ? RESEARCH_DRAFT_VERSION : PROMPT_VERSION;
    const tool = research ? 'draft_from_idea' : 'draft_post';
    const knowledge = structuredClone(
      (research ? undefined : context.knowledge) ??
        (await this.knowledge?.retrieve(
          resolved?.query ?? input.brief,
          signal,
        )) ??
        EMPTY_KNOWLEDGE,
    );
    checkAbort(signal);
    if (
      research &&
      (knowledge.sources.length > 6 ||
        knowledge.sources.reduce(
          (sum, source) => sum + source.excerpt.length,
          0,
        ) > 6000)
    )
      throw new AppError(
        'WORKFLOW_LIMIT',
        'Private evidence exceeds the drafting budget.',
      );
    if (attachment && attachment.prefix.length >= 3000)
      throw new AppError(
        'WORKFLOW_LIMIT',
        'The attributed research attachment exceeds the draft budget.',
      );
    const warnings = [...(resolved?.warnings ?? [])];
    if (
      resolved?.idea.personalEvidence &&
      !knowledge.sources.some(
        (source) =>
          source.id === resolved.idea.personalEvidence!.sourceId &&
          source.excerpt.includes(resolved.idea.personalEvidence!.quote),
      )
    )
      warnings.push(
        'The historical private quotation was not supplied by current retrieval and cannot support this draft.',
      );
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
      ...(research && attachment
        ? { research, commentaryLimit: 3000 - attachment.prefix.length }
        : {}),
    };
    // Fixed construction order makes normalized effective inputs deterministic.
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          request,
          provider: this.provider.provider,
          model: this.provider.model,
          promptVersion: research
            ? `${RESEARCH_DRAFT_VERSION}:${PIPELINE_VERSION}`
            : PIPELINE_VERSION,
        }),
      )
      .digest('hex');
    const reservation = this.store.reserveDraft(
      this.profile.id,
      hash,
      request,
      input.idempotencyKey,
      context,
      research,
    );
    if (reservation.draft) return { draft: reservation.draft, replayed: true };
    const runId = reservation.runId;
    this.logger.log({
      event: 'run_started',
      runId,
      actor: context.actor,
      tool,
    });
    let candidate: GeneratedBody | undefined;
    let generation: ModelMetadata | undefined;
    let assessment: AssessmentReport | undefined;
    const knowledgeHash = digest(knowledge);
    const provenance = structuredClone({
      origin: research
        ? ('accepted_content_idea' as const)
        : ('user_provided' as const),
      ...(research ? { research } : {}),
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
          candidate = {
            body: `${attachment?.prefix ?? ''}${retainedBody.data}`,
            warnings,
          };
          generation = generated.metadata;
        }
        throw new AppError(
          'INVALID_OUTPUT',
          'The provider returned an invalid draft. Nothing was stored as a draft.',
        );
      }
      const commentary = validated.data;
      candidate = {
        body: `${attachment?.prefix ?? ''}${commentary.body}`,
        warnings: [...commentary.warnings, ...warnings],
      };
      generation = generated.metadata;
      if (candidate.body.length > 3000)
        throw new AppError(
          'INVALID_OUTPUT',
          'The assembled draft exceeds 3000 characters. Inspect its private artifact.',
        );
      checkAbort(signal);
      const bodyHash = digest(candidate.body);
      const assessed = await this.provider.assessDraft(
        {
          units: bodyUnits(commentary.body).map(({ id, text }) => ({
            id,
            text,
          })),
          ...(research
            ? {
                publicContext: {
                  quote: research.quote,
                  verification: 'publisher_reported' as const,
                },
              }
            : {}),
          sources: knowledge.sources.map(({ id, excerpt }) => ({
            id,
            excerpt,
          })),
        },
        signal,
      );
      const result = assessBody(
        commentary,
        knowledge,
        this.profile,
        assessed.output,
        Boolean(research),
      );
      assessment = { ...result.report, metadata: assessed.metadata };
      if (research && attachment) {
        assessment.bodyHash = digest(candidate.body);
        assessment.publicEvidenceHash = research.evidenceHash;
        assessment.researchPolicyVersion = RESEARCH_DRAFT_VERSION;
        assessment.publicCitations = [attachment.citation];
        for (const span of [...assessment.units, ...assessment.findings]) {
          span.start += attachment.prefix.length;
          span.end += attachment.prefix.length;
        }
      }
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
        { ...commentary, warnings: candidate.warnings, claims: result.claims },
        knowledge,
        this.profile,
      );
      const draft = {
        ...grounded.output,
        body: candidate.body,
        ...(attachment ? { publicCitations: [attachment.citation] } : {}),
        review: grounded.review,
        id: randomUUID(),
        userId: this.profile.id,
        runId,
        createdAt: new Date().toISOString(),
        status: 'draft' as const,
        promptVersion,
        provenance,
        assessment,
        generation: generated.metadata,
      };
      this.store.completeDraft(
        draft,
        research
          ? () => {
              assertDraftPolicy(research);
              const current = resolveResearchDraft(
                this.store,
                this.profile.id,
                research.ideaId,
              );
              if (current.research.evidenceHash !== research.evidenceHash)
                throw new AppError(
                  'RESEARCH_EVIDENCE_INVALID',
                  'Research evidence changed during drafting.',
                );
            }
          : undefined,
      );
      this.logger.log({
        event: 'run_succeeded',
        runId,
        actor: context.actor,
        tool,
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
            ...(attachment && research
              ? {
                  publicCitations: [attachment.citation],
                  publicEvidenceHash: research.evidenceHash,
                }
              : {}),
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
            promptVersion,
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
        tool,
        code: safe.code,
      });
      throw safe;
    }
  }
}
