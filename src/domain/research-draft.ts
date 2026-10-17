import { z } from 'zod';
import { draftInputSchema } from './contracts.js';
import type { ResearchItem, ResearchSource } from './research.js';

export const LEGACY_RESEARCH_DRAFT_VERSION = 'research-draft-v1-attachment';
export const RESEARCH_DRAFT_VERSION = 'research-draft-v2-editorial';
export const RESEARCH_ASSESSMENT_VERSION = 'research-assessment-v1';
export const RESEARCH_GROUNDING_VERSION = 'research-grounding-v2';
export const RESEARCH_SEGMENTATION_VERSION = 'research-segmentation-v1';
export const ideaDraftInputSchema = draftInputSchema
  .pick({ audience: true, tone: true, language: true, idempotencyKey: true })
  .extend({ ideaId: z.uuid() });

/** Editorial acceptance authorizes generation only, never approval or publication. */
export interface ResearchDraftContext {
  ideaId: string;
  researchRunId: string;
  acceptanceRevision: number;
  item: ResearchItem;
  quote: string;
  policy: ResearchSource;
  evidenceHash: string;
}

/** An attributed research attachment, independent of future editorial rendering. */
export interface ResearchAttachmentCitation {
  kind: 'research_attachment';
  verification: 'publisher_reported';
  itemId: string;
  repository: string;
  url: string;
  publishedAt: string;
  retrievedAt: string;
  contentHash: string;
  quote: string;
  start: number;
  end: number;
  quoteStart: number;
  quoteEnd: number;
}

/** Same bounded public data is supplied independently to both model operations. */
export interface PublicEvidenceProjection {
  repository: string;
  title: string;
  tag: string;
  publishedAt: string;
  excerpt: string;
  verification: 'publisher_reported';
}
export interface ResearchClaimCitation {
  kind: 'research_claim';
  verification: 'publisher_reported';
  itemId: string;
  publicEvidenceHash: string;
  unitId: string;
  start: number;
  end: number;
  relationship: 'publisher_claim' | 'interpretation' | 'speculation';
}
export type PublicCitation = ResearchAttachmentCitation | ResearchClaimCitation;

export const editorialCategory = z.enum([
  'publisher_claim',
  'personal_fact',
  'interpretation',
  'speculation',
  'opinion_advice_question',
  'uncertain',
]);
export const editorialReason = z.enum([
  'UNSUPPORTED_PREMISE',
  'QUANTITY_CHANGED',
  'QUALIFICATION_OMITTED',
  'OWNERSHIP_TRANSFER',
  'AMBIGUOUS_ATTRIBUTION',
]);
const editorialUnit = z.strictObject({
  id: z.string(),
  category: editorialCategory,
  evidenceKind: z.enum(['public', 'private', 'none']),
  privateSourceIndex: z.number().int().nullable(),
  support: z.enum(['supported', 'unsupported', 'uncertain', 'not_applicable']),
  reason: editorialReason.nullable(),
});
export const editorialAssessmentWireSchema = z.strictObject({
  units: z.array(editorialUnit),
});
export const editorialAssessmentSchema = z.strictObject({
  units: z
    .array(
      editorialUnit.extend({
        id: z.string().max(30),
        privateSourceIndex: z.number().int().min(0).max(5).nullable(),
      }),
    )
    .max(200),
});
