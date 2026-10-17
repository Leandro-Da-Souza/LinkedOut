# Milestone 2.6: evidence-grounded editorial drafting

Accepted research ideas now produce editorial prose with structured public citations. The body no longer contains the large release-note attachment. Ordinary drafting retains its existing contracts, prompts, grounding and idempotency fingerprints.

## Independent generation and assessment

Generation returns only `body` and `warnings`. It cannot provide authoritative classifications, support decisions, citations or approval. Extra output fields fail validation. The application sends the same bounded public evidence projection to generation and a separate assessment operation: repository, title/tag, original date, retained excerpt and publisher-reported status. It does not send the full research provenance to the generation model. The retained excerpt is at most 2400 characters; facts beyond it cannot be supported. The accepted quotation remains in provenance but is no longer the evidence boundary.

The assessor receives application-created units and current private sources separately. Its strict response supplies each unit's category, evidence kind, optional private source array index, support decision and nullable enum reason. Categories distinguish publisher claims, personal facts, interpretation, speculation, pure opinion/advice/questions and uncertainty. It supplies no public source identifiers, quotations, offsets or approval.

The application validates complete unit coverage, unknown/duplicate IDs, source selections and allowed category/support combinations before accepting any bindings. Public evidence binds only to the single frozen snapshot. Personal facts require exact whole-unit private source matching; quotations and source IDs are derived by the application. Mixed personal/public attribution is blocked. A question or advice sentence with factual premises still needs support. Unsupported or uncertain premises, altered quantities, omitted qualifications and ownership transfers block the candidate when identified by assessment. Semantic support remains a model judgment, not deterministic proof; a mistaken supported classification can escape checks. The application does not claim numerical overlap proves entailment.

Research units use the pinned Node runtime's sentence segmenter plus explicit newline boundaries, preserving UTF-16 offsets and technical tokens such as `v0.40.5`, `3.5` and decimals. One canonical research grounding pass applies personal ownership checks even to supported public units. Only exact private units are exempt from personal checks. Supported public spans bypass generic project/metric heuristics; unbound occurrences remain checked independently. The ordinary drafting path is unchanged.

Generation guidance favors 120–180 words where appropriate to the requested language, short paragraphs, one observation and a reflective takeaway. This is a style target, not a new rejection rule. There are no polishing or repair calls.

## Representation and review

New `publicCitations` entries have `kind: research_claim`, application-owned body/unit spans, item ID, public evidence hash, `verification: publisher_reported`, and a relationship of `publisher_claim`, `interpretation` or `speculation`. These refer to `provenance.research`, which preserves source URL, dates, content hash, retained excerpt, accepted quotation and policy. No fictitious quote spans are attached to paraphrased prose. Interpretation and speculation are not presented as publisher assertions.

The assessment stores its own versions, body and evidence hashes, findings and safe diagnostics. Source attribution and assessed support do not establish independent truth. Every draft still requires human review. A blocked artifact remains private and non-publishable. The legacy `review.grounding` field describes private personal claims; inspect public citations and assessment for public grounding.

Diagnostics contain bounded enums and application-known unit identifiers/positions. Logs and errors do not include model text or source excerpts; explicit draft/artifact retrieval remains private and can return those contents.

## Compatibility and lifecycle

New research requests fingerprint editorial, assessment, segmentation and grounding versions. Existing JSON storage supports both citation/report versions without migration or rewriting historical payloads. Research results are unchanged.

An explicitly recognized Milestone 2.5 request fingerprint can replay its original saved draft, previous failure or in-progress outcome. The application reconstructs that fingerprint from current effective inputs and checks the persisted research lineage. It does not regenerate or reassess old results. Changed private evidence, public snapshot/policy, profile/preferences, model or acceptance revision conflicts. Unknown historical fingerprints are not accepted. A new key deliberately selects the current editorial pipeline.

Acceptance and source permissions remain checked at reservation/completion; rejected or deleted ideas cannot replay through the drafting tool. Existing drafts/artifacts remain readable. Atomic commits, concurrent reject/reaccept protection, deletion restrictions and retained derivatives are unchanged. No transaction spans retrieval or a model call.

CLI/MCP arguments and permissions are unchanged. `draft_from_idea` and `ideas draft` share the service. No public refresh, publishing, external action or approval operation is added.

## Bounds and local verification

One generation and one separate assessment operation, no SDK retries, 2000/6000 output-token limits, 30-second request timeouts and the configured overall deadline remain. Inputs plus instructions are capped at 40000 UTF-8 bytes. Private retrieval remains at most six passages/6000 characters; successful prose is at most 3000 UTF-16 characters. Assessment is bounded to 200 units and 20 factual findings. Candidates exceeding the unit budget are rejected before assessment.

Tests use synthetic temporary knowledge, real SQLite, fixture providers, the real OpenAI SDK with local HTTP responses, actual CLI subprocesses and the official MCP client. They do not use live credentials or real private knowledge. Tests validate contract enforcement and wiring; they do not establish live model accuracy or editorial quality.

A synthetic editorial example for human review:

> The publisher reports tool calling and context up to 1 million tokens in Synthetic 3.5 Super.
>
> I would start with one small tool-use task rather than a broad feature tour. What interests me is whether a longer input changes the decisions worth inspecting—not simply whether the input fits.
>
> The outcome is still an open question.

Review the distinction between the reported specification, the proposed experiment and the absence of claimed personal results. This is an illustrative editorial sample, not live-provider verification.

## Fresh Ollama research drafting experiment

Use Node 24.16+ within Node 24 and configure the existing private OpenAI environment settings. “Ollama” here identifies the research source; drafting uses the configured OpenAI provider. These commands can incur two paid model calls and were not run as part of local verification.

```sh
npm run build
npm run ideas -- get ed5914ad-a11d-4085-91bc-51757f3fa6ce
npm run ideas -- review ed5914ad-a11d-4085-91bc-51757f3fa6ce --status accepted
npm run ideas -- draft ed5914ad-a11d-4085-91bc-51757f3fa6ce --idempotency-key ollama-editorial-m26-001
```

Use a fresh key if that key has already been used. Inspect the returned IDs:

```sh
npm run drafts -- get DRAFT_UUID
npm run runs -- get RUN_UUID
# If blocked, use the reviewArtifactId returned with the error:
npm run artifacts -- get ARTIFACT_UUID
```

Inspect prose, each public body span and its frozen source, assessment reasons and human-review warnings. No new research run or live source revalidation is required. If the historical idea has been deleted, select another available Ollama idea with `npm run ideas -- list` and inspect it before acceptance.
