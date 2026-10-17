import type { GeneratedBody, GeneratedDraft } from '../domain/contracts.js';
import type { KnowledgeContext } from '../domain/knowledge.js';
import type { AssessmentReport } from '../domain/assessment.js';
import {
  editorialAssessmentSchema,
  RESEARCH_ASSESSMENT_VERSION,
  RESEARCH_DRAFT_VERSION,
  RESEARCH_GROUNDING_VERSION,
  RESEARCH_SEGMENTATION_VERSION,
  type ResearchDraftContext,
  type ResearchClaimCitation,
} from '../domain/research-draft.js';
import { privateQuote, isWholeSentence } from './private-evidence.js';
import { digest } from './assessment.js';
import { editorialHeuristic } from './grounding.js';

import { sentenceUnits as editorialUnits } from './sentence-units.js';
export { editorialUnits };

/** One canonical grounding pass. Semantic judgments are proposals, never bindings. */
export function assessEditorial(
  body: GeneratedBody,
  knowledge: KnowledgeContext,
  research: ResearchDraftContext,
  raw: unknown,
): { report: AssessmentReport; claims: GeneratedDraft['claims'] } {
  const units = editorialUnits(body.body);
  const citations: ResearchClaimCitation[] = [];
  const report: AssessmentReport = {
    version: RESEARCH_ASSESSMENT_VERSION,
    policyVersion: RESEARCH_GROUNDING_VERSION,
    segmentationVersion: RESEARCH_SEGMENTATION_VERSION,
    researchPolicyVersion: RESEARCH_DRAFT_VERSION,
    publicEvidenceHash: research.evidenceHash,
    publicCitations: citations,
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
  const diagnose = (
    reason: NonNullable<AssessmentReport['diagnostics']>[number]['reason'],
    unitId?: string,
  ) => {
    if (report.diagnostics!.length < 200)
      report.diagnostics!.push({ reason, ...(unitId ? { unitId } : {}) });
  };
  const parsed = editorialAssessmentSchema.safeParse(raw);
  if (!parsed.success) diagnose('INVALID_SCHEMA');
  if (units.length > 200) diagnose('UNIT_LIMIT');
  if (parsed.success) {
    const known = new Set(units.map((u) => u.id));
    if (parsed.data.units.some((u) => !known.has(u.id)))
      diagnose('UNKNOWN_UNIT');
    for (const unit of units) {
      const matches = parsed.data.units.filter((u) => u.id === unit.id);
      if (matches.length === 0) diagnose('MISSING_UNIT', unit.id);
      if (matches.length > 1) diagnose('DUPLICATE_UNIT', unit.id);
      if (matches.length !== 1) continue;
      const a = matches[0]!;
      const publicCategory = [
        'publisher_claim',
        'interpretation',
        'speculation',
      ].includes(a.category);
      const validEvidence =
        a.evidenceKind === 'private'
          ? a.category === 'personal_fact' && a.privateSourceIndex !== null
          : a.privateSourceIndex === null &&
            (a.evidenceKind === 'public'
              ? publicCategory
              : a.support !== 'supported');
      const validSupport =
        a.support === 'supported'
          ? a.evidenceKind !== 'none' && a.reason === null
          : a.support === 'not_applicable'
            ? a.evidenceKind === 'none' &&
              !['publisher_claim', 'personal_fact', 'uncertain'].includes(
                a.category,
              ) &&
              a.reason === null
            : a.reason !== null;
      if (!validEvidence || !validSupport)
        diagnose('INVALID_COMBINATION', unit.id);
      if (
        a.evidenceKind === 'private' &&
        !knowledge.sources[a.privateSourceIndex!]
      )
        diagnose('INVALID_SOURCE', unit.id);
    }
    if (
      parsed.data.units.filter(
        (u) =>
          u.evidenceKind !== 'none' ||
          ['uncertain', 'personal_fact', 'publisher_claim'].includes(
            u.category,
          ),
      ).length > 20
    )
      diagnose('FINDING_LIMIT');
    if (!report.diagnostics!.length) {
      report.complete = true;
      for (const [index, unit] of units.entries()) {
        const a = parsed.data.units.find((u) => u.id === unit.id)!;
        report.units[index]!.category = a.category;
        if (a.support === 'uncertain' || a.category === 'uncertain')
          report.issues.push('UNCERTAIN_CONTENT');
        if (a.support === 'unsupported') report.issues.push('UNSUPPORTED_FACT');
        if (a.reason) diagnose(a.reason, unit.id);
        if (a.evidenceKind === 'none') {
          if (a.support !== 'not_applicable')
            report.findings.push({
              unitId: unit.id,
              start: unit.start,
              end: unit.end,
              category: a.category,
              status: 'unsupported',
            });
          continue;
        }
        const source =
          a.evidenceKind === 'private'
            ? knowledge.sources[a.privateSourceIndex!]
            : undefined;
        const quote =
          source && isWholeSentence(body.body, unit.start, unit.end)
            ? privateQuote(unit.text, source.excerpt)
            : undefined;
        const supported = a.support === 'supported';
        const status = !supported
          ? 'unsupported'
          : source
            ? quote
              ? 'exact_match'
              : 'invalid_reference'
            : 'assessed_supported';
        report.findings.push({
          unitId: unit.id,
          start: unit.start,
          end: unit.end,
          category: a.category,
          status,
          ...(quote && source && supported
            ? { sourceId: source.id, quote }
            : {}),
        });
        if (status === 'invalid_reference')
          report.issues.push('INVALID_REFERENCE');
        if (status === 'exact_match')
          claims.push({ text: unit.text, sourceId: source!.id, quote: quote! });
        if (status === 'assessed_supported')
          citations.push({
            kind: 'research_claim',
            verification: 'publisher_reported',
            itemId: research.item.id,
            publicEvidenceHash: research.evidenceHash,
            unitId: unit.id,
            start: unit.start,
            end: unit.end,
            relationship: a.category as ResearchClaimCitation['relationship'],
          });
      }
    }
  }
  if (!report.complete) report.issues.push('INVALID_ASSESSMENT');
  // Use occurrence spans, not text replacement. Even a supported public claim is
  // checked for personal ownership, regardless of the assessor's label.
  for (const [index, unit] of units.entries()) {
    const finding = report.findings.find((f) => f.unitId === unit.id);
    if (finding?.status === 'exact_match') continue;
    const diagnostic = editorialHeuristic(
      unit.text,
      index,
      finding?.status === 'assessed_supported',
    );
    if (diagnostic) {
      report.issues.push('HEURISTIC_FLAG');
      report.heuristicDiagnostic ??= diagnostic;
      if (finding?.status === 'assessed_supported') {
        finding.status = 'unsupported';
        const citationIndex = citations.findIndex((c) => c.unitId === unit.id);
        if (citationIndex !== -1) citations.splice(citationIndex, 1);
        diagnose('OWNERSHIP_TRANSFER', unit.id);
      }
    }
  }
  report.issues = [...new Set(report.issues)];
  report.blocked = report.issues.length > 0;
  return { report, claims };
}
