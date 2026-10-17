import { z } from 'zod';
import { draftInputSchema } from './contracts.js';
import type { ResearchItem, ResearchSource } from './research.js';

export const RESEARCH_DRAFT_VERSION = 'research-draft-v1-attachment';
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
export interface PublicCitation {
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
