import type { GeneratedDraft, UserProfile } from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';
import type { KnowledgeContext } from '../domain/knowledge.js';

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

function reject(): never {
  // Never interpolate model output, excerpts, filenames, or provider errors.
  throw new AppError(
    'UNGROUNDED_OUTPUT',
    'The generated draft contains unsupported personal claims or invalid evidence links. Revise the brief or provide relevant factual knowledge.',
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
  for (const claim of output.claims) {
    const text = normalize(claim.text);
    const quote = normalize(claim.quote);
    const source = context.sources.find((entry) => entry.id === claim.sourceId);
    if (
      !source ||
      text.length < 12 ||
      quote.length < 12 ||
      text !== quote ||
      !normalize(source.excerpt).includes(quote) ||
      !body.includes(text)
    ) {
      reject();
    }
    // Remove only exact attributed spans; adjacent unsupported claims remain.
    remaining = remaining.split(text).join(' ');
  }

  for (const sentence of remaining.split(/(?<=[.!?])\s+|\n+/u)) {
    if (
      personalAction.test(sentence) ||
      personalRole.test(sentence) ||
      projectAction.test(sentence)
    ) {
      reject();
    }
    // General questions can ask for evidence without asserting its existence.
    if (!sentence.trim().endsWith('?') && metric.test(sentence)) reject();
  }

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

  return {
    output: { ...output, warnings },
    review: {
      required: true,
      grounding:
        output.claims.length > 0 ? 'evidence_linked' : 'no_personal_claims',
      limitations,
    },
  };
}
