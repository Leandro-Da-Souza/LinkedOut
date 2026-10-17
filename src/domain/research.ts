import { z } from 'zod';
import type { ModelMetadata } from './contracts.js';
import type { KnowledgeContext, KnowledgeSource } from './knowledge.js';

export const RESEARCH_VERSION = 'research-v2-app-evidence';
export const researchInputSchema = z.strictObject({
  lookbackDays: z.number().int().min(7).max(90).optional(),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:-]+$/)
    .optional(),
});
export const reviewIdeaSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['proposed', 'accepted', 'rejected']),
});
export const listIdeasSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  status: z.enum(['proposed', 'accepted', 'rejected']).optional(),
});
export interface ResearchSource {
  repository: string;
  topic: string;
  aliases: string[];
  origin: 'github_public_releases';
  role: 'primary';
  permittedUses: readonly (
    | 'local_research'
    | 'model_planning'
    | 'model_drafting'
    | 'local_attributed_quotation'
  )[];
  retention: 'unreferenced_90_days';
}
const source = (
  repository: string,
  topic: string,
  aliases: string[],
): ResearchSource => ({
  repository,
  topic,
  aliases,
  origin: 'github_public_releases',
  role: 'primary',
  permittedUses: [
    'local_research',
    'model_planning',
    'model_drafting',
    'local_attributed_quotation',
  ],
  retention: 'unreferenced_90_days',
});
export const RESEARCH_SOURCES: readonly ResearchSource[] = [
  source('microsoft/TypeScript', 'typescript', [
    'typescript',
    'frontend',
    'architecture',
  ]),
  source('react/react', 'frontend', ['react', 'frontend', 'architecture']),
  source('vuejs/core', 'frontend', ['vue', 'frontend', 'architecture']),
  source('vitejs/vite', 'frontend', ['vite', 'frontend', 'typescript']),
  source('ollama/ollama', 'local-ai', ['ollama', 'local ai', 'agents']),
  source('modelcontextprotocol/typescript-sdk', 'mcp', [
    'mcp',
    'agentic',
    'agents',
    'typescript',
  ]),
];
export interface ResearchItem {
  id: string;
  identity: string;
  repository: string;
  releaseId: number;
  url: string;
  title: string;
  tag: string;
  publishedAt: string | null;
  rawPublicationDate: string | null;
  dateQuality: 'valid' | 'invalid';
  retrievedAt: string;
  excerpt: string;
  contentHash: string;
  prerelease: boolean;
  truncated: boolean;
  source: ResearchSource;
  verification: 'publisher_reported';
}
export interface SourceOutcome {
  repository: string;
  status: 'ok' | 'failed';
  code?: string;
  truncated: boolean;
  count: number;
}
export interface ResearchFeed {
  collect(
    signal: AbortSignal,
    executionCache?: ResearchCache,
  ): Promise<{
    items: ResearchItem[];
    outcomes: SourceOutcome[];
    requests: number;
  }>;
}
export interface Score {
  topic: number;
  significance: number;
  recency: number;
  personal: number;
  total: number;
  signals: string[];
}
export interface PlanningCandidate {
  item: ResearchItem;
  score: Score;
}
export interface ResearchPlanningRequest {
  preferences: { interests: string[]; audience: string; language: string };
  candidates: {
    title: string;
    publishedAt: string;
    excerpt: string;
    score: Score;
  }[];
  personalEvidence: { excerpt: string }[];
}
// The model selects an editorial lens rather than authoring unchecked factual prose.
export const researchPlanWireSchema = z.strictObject({
  ideas: z.array(
    z.strictObject({
      angle: z.enum([
        'migration_checklist',
        'architecture_tradeoffs',
        'experiment',
        'team_discussion',
      ]),
      personalEvidenceIndex: z.number().int().nullable(),
    }),
  ),
});
export interface ResearchPlanner {
  readonly provider: string;
  readonly model: string;
  planResearch(
    request: ResearchPlanningRequest,
    signal: AbortSignal,
  ): Promise<{ output: unknown; metadata: ModelMetadata }>;
}
export interface ContentIdea {
  id: string;
  runId: string;
  itemId: string;
  identity: string;
  title: string;
  angle: string;
  score: Score;
  whyRelevant: string[];
  publicEvidence: {
    itemId: string;
    url: string;
    publishedAt: string;
    quote: string;
    verification: 'publisher_reported';
  };
  personalEvidence: {
    sourceId: string;
    quote: string;
    source: KnowledgeSource;
  } | null;
  status: 'proposed' | 'accepted' | 'rejected';
  reviewRequired: true;
  warnings: string[];
}
export interface ResearchResult {
  runId: string;
  createdAt: string;
  lookbackDays: number;
  coverage: 'complete' | 'partial';
  outcomes: SourceOutcome[];
  ideas: ContentIdea[];
  requests: number;
  modelCalls: number;
  knowledge: KnowledgeContext;
  evidenceSnapshot: ResearchItem[];
  generation?: ModelMetadata;
}

export interface ResearchCache {
  getResearchCache(key: string): unknown;
  setResearchCache(key: string, value: unknown): void;
}
