/** Whitespace is the only permitted transformation of private factual evidence. */
export const normalizeEvidence = (text: string): string =>
  text.replace(/\s+/gu, ' ').trim();

/**
 * Require the complete retrieved excerpt. Substrings (even whole sentences)
 * can discard a negation, quotation attribution, or qualification elsewhere
 * in the excerpt. This is deliberately not a semantic entailment checker.
 * Return source-owned text, preserving its spelling and punctuation.
 */
export function privateQuote(
  text: string,
  excerpt: string,
): string | undefined {
  const normalized = normalizeEvidence(text);
  if (normalized.length < 12 || normalized.length > 1500) return undefined;
  return normalized === normalizeEvidence(excerpt) ? excerpt.trim() : undefined;
}

/** A line break or a dot inside a token cannot sever a body's attribution. */
export function isWholeSentence(
  body: string,
  start: number,
  end: number,
): boolean {
  const text = body.slice(start, end).trim();
  const contentStart = start + body.slice(start, end).indexOf(text);
  const contentEnd = contentStart + text.length;
  return [
    ...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(
      body.replace(/[\r\n]/gu, ' '),
    ),
  ].some(({ segment, index }) => {
    const trimmed = segment.trim();
    const segmentStart = index + segment.indexOf(trimmed);
    return (
      contentStart === segmentStart &&
      contentEnd === segmentStart + trimmed.length
    );
  });
}
