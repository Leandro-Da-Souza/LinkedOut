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
    units: [{ id: 'u0', category, evidence: claims[0] ?? null }, ...extraUnits],
  });
const link = () => ({
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
    expect(evaluate(body, 'personal_fact', [link()]).report).toMatchObject({
      blocked: true,
      findings: [{ status: 'plausible_paraphrase' }],
    });
  });
  it.each([
    { sourceId: 'invented', quote },
    { sourceId, quote: 'I invented an unsupported source quotation.' },
    { sourceId, quote: quote.toUpperCase() },
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
      evaluate(body, 'general_fact', [null]).report.findings[0]?.status,
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
      [{ id: 'u1', category: 'advice_opinion_question', evidence: null }],
    );
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
    expect(
      evaluate(
        `${quote} ${quote}`,
        'personal_fact',
        [link()],
        [{ id: 'u1', category: 'advice_opinion_question', evidence: null }],
      ).report.blocked,
    ).toBe(true);
  });
  it.each(
    [
      [{ ...link(), start: -1 }],
      [{ ...link(), end: 9999 }],
      [{ ...link(), end: 10 }],
    ].map((claims) => ({ claims })),
  )('rejects legacy model-generated offsets', ({ claims }) => {
    expect(evaluate(quote, 'personal_fact', claims).report.issues).toContain(
      'INVALID_ASSESSMENT',
    );
  });
  it('requires complete unit coverage without duplicate or fabricated IDs', () => {
    for (const units of [
      [],
      [{ id: 'fake', category: 'advice_opinion_question', evidence: null }],
      [
        { id: 'u0', category: 'advice_opinion_question', evidence: null },
        { id: 'u0', category: 'advice_opinion_question', evidence: null },
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
    expect(evaluate(spaced, 'personal_fact', [link()]).report.blocked).toBe(
      false,
    );
    const translated = 'Eu construí uma aplicação de relatórios sintética.';
    expect(
      evaluate(translated, 'personal_fact', [link()]).report.findings[0]
        ?.status,
    ).toBe('plausible_paraphrase');
  });
});

describe('whole-unit assessment regressions', () => {
  const assess = (body: string, units: unknown[]) =>
    assessBody({ body, warnings: [] }, diagnosticKnowledge, profile, { units });
  const advice = (id: string) => ({
    id,
    category: 'advice_opinion_question',
    evidence: null,
  });

  it('rejects contradictory advice instead of ignoring its evidence', () => {
    const result = assess('Consider profiling before optimizing.', [
      { ...advice('u0'), evidence: link() },
    ]);
    expect(result.report).toMatchObject({
      complete: false,
      blocked: true,
      findings: [],
      diagnostics: [{ reason: 'CONTRADICTORY_ADVICE', unitId: 'u0' }],
      issues: ['INVALID_ASSESSMENT'],
    });
  });

  it.each([
    'Consider testing; I built an imaginary spaceship.',
    'I led a team that shipped an imaginary product.',
    'Our platform reduced costs.',
    'This saves 50 hours.',
  ])('does not let advice labels bypass existing heuristics: %s', (body) => {
    const result = assess(body, [advice('u0')]);
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
    expect(result.report.blocked).toBe(true);
  });

  it.each([
    'Consider this algorithm because it guarantees optimal performance.',
    'Does this system guarantee optimal performance?',
    'This approach eliminates compatibility problems.',
    'I built an imaginary spaceship.',
    'This saves 50 hours.',
  ])('blocks unsupported factual units, including premises: %s', (body) => {
    const result = assess(body, [
      { id: 'u0', category: 'general_fact', evidence: null },
    ]);
    expect(result.report.findings[0]?.status).toBe('unsupported');
    expect(result.report.issues).toContain('UNSUPPORTED_FACT');
  });

  it('cannot attribute only a convenient fragment of a mixed sentence', () => {
    const body =
      quote.slice(0, -1) +
      '; consider adopting it because it guarantees success.';
    const result = assess(body, [
      { id: 'u0', category: 'personal_fact', evidence: link() },
    ]);
    expect(result.report.findings[0]).toMatchObject({
      start: 0,
      end: body.length,
      status: 'plausible_paraphrase',
    });
    expect(result.report.blocked).toBe(true);
    expect(result.claims).toEqual([]);
  });

  it('owns offsets including leading spaces, Unicode and repeated occurrences', () => {
    const body = '🙂 Consider testing. ' + quote + ' ' + quote;
    const result = assess(body, [
      { id: 'u2', category: 'personal_fact', evidence: link() },
      advice('u0'),
      { id: 'u1', category: 'personal_fact', evidence: link() },
    ]);
    const canonical = bodyUnits(body);
    expect(result.report.blocked).toBe(false);
    expect(result.report.units.map((u) => u.unitId)).toEqual([
      'u0',
      'u1',
      'u2',
    ]);
    expect(
      result.report.findings.map((f) => ({ start: f.start, end: f.end })),
    ).toEqual(canonical.slice(1).map(({ start, end }) => ({ start, end })));
    expect(result.claims.map((c) => c.text)).toEqual(
      canonical.slice(1).map((u) => u.text),
    );
  });

  it('reports all coverage failures safely without partial evidence or skipped heuristics', () => {
    const body = quote + ' Consider testing. Consider profiling.';
    const result = assess(body, [
      { id: 'u0', category: 'personal_fact', evidence: link() },
      advice('u0'),
      advice('PRIVATE_MODEL_IDENTIFIER'),
    ]);
    expect(result.report).toMatchObject({
      complete: false,
      blocked: true,
      findings: [],
      units: bodyUnits(body).map(({ id, start, end }) => ({
        unitId: id,
        start,
        end,
        category: null,
      })),
    });
    expect(result.report.diagnostics).toEqual([
      { reason: 'UNKNOWN_UNIT' },
      { reason: 'DUPLICATE_UNIT', unitId: 'u0' },
      { reason: 'MISSING_UNIT', unitId: 'u1' },
      { reason: 'MISSING_UNIT', unitId: 'u2' },
    ]);
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
    expect(result.claims).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL_IDENTIFIER');
  });

  it('retains all units when a late result is malformed, without retaining raw output', () => {
    const body = Array.from({ length: 14 }, () => 'Consider testing.').join(
      ' ',
    );
    const units = bodyUnits(body).map((u) => advice(u.id));
    const result = assess(
      body,
      units.map((u, i) =>
        i === 6
          ? {
              ...u,
              claims: [{ start: 0, end: 9999, quote: 'PRIVATE_RAW_QUOTE' }],
            }
          : u,
      ),
    );
    expect(result.report.units).toHaveLength(14);
    expect(result.report.findings).toEqual([]);
    expect(result.report.diagnostics).toEqual([{ reason: 'INVALID_SCHEMA' }]);
    expect(result.report.issues).toEqual(['INVALID_ASSESSMENT']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW_QUOTE');
  });

  it.each([
    { sourceId: null, quote },
    { sourceId, quote: null },
    { sourceId, quote: 'x'.repeat(1501) },
  ])('rejects malformed evidence safely', (evidence) => {
    const result = assess(quote, [
      { id: 'u0', category: 'personal_fact', evidence },
    ]);
    expect(result.report.diagnostics).toEqual([{ reason: 'INVALID_SCHEMA' }]);
    expect(result.report.findings).toEqual([]);
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
  });

  it('deduplicates unsupported issues and enforces unit and finding limits', () => {
    const body = 'A factual assertion. Another factual assertion.';
    const result = assess(
      body,
      bodyUnits(body).map((u) => ({
        id: u.id,
        category: 'general_fact',
        evidence: null,
      })),
    );
    expect(result.report.issues).toEqual(['UNSUPPORTED_FACT']);
    const many = 'A factual assertion.'.repeat(21);
    expect(
      assess(
        many,
        bodyUnits(many).map((u) => ({
          id: u.id,
          category: 'general_fact',
          evidence: null,
        })),
      ).report.diagnostics,
    ).toEqual([{ reason: 'FINDING_LIMIT' }]);
    const excessive = 'Advice.'.repeat(201);
    expect(
      assess(
        excessive,
        bodyUnits(excessive).map((u) => advice(u.id)),
      ).report,
    ).toMatchObject({
      complete: false,
      blocked: true,
      findings: [],
      diagnostics: [{ reason: 'INVALID_SCHEMA' }, { reason: 'UNIT_LIMIT' }],
    });
  });
});
