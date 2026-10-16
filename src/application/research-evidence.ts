import { researchFailure } from '../domain/errors.js';

// Temporary prefix strategy; do not normalize, trim, or append an ellipsis to evidence.
export function evidencePrefix(excerpt: string): string {
  const prefix = excerpt.slice(0, 800);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

export function validateResearchQuote(
  source: string,
  quote: string,
  stage: 'public_evidence' | 'private_evidence',
  index: number,
): void {
  if (quote.length < 20)
    throw researchFailure(stage, 'EXCERPT_TOO_SHORT', index);
  if (quote.length > 800)
    throw researchFailure(stage, 'EXCERPT_TOO_LONG', index);
  if (!source.includes(quote))
    throw researchFailure(stage, 'QUOTE_NOT_IN_SOURCE', index);
}
