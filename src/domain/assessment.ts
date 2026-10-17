import { z } from 'zod';
import type { Draft, GeneratedBody, ModelMetadata } from './contracts.js';
import type { GroundingDiagnostic, ErrorCode } from './errors.js';

export const ASSESSMENT_VERSION = 'assessment-v2';
export const GROUNDING_POLICY_VERSION = 'whole-unit-attribution-v2';
export interface BodyUnit {
  id: string;
  start: number;
  end: number;
  text: string;
}
export interface AssessmentRequest {
  units: Pick<BodyUnit, 'id' | 'text'>[];
  sources: { id: string; excerpt: string }[];
  publicContext?: { quote: string; verification: 'publisher_reported' };
}
const category = z.enum([
  'personal_fact',
  'general_fact',
  'advice_opinion_question',
  'uncertain',
]);
const evidence = z.strictObject({
  sourceId: z.string(),
  quote: z.string(),
});
export const assessmentWireSchema = z.strictObject({
  units: z.array(
    z.strictObject({
      id: z.string(),
      category,
      evidence: evidence.nullable(),
    }),
  ),
});
export const assessmentSchema = z.strictObject({
  units: z
    .array(
      z.strictObject({
        id: z.string().max(30),
        category,
        evidence: evidence
          .extend({
            sourceId: z.string().max(150),
            quote: z.string().min(1).max(1500),
          })
          .nullable(),
      }),
    )
    .max(200),
});
export interface AssessmentDiagnostic {
  reason:
    | 'INVALID_SCHEMA'
    | 'UNIT_LIMIT'
    | 'MISSING_UNIT'
    | 'DUPLICATE_UNIT'
    | 'UNKNOWN_UNIT'
    | 'CONTRADICTORY_ADVICE'
    | 'FINDING_LIMIT';
  unitId?: string;
}
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
  researchPolicyVersion?: string;
  publicEvidenceHash?: string;
  publicCitations?: import('./research-draft.js').PublicCitation[];
  version: 'assessment-v1' | typeof ASSESSMENT_VERSION;
  policyVersion: 'exact-attribution-v1' | typeof GROUNDING_POLICY_VERSION;
  bodyHash: string;
  knowledgeHash: string;
  complete: boolean;
  blocked: boolean;
  findings: AssessmentFinding[];
  units: {
    unitId: string;
    start: number;
    end: number;
    category: z.infer<typeof category> | null;
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
  diagnostics?: AssessmentDiagnostic[];
  heuristicDiagnostic?: GroundingDiagnostic;
  metadata?: ModelMetadata;
}
/** Immutable revision 1. Editing and reassessment are intentionally not exposed. */
export interface ReviewArtifact extends GeneratedBody {
  publicCitations?: import('./research-draft.js').PublicCitation[];
  publicEvidenceHash?: string;
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
