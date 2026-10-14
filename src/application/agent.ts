import type {
  DraftProvider,
  DraftResult,
  ExecutionContext,
  UserProfile,
} from '../domain/contracts.js';
import {
  draftInputSchema,
  parseInput,
  plannedDraftSchema,
} from '../domain/contracts.js';
import { AppError, checkAbort, publicError } from '../domain/errors.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import type { Logger } from '../infrastructure/logger.js';
import type { ToolRegistry } from './tools.js';
import { createHash } from 'node:crypto';
import { PIPELINE_VERSION } from './drafting.js';
import { EMPTY_KNOWLEDGE } from '../domain/knowledge.js';
import type { KnowledgeReader } from '../domain/knowledge.js';

export class AgentWorkflow {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly provider: DraftProvider,
    private readonly store: SqliteStore,
    private readonly profile: UserProfile,
    private readonly logger: Logger,
    private readonly timeoutMs = 120_000,
    private readonly knowledge?: KnowledgeReader,
  ) {}
  async run(
    raw: unknown,
    context: ExecutionContext,
  ): Promise<DraftResult & { workflowRunId: string }> {
    if (!context.permissions.has('draft_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'Drafting permission is required for this workflow.',
      );
    const input = parseInput(draftInputSchema, raw);
    checkAbort(context.signal);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = context.signal
      ? AbortSignal.any([deadline, context.signal])
      : deadline;
    const knowledge =
      (await this.knowledge?.retrieve(input.brief, signal)) ?? EMPTY_KNOWLEDGE;
    checkAbort(signal);
    const request = {
      kind: 'agent',
      input,
      profile: this.profile,
      provider: this.provider.provider,
      model: this.provider.model,
      workflowVersion: 'agent-v1',
      promptVersion: PIPELINE_VERSION,
      knowledge,
    };
    // Caller key is not part of semantic input, and is never assigned by the model.
    const semanticInput = { ...input };
    delete semanticInput.idempotencyKey;
    const hash = createHash('sha256')
      .update(JSON.stringify({ ...request, input: semanticInput }))
      .digest('hex');
    const reservation = this.store.reserveAgent(
      this.profile.id,
      hash,
      request,
      input.idempotencyKey,
      context,
    );
    const runId = reservation.runId;
    if (reservation.draft)
      return { draft: reservation.draft, replayed: true, workflowRunId: runId };
    const allowed = ['draft_post'] as const;
    this.logger.log({ event: 'run_started', runId, actor: 'agent' });
    try {
      const proposal = await this.provider.proposeTools(
        input.brief,
        this.profile,
        this.registry.specs(allowed),
        signal,
      );
      checkAbort(signal);
      if (proposal.calls.length !== 1)
        throw new AppError(
          'WORKFLOW_LIMIT',
          'This workflow permits exactly one drafting tool call.',
        );
      const call = proposal.calls[0]!;
      if (!(allowed as readonly string[]).includes(call.name))
        throw new AppError(
          'PERMISSION_DENIED',
          'The agent requested a tool outside its allowlist.',
        );
      const planned = parseInput(plannedDraftSchema, call.arguments);
      this.store.recordPlan(runId, { call, metadata: proposal.metadata });
      // The planner selects parameters, never credentials, permissions, identity, or idempotency.
      // Retain the original user brief so planning cannot silently invent source facts.
      const draftInput = {
        brief: input.brief,
        ...((input.audience ?? planned.audience)
          ? { audience: input.audience ?? planned.audience! }
          : {}),
        ...((input.tone ?? planned.tone)
          ? { tone: input.tone ?? planned.tone! }
          : {}),
        ...((input.language ?? planned.language)
          ? { language: input.language ?? planned.language! }
          : {}),
        ...(input.writingSamples
          ? { writingSamples: input.writingSamples }
          : {}),
      };
      const result = (await this.registry.invoke(call.name, draftInput, {
        ...context,
        actor: 'agent',
        signal,
        parentRunId: runId,
        knowledge,
      })) as DraftResult;
      this.store.completeAgent(runId, result.draft.id);
      this.logger.log({ event: 'run_succeeded', runId, actor: 'agent' });
      return { ...result, workflowRunId: runId };
    } catch (error) {
      let safe = publicError(error);
      if (signal.aborted) {
        try {
          checkAbort(signal);
        } catch (abort) {
          const cancelled = publicError(abort);
          safe = new AppError(
            cancelled.code,
            cancelled.message,
            safe.groundingDiagnostic,
            safe.reviewArtifactId,
          );
        }
      }
      try {
        this.store.failRun(
          runId,
          safe.code,
          safe.groundingDiagnostic,
          safe.reviewArtifactId,
        );
      } catch {
        /* Preserve original failure. */
      }
      this.logger.log({
        event: 'run_failed',
        runId,
        actor: 'agent',
        code: safe.code,
      });
      throw safe;
    }
  }
}
