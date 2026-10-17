import { createHash } from 'node:crypto';
import {
  assessmentSchema,
  ASSESSMENT_VERSION,
  SEGMENTATION_VERSION,
  GROUNDING_POLICY_VERSION,
} from '../domain/assessment.js';
import type { AssessmentReport } from '../domain/assessment.js';
import type {
  GeneratedBody,
  GeneratedDraft,
  UserProfile,
} from '../domain/contracts.js';
import type { KnowledgeContext } from '../domain/knowledge.js';
import { publicError } from '../domain/errors.js';
import { privateQuote, isWholeSentence } from './private-evidence.js';
import { groundDraft } from './grounding.js';
import { sentenceUnits as bodyUnits } from './sentence-units.js';
export { bodyUnits };

export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim();

export function assessBody(
  body: GeneratedBody,
  knowledge: KnowledgeContext,
  profile: UserProfile,
  raw: unknown,
  researchCommentary = false,
): { report: AssessmentReport; claims: GeneratedDraft['claims'] } {
  const units = bodyUnits(body.body);
  const report: AssessmentReport = {
    version: ASSESSMENT_VERSION,
    segmentationVersion: SEGMENTATION_VERSION,
    policyVersion: GROUNDING_POLICY_VERSION,
    bodyHash: digest(body.body),
    knowledgeHash: digest(knowledge),
    complete: false,
    blocked: true,
    findings: [],
    units: units.map(({ id, start, end }) => ({
      unitId: id,
      start,
      end,
      category: null,
    })),
    diagnostics: [],
    issues: [],
  };
  const claims: GeneratedDraft['claims'] = [];
  const parsed = assessmentSchema.safeParse(raw);
  const diagnose = (
    reason: NonNullable<AssessmentReport['diagnostics']>[number]['reason'],
    unitId?: string,
  ) => {
    if (report.diagnostics!.length >= 200) return;
    report.diagnostics!.push({ reason, ...(unitId ? { unitId } : {}) });
  };
  if (!parsed.success) diagnose('INVALID_SCHEMA');
  if (units.length > 200) diagnose('UNIT_LIMIT');
  if (parsed.success) {
    const canonical = new Set(units.map((unit) => unit.id));
    const byId = new Map<string, typeof parsed.data.units>();
    let unknown = false;
    for (const assessed of parsed.data.units) {
      if (!canonical.has(assessed.id)) {
        unknown = true;
        continue;
      }
      const entries = byId.get(assessed.id) ?? [];
      entries.push(assessed);
      byId.set(assessed.id, entries);
    }
    if (unknown) diagnose('UNKNOWN_UNIT');
    for (const unit of report.units) {
      const entries = byId.get(unit.unitId) ?? [];
      if (entries.length === 0) diagnose('MISSING_UNIT', unit.unitId);
      else if (entries.length > 1) diagnose('DUPLICATE_UNIT', unit.unitId);
      else {
        const assessed = entries[0]!;
        unit.category = assessed.category;
        if (
          assessed.category === 'advice_opinion_question' &&
          assessed.evidence !== null
        )
          diagnose('CONTRADICTORY_ADVICE', unit.unitId);
      }
    }
    if (
      parsed.data.units.filter(
        (unit) => unit.category !== 'advice_opinion_question',
      ).length > 20
    )
      diagnose('FINDING_LIMIT');
    // Finish all structural validation before trusting any proposed evidence.
    if (report.diagnostics!.length === 0) {
      for (const unit of units) {
        const assessed = byId.get(unit.id)![0]!;
        if (assessed.category === 'uncertain')
          report.issues.push('UNCERTAIN_CONTENT');
        if (assessed.category === 'advice_opinion_question') continue;
        if (researchCommentary && assessed.category === 'general_fact')
          report.issues.push('UNSUPPORTED_FACT');
        const evidence = assessed.evidence;
        const source = knowledge.sources.find(
          (entry) => entry.id === evidence?.sourceId,
        );
        const status =
          evidence === null
            ? 'unsupported'
            : !source ||
                normalize(evidence.quote).length < 12 ||
                !privateQuote(evidence.quote, source.excerpt) ||
                !isWholeSentence(body.body, unit.start, unit.end)
              ? 'invalid_reference'
              : normalize(unit.text).length >= 12 &&
                  normalize(unit.text) === normalize(evidence.quote)
                ? 'exact_match'
                : 'plausible_paraphrase';
        report.findings.push({
          unitId: unit.id,
          start: unit.start,
          end: unit.end,
          category: assessed.category,
          status,
          ...(source && evidence && status !== 'invalid_reference'
            ? { sourceId: source.id, quote: evidence.quote }
            : {}),
        });
        if (status === 'exact_match')
          claims.push({
            text: unit.text,
            sourceId: source!.id,
            quote: evidence!.quote,
          });
        else
          report.issues.push(
            status === 'unsupported'
              ? 'UNSUPPORTED_FACT'
              : status === 'invalid_reference'
                ? 'INVALID_REFERENCE'
                : 'PARAPHRASE_REQUIRES_REVIEW',
          );
      }
      report.complete = true;
    }
  }
  if (!report.complete) report.issues.push('INVALID_ASSESSMENT');
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
