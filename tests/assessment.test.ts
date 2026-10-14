import { describe, expect, it } from 'vitest';
import { assessBody, bodyUnits } from '../src/application/assessment.js';
import { userProfileSchema } from '../src/domain/contracts.js';
import { diagnosticKnowledge } from './fixtures/grounding.js';

const profile = userProfileSchema.parse({});
const quote = diagnosticKnowledge.sources[0]!.excerpt;
const sourceId = diagnosticKnowledge.sources[0]!.id;
const evaluate = (
  body: string,
  category: string,
  claims: unknown[],
  extraUnits: unknown[] = [],
) =>
  assessBody({ body, warnings: [] }, diagnosticKnowledge, profile, {
    units: [{ id: 'u0', category, claims }, ...extraUnits],
  });
const link = (body = quote) => ({
  start: 0,
  end: body.length,
  sourceId,
  quote,
});

describe('independent assessment and deterministic attribution', () => {
  it('derives claims from immutable body spans and accepts exact attribution', () => {
    const result = evaluate(quote, 'personal_fact', [link()]);
    expect(result.report).toMatchObject({
      complete: true,
      blocked: false,
      findings: [{ status: 'exact_match' }],
    });
    expect(result.claims).toEqual([{ text: quote, quote, sourceId }]);
  });
  it('distinguishes plausible paraphrases without certifying support', () => {
    const body = 'I developed a synthetic reporting application.';
    expect(evaluate(body, 'personal_fact', [link(body)]).report).toMatchObject({
      blocked: true,
      findings: [{ status: 'plausible_paraphrase' }],
    });
  });
  it.each([
    { sourceId: 'invented', quote },
    { sourceId, quote: 'I invented an unsupported source quotation.' },
    { sourceId, quote: quote.toUpperCase() },
    { sourceId: null, quote },
  ])(
    'blocks invalid references without retaining fabricated source text',
    (reference) => {
      const result = evaluate(quote, 'personal_fact', [
        { ...link(), ...reference },
      ]);
      expect(result.report.findings[0]).toMatchObject({
        status: 'invalid_reference',
      });
      expect(result.report.findings[0]).not.toHaveProperty('quote');
      expect(result.report.blocked).toBe(true);
    },
  );
  it('distinguishes unsupported general factual assertions from advice', () => {
    const body = 'This algorithm guarantees optimal performance.';
    expect(
      evaluate(body, 'general_fact', [
        { start: 0, end: body.length, sourceId: null, quote: null },
      ]).report.findings[0]?.status,
    ).toBe('unsupported');
    expect(
      evaluate(
        'Consider profiling before optimizing.',
        'advice_opinion_question',
        [],
      ).report.blocked,
    ).toBe(false);
    expect(
      evaluate('Consider profiling before optimizing.', 'uncertain', []).report
        .blocked,
    ).toBe(true);
  });
  it('cannot override deterministic personal flags with an advice label', () => {
    expect(
      evaluate(quote, 'advice_opinion_question', []).report.issues,
    ).toContain('HEURISTIC_FLAG');
  });
  it('does not let an attributed span hide adjacent accomplishments or repeated occurrences', () => {
    const body = `${quote} I built an imaginary spaceship.`;
    const result = evaluate(
      body,
      'personal_fact',
      [link()],
      [{ id: 'u1', category: 'advice_opinion_question', claims: [] }],
    );
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
    expect(
      evaluate(
        `${quote} ${quote}`,
        'personal_fact',
        [link()],
        [{ id: 'u1', category: 'advice_opinion_question', claims: [] }],
      ).report.blocked,
    ).toBe(true);
  });
  it.each(
    [
      [{ ...link(), start: -1 }],
      [{ ...link(), end: 9999 }],
      [link(), link()],
    ].map((claims) => ({ claims })),
  )('rejects invalid or overlapping spans', ({ claims }) => {
    expect(evaluate(quote, 'personal_fact', claims).report.issues).toContain(
      'INVALID_ASSESSMENT',
    );
  });
  it('requires complete unit coverage without duplicate or fabricated IDs', () => {
    for (const units of [
      [],
      [{ id: 'fake', category: 'advice_opinion_question', claims: [] }],
      [
        { id: 'u0', category: 'advice_opinion_question', claims: [] },
        { id: 'u0', category: 'advice_opinion_question', claims: [] },
      ],
    ]) {
      expect(
        assessBody(
          { body: quote, warnings: [] },
          diagnosticKnowledge,
          profile,
          { units },
        ).report.issues,
      ).toContain('INVALID_ASSESSMENT');
    }
  });
  it('covers punctuation, Unicode and newline-separated text with original UTF-16 offsets', () => {
    const body = 'Olá!\n🙂 Consider profiling.\nNo punctuation\n!?';
    const units = bodyUnits(body);
    expect(units.map((unit) => body.slice(unit.start, unit.end))).toEqual(
      units.map((unit) => unit.text),
    );
    expect(
      units
        .map((unit) => unit.text)
        .join('')
        .replace(/\s/gu, ''),
    ).toBe(body.replace(/\s/gu, ''));
  });
  it('preserves whitespace-only matching and blocks translated factual claims', () => {
    const spaced = quote.replaceAll(' ', '  ');
    expect(
      evaluate(spaced, 'personal_fact', [link(spaced)]).report.blocked,
    ).toBe(false);
    const translated = 'Eu construí uma aplicação de relatórios sintética.';
    expect(
      evaluate(translated, 'personal_fact', [link(translated)]).report
        .findings[0]?.status,
    ).toBe('plausible_paraphrase');
  });
});
