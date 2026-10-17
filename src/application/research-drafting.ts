import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { RESEARCH_SOURCES } from '../domain/research.js';
import type { ResearchItem } from '../domain/research.js';
import type {
  PublicCitation,
  ResearchDraftContext,
} from '../domain/research-draft.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';
import { digest } from './assessment.js';

const date = z.string().datetime();
const itemSchema = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  repository: z.string().min(1),
  releaseId: z.number().int().positive().safe(),
  url: z.string().max(2000),
  title: z.string().max(300),
  tag: z.string().max(300),
  publishedAt: date,
  rawPublicationDate: date,
  retrievedAt: date,
  dateQuality: z.literal('valid'),
  excerpt: z.string().min(20).max(2400),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  prerelease: z.literal(false),
  truncated: z.boolean(),
  verification: z.literal('publisher_reported'),
  source: z.object({
    repository: z.string(),
    topic: z.string(),
    aliases: z.array(z.string()),
    origin: z.literal('github_public_releases'),
    role: z.literal('primary'),
    permittedUses: z.array(
      z.enum([
        'local_research',
        'model_planning',
        'model_drafting',
        'local_attributed_quotation',
      ]),
    ),
    retention: z.literal('unreferenced_90_days'),
  }),
});
function invalid(): never {
  throw new AppError(
    'RESEARCH_EVIDENCE_INVALID',
    'Stored research evidence or its source policy is missing or inconsistent. No draft can be generated from this snapshot.',
  );
}
export function assertDraftPolicy(research: ResearchDraftContext): void {
  const policy = RESEARCH_SOURCES.find(
    (source) => source.repository === research.item.repository,
  );
  if (
    !policy ||
    digest(policy) !== digest(research.policy) ||
    !policy.permittedUses.includes('model_drafting') ||
    !policy.permittedUses.includes('local_attributed_quotation')
  )
    throw new AppError(
      'PERMISSION_DENIED',
      'This research source does not permit attributed local drafting.',
    );
}

export function resolveResearchDraft(
  store: SqliteStore,
  userId: string,
  ideaId: string,
  now = new Date(),
) {
  const { idea, revision, result } = store.getIdeaDraftState(userId, ideaId);
  if (idea.status !== 'accepted')
    throw new AppError(
      'IDEA_NOT_ACCEPTED',
      'Accept the idea before drafting. Acceptance authorizes generation only, never draft approval or publication.',
    );
  if (
    !result ||
    result.runId !== idea.runId ||
    !Array.isArray(result.ideas) ||
    !Array.isArray(result.evidenceSnapshot)
  )
    invalid();
  const originalIdea = result.ideas.find((entry) => entry.id === ideaId);
  if (
    !originalIdea ||
    digest({ ...idea, status: 'proposed' }) !==
      digest({ ...originalIdea, status: 'proposed' })
  )
    invalid();
  const parsed = itemSchema.safeParse(
    result.evidenceSnapshot.find((entry) => entry.id === idea.itemId),
  );
  if (!parsed.success) invalid();
  const item: ResearchItem = parsed.data;
  const evidence = idea.publicEvidence;
  if (
    !evidence ||
    evidence.itemId !== item.id ||
    idea.identity !== item.identity ||
    item.identity !== `${item.repository.toLowerCase()}:${item.releaseId}` ||
    evidence.url !== item.url ||
    evidence.publishedAt !== item.publishedAt ||
    evidence.verification !== 'publisher_reported' ||
    typeof evidence.quote !== 'string' ||
    evidence.quote.length < 20 ||
    evidence.quote.length > 800 ||
    !item.excerpt.includes(evidence.quote) ||
    item.source.repository !== item.repository ||
    !item.source.permittedUses.includes('local_research') ||
    !item.source.permittedUses.includes('model_planning') ||
    Date.parse(item.rawPublicationDate!) !== Date.parse(item.publishedAt!) ||
    Date.parse(item.publishedAt!) > Date.parse(item.retrievedAt) ||
    Date.parse(item.retrievedAt) > now.getTime() ||
    !Number.isInteger(result.lookbackDays) ||
    result.lookbackDays < 7 ||
    result.lookbackDays > 90
  )
    invalid();
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.pathname
      .toLowerCase()
      .startsWith(`/${item.repository.toLowerCase()}/releases/tag/`)
  )
    invalid();
  // Original hashes cover full notes, which may have been truncated on storage.
  // Compare the retained immutable snapshot to its persisted revision; never pretend
  // to recompute a full-source hash from a truncated excerpt.
  let stored: ResearchItem;
  try {
    stored = store.getResearchItem(userId, item.id);
  } catch {
    invalid();
  }
  const stable = (value: ResearchItem) => {
    const parsed = itemSchema.safeParse(value);
    if (!parsed.success) invalid();
    return { ...parsed.data, retrievedAt: null, source: null };
  };
  if (digest(stable(stored)) !== digest(stable(item))) invalid();
  const policy = RESEARCH_SOURCES.find(
    (source) => source.repository === item.repository,
  );
  if (!policy) invalid();
  const snapshot = {
    ideaId,
    researchRunId: idea.runId,
    acceptanceRevision: revision,
    item,
    quote: evidence.quote,
    policy: structuredClone(policy),
  };
  const research: ResearchDraftContext = {
    ...snapshot,
    evidenceHash: digest(snapshot),
  };
  assertDraftPolicy(research);
  const warnings = [
    'Idea acceptance authorizes generation only. This draft is not approved; human review is required before any use.',
    'Public research is publisher-reported, not independently verified. No live source revalidation was performed.',
    'The public evidence block is an attributed research attachment, not a final editorial format.',
    'The accepted quotation may omit context or end mid-sentence; inspect the original source.',
  ];
  if (
    Date.parse(item.publishedAt!) <
    now.getTime() - result.lookbackDays * 86_400_000
  )
    warnings.push(
      'The publication is outside the original research lookback window. The original date is preserved.',
    );
  if (store.hasNewerResearchRevision(userId, item))
    warnings.push(
      'A different, more recently observed local source revision exists. This draft uses the accepted snapshot.',
    );
  return { research, warnings, idea, query: policy.aliases.join(' ') };
}

export function researchAttachment(research: ResearchDraftContext): {
  prefix: string;
  citation: PublicCitation;
} {
  const header = `Publisher report: ${research.item.repository} — ${research.item.publishedAt}\n“`;
  const block = `${header}${research.quote}”\nSource: ${research.item.url}`;
  return {
    prefix: `${block}\n\n`,
    citation: {
      kind: 'research_attachment',
      verification: 'publisher_reported',
      itemId: research.item.id,
      repository: research.item.repository,
      url: research.item.url,
      publishedAt: research.item.publishedAt!,
      retrievedAt: research.item.retrievedAt,
      contentHash: research.item.contentHash,
      quote: research.quote,
      start: 0,
      end: block.length,
      quoteStart: header.length,
      quoteEnd: header.length + research.quote.length,
    },
  };
}
