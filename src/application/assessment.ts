import { createHash } from 'node:crypto';
import {
  assessmentSchema,
  ASSESSMENT_VERSION,
  GROUNDING_POLICY_VERSION,
} from '../domain/assessment.js';
import type { AssessmentReport, BodyUnit } from '../domain/assessment.js';
import type {
  GeneratedBody,
  GeneratedDraft,
  UserProfile,
} from '../domain/contracts.js';
import type { KnowledgeContext } from '../domain/knowledge.js';
import { publicError } from '../domain/errors.js';
import { groundDraft } from './grounding.js';

export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Stable UTF-16 offsets, including punctuation; every non-whitespace character is covered. */
export function bodyUnits(body: string): BodyUnit[] {
  return [...body.matchAll(/[^\n.!?]+(?:[.!?]+|(?=\n|$))|[.!?]+/gu)]
    .filter((match) => match[0].trim())
    .map((match, index) => ({
      id: `u${index}`,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    }));
}

export function assessBody(
  body: GeneratedBody,
  knowledge: KnowledgeContext,
  profile: UserProfile,
  raw: unknown,
): { report: AssessmentReport; claims: GeneratedDraft['claims'] } {
  const units = bodyUnits(body.body);
  const report: AssessmentReport = {
    version: ASSESSMENT_VERSION,
    policyVersion: GROUNDING_POLICY_VERSION,
    bodyHash: digest(body.body),
    knowledgeHash: digest(knowledge),
    complete: false,
    blocked: true,
    findings: [],
    units: [],
    issues: [],
  };
  const claims: GeneratedDraft['claims'] = [];
  const parsed = assessmentSchema.safeParse(raw);
  const invalid = () => {
    report.issues.push('INVALID_ASSESSMENT');
    return { report, claims: [] };
  };
  if (
    !parsed.success ||
    units.length > 200 ||
    parsed.data.units.length !== units.length
  )
    return invalid();
  const seen = new Set<string>();
  for (const assessed of parsed.data.units) {
    const unit = units.find((candidate) => candidate.id === assessed.id);
    if (!unit || seen.has(unit.id)) return invalid();
    seen.add(unit.id);
    report.units.push({
      unitId: unit.id,
      start: unit.start,
      end: unit.end,
      category: assessed.category,
    });
    if (assessed.category === 'uncertain')
      report.issues.push('UNCERTAIN_CONTENT');
    if (
      assessed.category !== 'advice_opinion_question' &&
      assessed.claims.length === 0
    )
      report.issues.push('UNSUPPORTED_FACT');
    let previousEnd = -1;
    for (const claim of assessed.claims) {
      if (
        claim.start < 0 ||
        claim.end <= claim.start ||
        claim.end > unit.text.length ||
        claim.start < previousEnd ||
        report.findings.length >= 20
      )
        return invalid();
      previousEnd = claim.end;
      const text = unit.text.slice(claim.start, claim.end);
      const source = knowledge.sources.find(
        (entry) => entry.id === claim.sourceId,
      );
      const status =
        claim.sourceId === null && claim.quote === null
          ? 'unsupported'
          : !source ||
              !claim.quote ||
              normalize(claim.quote).length < 12 ||
              !normalize(source.excerpt).includes(normalize(claim.quote))
            ? 'invalid_reference'
            : normalize(text).length >= 12 &&
                normalize(text) === normalize(claim.quote)
              ? 'exact_match'
              : 'plausible_paraphrase';
      report.findings.push({
        unitId: unit.id,
        start: unit.start + claim.start,
        end: unit.start + claim.end,
        category: assessed.category,
        status,
        ...(source && claim.quote && status !== 'invalid_reference'
          ? { sourceId: source.id, quote: claim.quote }
          : {}),
      });
      if (status === 'exact_match')
        claims.push({ text, sourceId: source!.id, quote: claim.quote! });
      else
        report.issues.push(
          status === 'unsupported'
            ? 'UNSUPPORTED_FACT'
            : status === 'invalid_reference'
              ? 'INVALID_REFERENCE'
              : 'PARAPHRASE_REQUIRES_REVIEW',
        );
    }
  }
  report.complete = true;
  // Inspect each uncovered occurrence, not a global string replacement that could
  // accidentally hide a second, unattributed occurrence of the same words.
  let remaining = body.body;
  for (const finding of [...report.findings]
    .filter((entry) => entry.status === 'exact_match')
    .sort((a, b) => b.start - a.start)) {
    remaining =
      remaining.slice(0, finding.start) +
      ' '.repeat(finding.end - finding.start) +
      remaining.slice(finding.end);
  }
  try {
    groundDraft(
      { body: remaining, warnings: [], claims: [] },
      knowledge,
      profile,
    );
  } catch (error) {
    report.issues.push('HEURISTIC_FLAG');
    const diagnostic = publicError(error).groundingDiagnostic;
    if (diagnostic) report.heuristicDiagnostic = diagnostic;
  }
  report.issues = [...new Set(report.issues)];
  report.blocked = report.issues.length > 0;
  return { report, claims };
}
