import { evidencePrefix, validateResearchQuote } from './research-evidence.js';
import { researchFailure } from '../domain/errors.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionContext, UserProfile } from '../domain/contracts.js';
import { parseInput } from '../domain/contracts.js';
import { AppError, checkAbort, publicError } from '../domain/errors.js';
import { EMPTY_KNOWLEDGE, type KnowledgeReader } from '../domain/knowledge.js';
import {
  RESEARCH_SOURCES,
  RESEARCH_VERSION,
  researchInputSchema,
  researchPlanWireSchema,
  type ResearchFeed,
  type ResearchItem,
  type ResearchPlanner,
  type ResearchResult,
  type Score,
  type ContentIdea,
} from '../domain/research.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import type { Logger } from '../infrastructure/logger.js';

export function scoreResearch(
  item: ResearchItem,
  interests: string[],
  now: Date,
  lookbackDays: number,
): Score {
  const configuredMatches = item.source.aliases.filter((alias) =>
    interests.some((interest) => interest.toLowerCase().includes(alias)),
  );
  const text = `${item.title} ${item.excerpt}`.toLowerCase();
  const signals = [
    'breaking',
    'security',
    'deprecat',
    'migration',
    'support',
    'feature',
  ].filter((word) => text.includes(word));
  const topic = Math.min(40, 20 + configuredMatches.length * 10);
  const significance = Math.min(25, signals.length * 5);
  const ageDays = (now.getTime() - Date.parse(item.publishedAt!)) / 86_400_000;
  const recency = Math.max(0, Math.round(20 * (1 - ageDays / lookbackDays)));
  return {
    topic,
    significance,
    recency,
    personal: 0,
    total: topic + significance + recency,
    signals: [
      ...configuredMatches.map((value) => `interest:${value}`),
      ...signals.map((value) => `release-note:${value}`),
    ],
  };
}
const lenses = {
  migration_checklist:
    'Which checks would I include before considering this release for a project?',
  architecture_tradeoffs:
    'Which architectural tradeoffs should a team investigate before adopting this release?',
  experiment: 'What small local experiment could help evaluate this release?',
  team_discussion:
    'Which questions about this release would be useful in a team discussion?',
};

export class ResearchWorkflow {
  constructor(
    private readonly store: SqliteStore,
    private readonly feed: ResearchFeed,
    private readonly planner: ResearchPlanner,
    private readonly profile: UserProfile,
    private readonly knowledge: KnowledgeReader,
    private readonly logger: Logger,
    private readonly defaultLookback = 14,
    private readonly timeoutMs = 120_000,
    private readonly now = () => new Date(),
  ) {}

  async run(raw: unknown, context: ExecutionContext) {
    if (!context.permissions.has('research_local'))
      throw new AppError(
        'PERMISSION_DENIED',
        'Research permission is required.',
      );
    const input = parseInput(researchInputSchema, raw);
    checkAbort(context.signal);
    // A key identifies historical execution, not a promise to refresh current configuration.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'research',
          lookbackDays: input.lookbackDays ?? null,
        }),
      )
      .digest('hex');
    const preferences = {
      interests: this.profile.interests,
      audience: this.profile.audience,
      language: this.profile.language,
    };
    const reservation = this.store.reserveResearch(
      this.profile.id,
      requestHash,
      {
        kind: 'research',
        lookbackDays: input.lookbackDays ?? this.defaultLookback,
        preferences,
        sources: RESEARCH_SOURCES,
        version: RESEARCH_VERSION,
        provider: this.planner.provider,
        model: this.planner.model,
      },
      input.idempotencyKey,
      context,
    );
    if (reservation.result)
      return {
        result: reservation.result,
        replayed: true,
        execution: 'historical_replay' as const,
      };
    const runId = reservation.runId;
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    this.logger.log({
      event: 'run_started',
      runId,
      actor: context.actor,
      tool: 'research_run',
    });
    try {
      const now = this.now();
      const lookbackDays = input.lookbackDays ?? this.defaultLookback;
      const collected = await this.feed.collect(
        signal,
        this.store.researchCacheFor(this.profile.id, runId),
      );
      checkAbort(signal);
      const items = this.store.saveResearchItems(
        this.profile.id,
        collected.items,
        runId,
      );
      this.store.pruneResearch(
        this.profile.id,
        new Date(now.getTime() - 90 * 86_400_000).toISOString(),
        runId,
      );
      this.store.recordPlan(runId, {
        outcomes: collected.outcomes,
        requests: collected.requests,
        modelCalls: 0,
      });
      if (
        collected.outcomes.every(
          (outcome) => outcome.status === 'failed' && outcome.count === 0,
        )
      )
        throw new AppError(
          'PROVIDER_ERROR',
          'All research sources failed. Inspect run coverage.',
        );
      const unique = new Map<string, ResearchItem>();
      for (const item of items)
        if (!unique.has(item.identity)) unique.set(item.identity, item);
      let candidates = [...unique.values()]
        .filter(
          (item) =>
            item.publishedAt &&
            !item.prerelease &&
            item.excerpt.length >= 20 &&
            Date.parse(item.publishedAt) <= now.getTime() &&
            Date.parse(item.publishedAt) >=
              now.getTime() - lookbackDays * 86_400_000 &&
            !this.store.researchIdentitySeen(this.profile.id, item.identity),
        )
        .map((item) => ({
          item,
          score: scoreResearch(item, this.profile.interests, now, lookbackDays),
        }));
      const compare = (
        a: (typeof candidates)[number],
        b: (typeof candidates)[number],
      ) =>
        b.score.total - a.score.total ||
        b.item.publishedAt!.localeCompare(a.item.publishedAt!) ||
        a.item.identity.localeCompare(b.item.identity);
      candidates.sort(compare);
      const query = [
        ...new Set(
          candidates
            .slice(0, 12)
            .flatMap((candidate) => candidate.item.source.aliases),
        ),
      ].join(' ');
      const knowledge = query
        ? await this.knowledge.retrieve(query, signal)
        : structuredClone(EMPTY_KNOWLEDGE);
      checkAbort(signal);
      if (
        knowledge.sources.length > 6 ||
        knowledge.sources.reduce(
          (sum, source) => sum + source.excerpt.length,
          0,
        ) > 6000
      )
        throw new AppError(
          'WORKFLOW_LIMIT',
          'Private research evidence exceeds its budget.',
        );
      for (const candidate of candidates) {
        const matches = knowledge.sources.filter((source) =>
          candidate.item.source.aliases.some((alias) =>
            source.excerpt.toLowerCase().includes(alias),
          ),
        );
        candidate.score.personal = Math.min(15, matches.length * 5);
        candidate.score.total += candidate.score.personal;
        candidate.score.signals.push(
          ...matches.map((source) => `private-match:${source.id}`),
        );
      }
      candidates.sort(compare);
      const repositories = new Set<string>();
      const topics = new Map<string, number>();
      const hashes = new Set<string>();
      candidates = candidates
        .filter(({ item }) => {
          if (
            repositories.has(item.repository) ||
            (topics.get(item.source.topic) ?? 0) >= 2 ||
            hashes.has(item.contentHash)
          )
            return false;
          repositories.add(item.repository);
          hashes.add(item.contentHash);
          topics.set(
            item.source.topic,
            (topics.get(item.source.topic) ?? 0) + 1,
          );
          return true;
        })
        .slice(0, 5);
      const result: ResearchResult = {
        runId,
        createdAt: now.toISOString(),
        lookbackDays,
        coverage: collected.outcomes.some(
          (outcome) => outcome.status === 'failed' || outcome.truncated,
        )
          ? 'partial'
          : 'complete',
        outcomes: collected.outcomes,
        requests: collected.requests,
        modelCalls: 0,
        ideas: [],
        knowledge,
        evidenceSnapshot: candidates.map((candidate) => candidate.item),
      };
      // Keep safe failure diagnostics even if planning does not complete.
      this.store.recordPlan(runId, {
        coverage: result.coverage,
        outcomes: result.outcomes,
        requests: result.requests,
        modelCalls: 0,
      });
      if (candidates.length) {
        const publicQuotes = candidates.map(({ item }, index) => {
          const quote = evidencePrefix(item.excerpt);
          validateResearchQuote(item.excerpt, quote, 'public_evidence', index);
          return quote;
        });
        const privateOptions = knowledge.sources
          .map((source) => ({ source, quote: evidencePrefix(source.excerpt) }))
          .filter((option) => option.quote.length >= 20);
        const request = {
          preferences,
          candidates: candidates.map(({ item, score }) => ({
            title: item.title,
            publishedAt: item.publishedAt!,
            excerpt: item.excerpt,
            score,
          })),
          personalEvidence: privateOptions.map((option) => ({
            excerpt: option.quote,
          })),
        };
        if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 29_000)
          throw new AppError(
            'WORKFLOW_LIMIT',
            'Research input exceeds its byte budget.',
          );
        this.store.recordPlan(runId, {
          coverage: result.coverage,
          outcomes: result.outcomes,
          requests: result.requests,
          modelCalls: 1,
        });
        const planned = await this.planner.planResearch(request, signal);
        checkAbort(signal);
        this.store.recordPlan(runId, {
          coverage: result.coverage,
          outcomes: result.outcomes,
          requests: result.requests,
          modelCalls: 1,
          generation: planned.metadata,
        });
        const parsed = researchPlanWireSchema.safeParse(planned.output);
        if (!parsed.success) {
          const path = parsed.error.issues[0]?.path;
          const position =
            path?.[0] === 'ideas' &&
            typeof path[1] === 'number' &&
            path[1] >= 0 &&
            path[1] < candidates.length
              ? path[1]
              : null;
          throw researchFailure('output_schema', 'INVALID_SCHEMA', position);
        }
        if (parsed.data.ideas.length !== candidates.length)
          throw researchFailure('candidate_count', 'COUNT_MISMATCH', null);
        result.modelCalls = 1;
        result.generation = planned.metadata;
        result.ideas = parsed.data.ideas.map((proposal, index): ContentIdea => {
          const { item, score } = candidates[index]!;
          const publicQuote = publicQuotes[index]!;
          let personalEvidence: ContentIdea['personalEvidence'] = null;
          if (proposal.personalEvidenceIndex !== null) {
            const selection = proposal.personalEvidenceIndex;
            if (
              !Number.isSafeInteger(selection) ||
              selection < 0 ||
              selection >= privateOptions.length
            )
              throw researchFailure(
                'private_evidence',
                'SELECTION_OUT_OF_RANGE',
                index,
              );
            const { source, quote } = privateOptions[selection]!;
            validateResearchQuote(
              source.excerpt,
              quote,
              'private_evidence',
              index,
            );
            if (
              !item.source.aliases.some((alias) =>
                quote.toLowerCase().includes(alias),
              )
            )
              throw researchFailure(
                'private_evidence',
                'SOURCE_NOT_RELEVANT',
                index,
              );
            personalEvidence = {
              sourceId: source.id,
              quote,
              source: structuredClone(source),
            };
          }
          return {
            id: randomUUID(),
            runId,
            itemId: item.id,
            identity: item.identity,
            title: item.title,
            angle: lenses[proposal.angle],
            score,
            whyRelevant: [
              `Configured priority: ${item.source.topic}.`,
              ...score.signals,
            ],
            publicEvidence: {
              itemId: item.id,
              url: item.url,
              publishedAt: item.publishedAt!,
              quote: publicQuote,
              verification: 'publisher_reported',
            },
            personalEvidence,
            status: 'proposed',
            reviewRequired: true,
            warnings: [
              'Publisher claims are not independently verified.',
              'Suggested questions are not findings or personal achievements.',
              ...(personalEvidence
                ? [
                    'Personal excerpts require human review; relevance matching does not verify experience.',
                  ]
                : ['No personal experience is attributed to this idea.']),
              ...(knowledge.issues.length
                ? [
                    'Private knowledge retrieval reported missing or incomplete evidence.',
                  ]
                : []),
              ...(item.truncated
                ? ['Release notes were truncated to the evidence budget.']
                : []),
            ],
          };
        });
      }
      checkAbort(signal);
      this.store.completeResearch(this.profile.id, result);
      this.logger.log({ event: 'run_succeeded', runId, actor: context.actor });
      return { result, replayed: false, execution: 'new_research' as const };
    } catch (error) {
      let safe = publicError(error);
      try {
        checkAbort(signal);
      } catch (abort) {
        safe = publicError(abort);
      }
      this.store.failRun(runId, safe.code, safe.groundingDiagnostic);
      this.logger.log({
        event: 'run_failed',
        runId,
        actor: context.actor,
        code: safe.code,
      });
      throw safe;
    }
  }
}
