import { z } from 'zod';
import { AppError } from './errors.js';
import type { KnowledgeContext } from './knowledge.js';

const shortText = z.string().trim().min(1).max(300);
export const userProfileSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('local'),
  name: shortText.optional(),
  headline: shortText.optional(),
  interests: z.array(shortText).max(20).default([]),
  audience: shortText.default('Professional peers'),
  tone: shortText.default('Professional, clear, and conversational'),
  language: shortText.default('English'),
  writingSamples: z
    .array(z.string().trim().min(1).max(4000))
    .max(3)
    .default([]),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const draftInputSchema = z.strictObject({
  brief: z.string().trim().min(1).max(8000),
  audience: shortText.optional(),
  tone: shortText.optional(),
  language: shortText.optional(),
  writingSamples: z.array(z.string().trim().min(1).max(4000)).max(3).optional(),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:-]+$/)
    .optional(),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

// Keep wire schemas within OpenAI's supported strict JSON Schema subset.
// Content and size constraints are applied locally after parsing.
export const generatedDraftWireSchema = z.strictObject({
  body: z.string(),
  warnings: z.array(z.string()),
});
export const generatedBodySchema = z.strictObject({
  body: z.string().trim().min(1).max(3000),
  warnings: z.array(z.string().trim().min(1).max(1000)).max(10),
});
export type GeneratedBody = z.infer<typeof generatedBodySchema>;
export const generatedDraftSchema = z.strictObject({
  body: z.string().trim().min(1).max(3000),
  warnings: z.array(z.string().trim().min(1).max(1000)).max(10),
  claims: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(1500),
        sourceId: z.string().trim().min(1).max(150),
        quote: z.string().trim().min(1).max(1500),
      }),
    )
    .max(20)
    .default([]),
});
export type GeneratedDraft = z.infer<typeof generatedDraftSchema>;

export const plannedDraftSchema = z.strictObject({
  brief: z.string(),
  audience: z.string().nullable(),
  tone: z.string().nullable(),
  language: z.string().nullable(),
});

export interface GenerationRequest {
  input: Omit<DraftInput, 'idempotencyKey'>;
  profile: UserProfile;
  knowledge?: KnowledgeContext;
}
export interface ModelMetadata {
  provider: string;
  model: string;
  responseId?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface Draft extends GeneratedDraft {
  id: string;
  userId: string;
  runId: string;
  createdAt: string;
  status: 'draft';
  promptVersion: string;
  provenance: {
    origin: 'user_provided';
    profile: UserProfile;
    input: GenerationRequest['input'];
    knowledge?: KnowledgeContext;
  };
  review?: {
    required: true;
    grounding: 'evidence_linked' | 'no_personal_claims';
    limitations: string[];
  };
  generation: ModelMetadata;
  assessment?: import('./assessment.js').AssessmentReport;
}
export interface DraftResult {
  draft: Draft;
  replayed: boolean;
}
export interface ProposedCall {
  name: string;
  callId: string;
  arguments: unknown;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface DraftProvider {
  readonly provider: string;
  readonly model: string;
  generateDraft(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<{ output: unknown; metadata: ModelMetadata }>;
  assessDraft(
    request: import('./assessment.js').AssessmentRequest,
    signal: AbortSignal,
  ): Promise<{ output: unknown; metadata: ModelMetadata }>;
  proposeTools(
    brief: string,
    profile: UserProfile,
    tools: ToolSpec[],
    signal: AbortSignal,
  ): Promise<{ calls: ProposedCall[]; metadata: ModelMetadata }>;
}
export type Permission = 'read_local' | 'draft_local' | 'delete_local';
export interface ExecutionContext {
  actor: 'mcp' | 'cli' | 'agent' | 'smoke' | 'test';
  permissions: ReadonlySet<Permission>;
  signal?: AbortSignal;
  parentRunId?: string;
  knowledge?: KnowledgeContext;
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(
      (issue) => issue.path.join('.') || 'input',
    );
    throw new AppError(
      'INVALID_INPUT',
      `Invalid fields: ${[...new Set(fields)].join(', ')}.`,
    );
  }
  return parsed.data;
}

export const getDraftSchema = z.strictObject({ id: z.uuid() });
export const listDraftsSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
