import { describe, expect, it } from 'vitest';
import {
  assessEditorial,
  editorialUnits,
} from '../src/application/editorial-assessment.js';
import { digest } from '../src/application/assessment.js';
import { RESEARCH_SOURCES } from '../src/domain/research.js';
import type { ResearchDraftContext } from '../src/domain/research-draft.js';
import { EMPTY_KNOWLEDGE } from '../src/domain/knowledge.js';
import { diagnosticKnowledge } from './fixtures/grounding.js';

const excerpt =
  'Synthetic 3.5 Super supports tool calling and context up to 1M tokens. Synthetic 3.5 Bolt fits a 24 GB GPU. Cloud failures now have clearer messages.';
const policy = RESEARCH_SOURCES[4]!;
const research: ResearchDraftContext = {
  ideaId: 'synthetic-idea',
  researchRunId: 'synthetic-run',
  acceptanceRevision: 1,
  quote: excerpt.slice(0, 80),
  evidenceHash: digest(excerpt),
  policy,
  item: {
    id: 'synthetic-item',
    identity: 'ollama/ollama:1',
    repository: 'ollama/ollama',
    releaseId: 1,
    url: 'https://github.com/ollama/ollama/releases/tag/v0.40.5',
    title: 'v0.40.5',
    tag: 'v0.40.5',
    publishedAt: '2026-01-01T00:00:00Z',
    rawPublicationDate: '2026-01-01T00:00:00Z',
    retrievedAt: '2026-01-02T00:00:00Z',
    dateQuality: 'valid',
    contentHash: digest(excerpt),
    excerpt,
    prerelease: false,
    truncated: false,
    verification: 'publisher_reported',
    source: policy,
  },
};
const publicUnit = (id = 'u0') => ({
  id,
  category: 'publisher_claim',
  evidenceKind: 'public',
  privateSourceIndex: null,
  support: 'supported',
  reason: null,
});
const advice = (id = 'u0') => ({
  id,
  category: 'opinion_advice_question',
  evidenceKind: 'none',
  privateSourceIndex: null,
  support: 'not_applicable',
  reason: null,
});
const evaluate = (
  body: string,
  units: unknown[],
  knowledge = EMPTY_KNOWLEDGE,
) => assessEditorial({ body, warnings: [] }, knowledge, research, { units });

describe('independent editorial assessment and application bindings', () => {
  it('preserves technical tokens, original offsets, repeated text, Unicode and every non-whitespace character', () => {
    const body =
      '🙂 v0.40.5 introduces Synthetic 3.5 Super with 1.5M tokens.\r\nSee https://example.test/v0.40.5.\nRepeated. Repeated.\n!?';
    const units = editorialUnits(body);
    expect(units[0]!.text).toContain('Synthetic 3.5 Super with 1.5M');
    expect(units.map((u) => body.slice(u.start, u.end))).toEqual(
      units.map((u) => u.text),
    );
    expect(
      units
        .map((u) => u.text)
        .join('')
        .replace(/\s/gu, ''),
    ).toBe(body.replace(/\s/gu, ''));
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
  });
  it('accepts an assessed paraphrase with the metric qualification and application-owned citation', () => {
    const body =
      'Ollama reports that Synthetic 3.5 Super supports context up to 1 million tokens.';
    const { report, claims } = evaluate(body, [publicUnit()]);
    expect(report).toMatchObject({
      complete: true,
      blocked: false,
      bodyHash: digest(body),
      publicEvidenceHash: research.evidenceHash,
    });
    expect(claims).toEqual([]);
    expect(report.publicCitations).toEqual([
      {
        kind: 'research_claim',
        verification: 'publisher_reported',
        itemId: research.item.id,
        publicEvidenceHash: research.evidenceHash,
        unitId: 'u0',
        start: 0,
        end: body.length,
        relationship: 'publisher_claim',
      },
    ]);
    expect(report.findings[0]!.status).toBe('assessed_supported');
  });
  it.each([
    ['Synthetic 3.5 Super supports 2 million tokens.', 'QUANTITY_CHANGED'],
    [
      'Synthetic 3.5 Super has a 1 million token capability.',
      'QUALIFICATION_OMITTED',
    ],
    [
      'Could the new guaranteed zero-latency mode simplify deployment?',
      'UNSUPPORTED_PREMISE',
    ],
    ['This proves every deployment is reliable.', 'UNSUPPORTED_PREMISE'],
    [
      'The compact model might have the larger model’s specifications.',
      'AMBIGUOUS_ATTRIBUTION',
    ],
    ['I tested this on a 24 GB GPU.', 'OWNERSHIP_TRANSFER'],
  ])(
    'fails closed when the independent assessor rejects %s',
    (body, reason) => {
      const { report } = evaluate(body, [
        { ...publicUnit(), support: 'unsupported', reason },
      ]);
      expect(report.blocked).toBe(true);
      expect(report.publicCitations).toEqual([]);
      expect(report.diagnostics).toContainEqual({ reason, unitId: 'u0' });
    },
  );
  it.each([
    'publisher_claim',
    'opinion_advice_question',
    'interpretation',
    'speculation',
  ])('rejects ownership transfer even when mislabeled %s', (category) => {
    const a =
      category === 'opinion_advice_question'
        ? advice()
        : { ...publicUnit(), category };
    const result = evaluate('We tested this on a 24 GB GPU.', [a]);
    expect(result.report.issues).toContain('HEURISTIC_FLAG');
    expect(result.report.publicCitations).toEqual([]);
  });
  it('checks repeated occurrences independently and does not suppress adjacent unsupported metrics', () => {
    const sentence = 'This saves 50 hours.';
    const result = evaluate(sentence + ' ' + sentence, [
      publicUnit(),
      advice('u1'),
    ]);
    expect(result.report.heuristicDiagnostic).toMatchObject({
      reason: 'UNSUPPORTED_METRIC',
      index: 1,
    });
  });
  it('separates source-supported interpretation/speculation from publisher claims', () => {
    for (const category of ['interpretation', 'speculation']) {
      const result = evaluate(
        'With tool calling reported, I think a small experiment could be useful.',
        [{ ...publicUnit(), category }],
      );
      expect(result.report.blocked).toBe(false);
      expect(result.report.publicCitations![0]).toMatchObject({
        relationship: category,
      });
    }
    expect(
      evaluate('I would start with a small experiment.', [advice()]).report
        .blocked,
    ).toBe(false);
  });
  it('derives personal quotation and source identity only from current private evidence', () => {
    const source = diagnosticKnowledge.sources[0]!;
    const a = {
      ...publicUnit(),
      category: 'personal_fact',
      evidenceKind: 'private',
      privateSourceIndex: 0,
    };
    const result = evaluate(source.excerpt, [a], diagnosticKnowledge);
    expect(result.report.blocked).toBe(false);
    expect(result.claims).toEqual([
      { text: source.excerpt, sourceId: source.id, quote: source.excerpt },
    ]);
    expect(result.report.publicCitations).toEqual([]);
    expect(
      evaluate('I built an imaginary spaceship.', [a], diagnosticKnowledge)
        .report.blocked,
    ).toBe(true);
    expect(
      evaluate(
        source.excerpt,
        [{ ...a, evidenceKind: 'public', privateSourceIndex: null }],
        diagnosticKnowledge,
      ).report.blocked,
    ).toBe(true);
  });
  it.each([
    { ...publicUnit(), evidenceKind: 'none' },
    { ...publicUnit(), support: 'not_applicable' },
    { ...publicUnit(), privateSourceIndex: 0 },
    { ...publicUnit(), category: 'opinion_advice_question' },
    { ...publicUnit(), category: 'personal_fact' },
    { ...publicUnit(), reason: 'UNSUPPORTED_PREMISE' },
    { ...publicUnit(), support: 'uncertain' },
    { ...advice(), category: 'uncertain' },
    {
      ...publicUnit(),
      category: 'personal_fact',
      evidenceKind: 'private',
      privateSourceIndex: 5,
    },
  ])('rejects contradictory or invalid evidence selections: %j', (unit) => {
    const result = evaluate('A complete assertion.', [unit]);
    expect(result.report).toMatchObject({
      complete: false,
      blocked: true,
      publicCitations: [],
      findings: [],
    });
  });
  it.each(
    [
      [],
      [publicUnit(), publicUnit()],
      [publicUnit('SECRET_MODEL_ID')],
      [{ ...publicUnit(), quote: 'SECRET_QUOTE' }],
      [{ ...publicUnit(), start: 0 }],
      [{ ...publicUnit(), approved: true }],
      [{ ...publicUnit(), privateSourceIndex: 99 }],
      [{ ...publicUnit(), reason: 'SECRET_RAW_REASON' }],
    ].map((units) => ({ units })),
  )(
    'fails closed on invalid wire output without persisting raw diagnostics',
    ({ units }) => {
      const result = evaluate('A complete assertion.', units);
      expect(result.report.blocked).toBe(true);
      expect(result.report.publicCitations).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('SECRET');
    },
  );
  it('bounds units and factual findings', () => {
    const many = 'A complete assertion. '.repeat(21);
    expect(
      evaluate(
        many,
        editorialUnits(many).map((u) => publicUnit(u.id)),
      ).report.diagnostics,
    ).toContainEqual({ reason: 'FINDING_LIMIT' });
    const excessive = 'Consider testing.\n'.repeat(201);
    expect(evaluate(excessive, []).report.diagnostics).toContainEqual({
      reason: 'UNIT_LIMIT',
    });
  });
});

it('records unsupported facts without inventing a source selection', () => {
  for (const category of ['publisher_claim', 'personal_fact', 'uncertain']) {
    const result = evaluate('An unsupported factual assertion.', [
      {
        ...advice(),
        category,
        support: 'uncertain',
        reason: 'AMBIGUOUS_ATTRIBUTION',
      },
    ]);
    expect(result.report).toMatchObject({
      complete: true,
      blocked: true,
      findings: [{ status: 'unsupported' }],
    });
    expect(result.report.issues).toContain('UNCERTAIN_CONTENT');
    expect(result.report.publicCitations).toEqual([]);
  }
});

import {
  misleadingExcerpts,
  personalClaim,
} from './fixtures/private-evidence.js';

it.each(misleadingExcerpts)(
  'rejects contextual or substring ownership from %s',
  (excerpt) => {
    const knowledge = {
      ...diagnosticKnowledge,
      sources: [{ ...diagnosticKnowledge.sources[0]!, excerpt }],
    };
    const result = evaluate(
      personalClaim,
      [
        {
          ...publicUnit(),
          category: 'personal_fact',
          evidenceKind: 'private',
          privateSourceIndex: 0,
        },
      ],
      knowledge,
    );
    expect(result.report.blocked).toBe(true);
    expect(result.report.findings[0]?.status).toBe('invalid_reference');
    expect(result.claims).toEqual([]);
    expect(result.report.publicCitations).toEqual([]);
  },
);

it('preserves exact private Unicode, punctuation and source whitespace', () => {
  const excerpt = 'I built the café pipeline — with `Type<T>` and ≤4 workers.';
  const knowledge = {
    ...diagnosticKnowledge,
    sources: [
      {
        ...diagnosticKnowledge.sources[0]!,
        excerpt: excerpt.replaceAll(' ', '\t'),
      },
    ],
  };
  const result = evaluate(
    excerpt,
    [
      {
        ...publicUnit(),
        category: 'personal_fact',
        evidenceKind: 'private',
        privateSourceIndex: 0,
      },
    ],
    knowledge,
  );
  expect(result.report.blocked).toBe(false);
  expect(result.claims[0]).toEqual({
    text: excerpt,
    quote: knowledge.sources[0]!.excerpt,
    sourceId: knowledge.sources[0]!.id,
  });
});

it.each(['Alex said:\n', 'It is false that\n', 'A.'])(
  'does not sever body attribution at %s',
  (prefix) => {
    const body = prefix + personalClaim;
    const knowledge = {
      ...diagnosticKnowledge,
      sources: [{ ...diagnosticKnowledge.sources[0]!, excerpt: personalClaim }],
    };
    const result = evaluate(
      body,
      editorialUnits(body).map((unit) => ({
        ...publicUnit(unit.id),
        category: 'personal_fact',
        evidenceKind: 'private',
        privateSourceIndex: 0,
      })),
      knowledge,
    );
    expect(result.report.blocked).toBe(true);
    expect(result.claims).toEqual([]);
  },
);
