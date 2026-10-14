import { z } from 'zod';
import type { Draft, GeneratedBody, ModelMetadata } from './contracts.js';
import type { GroundingDiagnostic, ErrorCode } from './errors.js';

export const ASSESSMENT_VERSION = 'assessment-v1';
export const GROUNDING_POLICY_VERSION = 'exact-attribution-v1';
export interface BodyUnit {
  id: string;
  start: number;
  end: number;
  text: string;
}
export interface AssessmentRequest {
  units: BodyUnit[];
  sources: { id: string; excerpt: string }[];
}
const category = z.enum([
  'personal_fact',
  'general_fact',
  'advice_opinion_question',
  'uncertain',
]);
const span = z.strictObject({
  start: z.number().int(),
  end: z.number().int(),
  sourceId: z.string().nullable(),
  quote: z.string().nullable(),
});
export const assessmentWireSchema = z.strictObject({
  units: z.array(
    z.strictObject({
      id: z.string(),
      category,
      claims: z.array(span),
    }),
  ),
});
export const assessmentSchema = z.strictObject({
  units: z
    .array(
      z.strictObject({
        id: z.string().max(30),
        category,
        claims: z
          .array(
            span.extend({
              sourceId: z.string().max(150).nullable(),
              quote: z.string().min(1).max(1500).nullable(),
            }),
          )
          .max(20),
      }),
    )
    .max(200),
});
export type EvidenceStatus =
  'exact_match' | 'plausible_paraphrase' | 'unsupported' | 'invalid_reference';
export interface AssessmentFinding {
  unitId: string;
  start: number;
  end: number;
  category: z.infer<typeof category>;
  status: EvidenceStatus;
  sourceId?: string;
  quote?: string;
}
export interface AssessmentReport {
  version: typeof ASSESSMENT_VERSION;
  policyVersion: typeof GROUNDING_POLICY_VERSION;
  bodyHash: string;
  knowledgeHash: string;
  complete: boolean;
  blocked: boolean;
  findings: AssessmentFinding[];
  units: {
    unitId: string;
    start: number;
    end: number;
    category: z.infer<typeof category>;
  }[];
  issues: (
    | 'INVALID_ASSESSMENT'
    | 'UNCERTAIN_CONTENT'
    | 'UNSUPPORTED_FACT'
    | 'INVALID_REFERENCE'
    | 'PARAPHRASE_REQUIRES_REVIEW'
    | 'SNAPSHOT_CHANGED'
    | 'HEURISTIC_FLAG'
  )[];
  heuristicDiagnostic?: GroundingDiagnostic;
  metadata?: ModelMetadata;
}
/** Immutable revision 1. Editing and reassessment are intentionally not exposed. */
export interface ReviewArtifact extends GeneratedBody {
  id: string;
  userId: string;
  runId: string;
  createdAt: string;
  revision: 1;
  parentRevisionId: null;
  status: 'blocked';
  publishable: false;
  reviewRequired: true;
  bodyHash: string;
  knowledgeHash: string;
  promptVersion: string;
  provenance: Draft['provenance'];
  generation: ModelMetadata;
  assessment?: AssessmentReport;
  failureCode: ErrorCode;
}
