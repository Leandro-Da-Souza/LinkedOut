import type { GeneratedDraft } from '../../src/domain/contracts.js';
import type { GroundingDiagnostic } from '../../src/domain/errors.js';
import type { KnowledgeContext } from '../../src/domain/knowledge.js';

// Synthetic evidence only. Never load the user's private knowledge in tests.
const quote = 'I built a synthetic reporting application.';
const claim = { text: quote, quote, sourceId: 'synthetic-source' };
export const diagnosticKnowledge: KnowledgeContext = {
  revision: 'synthetic-revision',
  sources: [
    {
      id: claim.sourceId,
      documentId: 'synthetic-document',
      path: 'synthetic.md',
      contentHash: 'synthetic-hash',
      excerpt: quote,
      page: null,
      startLine: 1,
    },
  ],
  issues: [],
};

export const rejectionCases: {
  diagnostic: GroundingDiagnostic;
  output: GeneratedDraft;
}[] = [
  ...(
    [
      ['UNKNOWN_SOURCE', { ...claim, sourceId: 'PRIVATE_UNKNOWN_SOURCE' }],
      ['CLAIM_TOO_SHORT', { ...claim, text: 'short' }],
      ['QUOTE_TOO_SHORT', { ...claim, quote: 'short' }],
      [
        'QUOTE_MISMATCH',
        { ...claim, text: 'I developed a reporting application.' },
      ],
      [
        'QUOTE_NOT_IN_SOURCE',
        {
          ...claim,
          text: 'PRIVATE_INVENTED_QUOTE',
          quote: 'PRIVATE_INVENTED_QUOTE',
        },
      ],
      ['CLAIM_NOT_IN_BODY', claim],
    ] as const
  ).map(([reason, invalidClaim]) => ({
    diagnostic: { scope: 'claim' as const, reason, index: 1 },
    output: {
      // For the absent-body case use a valid first claim on a shorter span.
      body:
        reason === 'CLAIM_NOT_IN_BODY'
          ? 'synthetic reporting application.'
          : quote,
      claims: [
        reason === 'CLAIM_NOT_IN_BODY'
          ? {
              ...claim,
              text: 'synthetic reporting application.',
              quote: 'synthetic reporting application.',
            }
          : claim,
        invalidClaim,
      ],
      warnings: [],
    },
  })),
  ...(
    [
      ['UNSUPPORTED_PERSONAL_ACTION', 'I built PRIVATE_ACCOMPLISHMENT.'],
      ['UNSUPPORTED_PERSONAL_ROLE', 'I am a senior engineer.'],
      [
        'UNSUPPORTED_PROJECT_ACTION',
        'The application delivered substantial savings.',
      ],
      ['UNSUPPORTED_METRIC', 'It saved 500 hours.'],
    ] as const
  ).map(([reason, sentence]) => ({
    diagnostic: { scope: 'sentence' as const, reason, index: 1 },
    output: {
      body: `General reflection. ${sentence}`,
      claims: [],
      warnings: [],
    },
  })),
];
