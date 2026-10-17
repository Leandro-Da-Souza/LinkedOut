import type { BodyUnit } from '../domain/assessment.js';

/** Preserve original UTF-16 offsets; never split dots inside technical tokens. */
export function sentenceUnits(body: string): BodyUnit[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const units: BodyUnit[] = [];
  for (const line of body.matchAll(/[^\r\n]+/gu)) {
    for (const segment of segmenter.segment(line[0])) {
      if (!segment.segment.trim()) continue;
      const start = line.index + segment.index;
      units.push({
        id: `u${units.length}`,
        start,
        end: start + segment.segment.length,
        text: segment.segment,
      });
    }
  }
  return units;
}
