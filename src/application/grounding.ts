import type { GeneratedDraft, UserProfile } from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';
import type { GroundingDiagnostic } from '../domain/errors.js';
import type { KnowledgeContext } from '../domain/knowledge.js';

import { privateQuote } from './private-evidence.js';

const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const action =
  '(?:built|led|worked|managed|launched|created|developed|delivered|implemented|designed|founded|co-founded|achieved|increased|decreased|reduced|saved|earned|won|shipped|invented|completed|served|maintained|oversaw|introduced|migrated|scaled|improved|learned|joined|graduated|studied|trained|mentored|hired|spearheaded|architected)';
const personalAction = new RegExp(
  `\\b(?:I|we)\\s+(?:(?:have|had|successfully|personally|previously|recently|once|also)\\s+){0,3}${action}\\b|\\b(?:my|our)\\b[^.!?]{0,100}\\b${action}\\b`,
  'iu',
);
const personalRole =
  /\b(?:I|we)\s+(?:am|are|was|were|have been|had been)\s+(?:an?\s+)?(?:\w+\s+){0,3}(?:engineer|developer|founder|manager|director|lead|consultant|architect|responsible|employed|working|building|leading)|\b(?:I|we)\s+(?:have|had)\s+(?:\w+\s+){0,3}(?:experience|clients|customers|employees|users)|\b(?:my|our)\s+(?:experience|career|background|role|project|product|company)\s+(?:is|was|includes|involves|has|had)\b/iu;
const projectAction = new RegExp(
  `\\b(?:this|my|our|the)\\s+(?:project|product|application|app|platform|company|team|system)\\b[^.!?]{0,100}\\b${action}\\b|\\b(?:project|product|platform)\\s+[A-Z][\\w-]*(?:\\s+[A-Z][\\w-]*)?\\s+${action}\\b`,
  'iu',
);
const metric =
  /(?:\d(?:[\d,.]*\d)?\s*(?:%|percent\b|years?\b|months?\b|users?\b|customers?\b|clients?\b|employees?\b|dollars?\b|million\b|billion\b|revenue\b|hours?\b)|[$€£]\s*\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\s+(?:years?|months?|users?|customers?|clients?|employees?|dollars?|hours?)\b)/iu;
// A bounded imperative form, not a blanket exemption for sentences containing
// advice. Anchor the whole sentence so appended accomplishments still fail.
const keepRunningAdvice =
  /^\s*Keep the (?:application|app|platform|system) running while (?:new )?components are (?:developed|built)[.!]?\s*$/iu;
const issueCodes = new Set([
  'MALFORMED_FILE',
  'NO_READABLE_TEXT',
  'PDF_TOOL_UNAVAILABLE',
  'LIMIT_EXCEEDED',
  'UNSAFE_PATH',
  'UNREADABLE_FILE',
  'NO_MATCHES',
  'EMPTY_KNOWLEDGE',
]);

function reject(diagnostic: GroundingDiagnostic): never {
  // Never interpolate model output, excerpts, filenames, or provider errors.
  throw new AppError(
    'UNGROUNDED_OUTPUT',
    'The generated draft contains unsupported personal claims or invalid evidence links. Revise the brief or provide relevant factual knowledge.',
    diagnostic,
  );
}

/** Conservative attribution checks, not a truth detector or entailment engine. */
export function groundDraft(
  output: GeneratedDraft,
  context: KnowledgeContext,
  profile: UserProfile,
): {
  output: GeneratedDraft;
  review: {
    required: true;
    grounding: 'evidence_linked' | 'no_personal_claims';
    limitations: string[];
  };
} {
  // Deliberately not used as evidence: preferences cannot authorize claims.
  void profile;
  const body = normalize(output.body);
  let remaining = body;
  for (const [index, claim] of output.claims.entries()) {
    const text = normalize(claim.text);
    const quote = normalize(claim.quote);
    const source = context.sources.find((entry) => entry.id === claim.sourceId);
    if (!source) reject({ scope: 'claim', reason: 'UNKNOWN_SOURCE', index });
    if (text.length < 12)
      reject({ scope: 'claim', reason: 'CLAIM_TOO_SHORT', index });
    if (quote.length < 12)
      reject({ scope: 'claim', reason: 'QUOTE_TOO_SHORT', index });
    if (text !== quote)
      reject({ scope: 'claim', reason: 'QUOTE_MISMATCH', index });
    if (!privateQuote(quote, source.excerpt))
      reject({ scope: 'claim', reason: 'QUOTE_NOT_IN_SOURCE', index });
    const occurrences = [
      ...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(body),
    ]
      .map(({ segment }) => segment.trim())
      .filter((segment) => segment.includes(text));
    if (
      occurrences.length === 0 ||
      occurrences.some(
        (segment) => segment.replace(/^[“"*>]+\s*|\s*[”"*]+$/gu, '') !== text,
      )
    )
      reject({ scope: 'claim', reason: 'CLAIM_NOT_IN_BODY', index });
    // Remove only exact attributed spans; adjacent unsupported claims remain.
    remaining = remaining.split(text).join(' ');
  }

  for (const [index, sentence] of remaining
    .split(/(?<=[.!?])\s+|\n+/u)
    .entries()) {
    if (personalAction.test(sentence))
      reject({
        scope: 'sentence',
        reason: 'UNSUPPORTED_PERSONAL_ACTION',
        index,
      });
    if (personalRole.test(sentence))
      reject({ scope: 'sentence', reason: 'UNSUPPORTED_PERSONAL_ROLE', index });
    if (projectAction.test(sentence) && !keepRunningAdvice.test(sentence))
      reject({
        scope: 'sentence',
        reason: 'UNSUPPORTED_PROJECT_ACTION',
        index,
      });
    // General questions can ask for evidence without asserting its existence.
    if (!sentence.trim().endsWith('?') && metric.test(sentence))
      reject({ scope: 'sentence', reason: 'UNSUPPORTED_METRIC', index });
  }

  return groundingReview(output, context);
}

/** Review metadata only; performs no additional grounding pass. */
export function groundingReview(
  output: GeneratedDraft,
  context: KnowledgeContext,
  requiredWarnings: readonly string[] = [],
) {
  const limitations = [
    'Human review is required. Source attribution does not verify document truth, completeness, or every implied claim.',
    'Automated unsupported-claim checks are conservative English heuristics; review other languages and indirect claims manually.',
    'Identity preferences and writing samples guide style and are not factual evidence.',
  ];
  const warnings = output.warnings.slice(0, 5);
  warnings.push(
    'Human review required: verify factual claims and source excerpts before publishing.',
  );
  if (context.sources.length === 0) {
    const warning =
      'No relevant factual knowledge was retrieved. Personal experiences and project-specific achievements must not be asserted without evidence.';
    warnings.push(warning);
    limitations.push(warning);
  }
  if (output.claims.length === 0 && context.sources.length > 0) {
    warnings.push(
      'No personal factual claims were linked to the retrieved evidence.',
    );
  }
  const codes = [...new Set(context.issues.map((issue) => issue.code))].filter(
    (code) => issueCodes.has(code),
  );
  if (codes.length > 0)
    warnings.push(`Knowledge review issues: ${codes.join(', ')}.`);

  warnings.push(
    ...requiredWarnings.filter((warning) => !warnings.includes(warning)),
  );
  return {
    output: { ...output, warnings },
    review: {
      required: true as const,
      grounding:
        output.claims.length > 0
          ? ('evidence_linked' as const)
          : ('no_personal_claims' as const),
      limitations,
    },
  };
}

/** Public attribution never exempts a unit from personal ownership checks. */
export function editorialHeuristic(
  text: string,
  index: number,
  publicSupported: boolean,
): GroundingDiagnostic | undefined {
  const experience =
    /\b(?:I|we)\s+(?:(?:have|had|recently|personally|already)\s+){0,3}(?:used|tested|deployed|evaluated|adopted|ran|measured|tried|observed|found|discovered|experienced)\b/iu;
  const reason =
    personalAction.test(text) || experience.test(text)
      ? 'UNSUPPORTED_PERSONAL_ACTION'
      : personalRole.test(text)
        ? 'UNSUPPORTED_PERSONAL_ROLE'
        : !publicSupported &&
            projectAction.test(text) &&
            !keepRunningAdvice.test(text)
          ? 'UNSUPPORTED_PROJECT_ACTION'
          : !publicSupported && !text.trim().endsWith('?') && metric.test(text)
            ? 'UNSUPPORTED_METRIC'
            : undefined;
  return reason ? { scope: 'sentence', reason, index } : undefined;
}
