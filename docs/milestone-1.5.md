# Milestone 1.5: private factual knowledge

## Small architectural extension

The shared drafting service depends on a small `KnowledgeReader` interface. Its implementation scans the private `knowledge/` tree, extracts readable text, and maintains a separate derived SQLite FTS5 index inside that directory. The existing draft database and MCP tools remain intact. An agent run retrieves one evidence snapshot from the original brief and passes that same snapshot to the shared drafting handler.

PDF extraction uses the maintained [Poppler library](https://poppler.pages.freedesktop.org/poppler-web-page/) through its `pdftotext` utility. This works locally without a new npm dependency, a renderer, browser, network endpoint or handwritten PDF parser. The tradeoff is an OS-level dependency and PDF layout limitations. Extraction is a separate process with fixed arguments, no shell, no inherited credentials, ignored raw stderr, a timeout, private temporary files and bounded input/pages/output. Scanned PDFs require separate local OCR; encrypted or malformed documents produce safe diagnostic codes. Markdown/plain text use strict UTF-8 decoding without executing or fetching document content.

[SQLite FTS5](https://www.sqlite.org/fts5.html) provides token matching and BM25 ranking. No embeddings, vectors, semantic search framework, learned memory or additional server is introduced. Lexical search can miss synonyms and short technology names; use explicit project/technology terms and inspect `knowledge search` results. Selection is capped at six passages/6000 characters, with at most two passages per document, rather than feeding every document to the model.

Content hashes identify revisions, and chunk identifiers include the document/revision. Unchanged files reuse extracted passages; edits, removals, malformed replacements and unsafe links stop supplying old evidence. Both drafting modes include the snapshot in idempotency fingerprints. A changed knowledge corpus conflicts with an old key rather than silently replaying a stale draft. This is conservative: an unrelated file edit can also change the corpus revision.

## Grounding and review contract

Generation requests add `knowledge: { revision, sources, issues }`. Sources contain an identifier, document identifier, relative path, file hash, excerpt, and page or line location. Raw PDFs are never sent; only selected passages enter the request (a short document may fit within a passage). Knowledge does not enter the planner prompt. Preferences in `user.json` remain separate and are never accepted as factual evidence.

Model output adds `claims: [{ text, sourceId, quote }]`. Each personal/project-specific factual claim must be a verbatim span from a retrieved source, present in the generated body, with a valid identifier. Local checks reject fabricated IDs, altered quotations, unsupported numerical metrics and detected unquoted personal/project assertions. The policy deliberately rejects paraphrases: exact quotation is inspectable and does not pretend to solve semantic entailment.

Every new draft adds `review.required: true`, evidence-link status, limitations, deterministic missing-evidence/retrieval warnings, and the evidence snapshot in provenance. General advice without personal claims may be drafted without matching knowledge. Rejected unsupported outputs create failed execution records and no successful draft. Historical milestone-one drafts remain readable without migration; they do not retroactively gain a grounding review.

This is a conservative guard, not a proof of truth or a universal hallucination detector. References can be wrong, outdated, contradictory or incomplete. Unquoted-claim detection uses English heuristics; indirect assertions and other languages require careful human review. Evidence links establish attribution, not independent verification. Do not describe `review.grounding` as factual certification. Review CV extraction order, exact quotations, implications, roles, dates and metrics before sharing.

Retrieved documents, filenames, Markdown links and instructions inside excerpts stay untrusted data. They cannot grant tool permissions, choose credentials, approve actions or expand the agent's one-call budget. Existing LinkedIn restrictions and future explicit approval boundaries remain unchanged.

## Private storage and operating limits

Sources, extracted passages, FTS indexes, journals and temporary extraction files live under ignored `knowledge/`. The public `knowledge.example/` contains instructions only and is never indexed by default. `.linkedout/` retains private provenance/execution snapshots; removing a source does not purge historical drafts, database free space or backups. Git ignore rules prevent ordinary accidental additions, not `git add --force`, pre-existing tracked files, or disclosure through screenshots/terminal output.

The index follows no symbolic links and accepts only regular supported files. Limits: 100 documents, directory depth eight, 8 MiB per file, 32 MiB total source bytes per refresh, 500000 extracted characters/100 PDF pages per document and 5000 passages overall. Invalid documents are skipped individually, with safe identifier/code diagnostics and missing-evidence warnings; malformed content is not silently treated as a fact. PDF extraction has a 15-second deadline and participates in drafting cancellation. It is not a hardened OS sandbox.

`npm run knowledge -- index` refreshes the cache and returns counts/diagnostics. `npm run knowledge -- search --query "..."` previews local evidence without credentials or model calls. Drafting refreshes automatically. Use an absolute `LINKEDOUT_KNOWLEDGE_DIR` ending in `knowledge` for MCP clients launched from another working directory. Keep the folder ignored in any containing repository. See [knowledge organization and setup](../knowledge.example/README.md).

## Verification

Automated tests cover real synthetic PDF extraction and page references; Markdown/text decoding; malformed, empty, missing-parser and oversized inputs; source edits/deletions; FTS search sanitization/ranking/budgets; unknown/mismatched citations; invented personal claims; mandatory review; both drafting modes and idempotency; no remote fetching; safe diagnostics/logs; and actual Git ignore behavior in an isolated repository. No personal CV is committed or used as a fixture.

Linux CI installs Poppler and sets `LINKEDOUT_REQUIRE_PDF_TESTS=1` so PDF tests cannot silently skip. On other hosts those extraction tests report an explicit skip if the native utility is missing; text/Markdown and missing-tool tests still run. Existing OpenAI SDK fixtures remain deterministic and do not establish live model grounding quality. Live generation verification remains subject to configured model access and network availability.

Local verification on October 14, 2026: build, strict type checking, lint and formatting checks passed; `LINKEDOUT_REQUIRE_PDF_TESTS=1 npm test` passed 136 tests across eight files. Two subprocess-pipe tests were explicitly skipped because this sandbox denies Node child-process pipes; official-client serialized stdio tests, keyless production retrieval after restart and CLI subprocess tests passed. Real Poppler extraction ran, not a PDF mock. Live OpenAI verification remains outstanding: `api.openai.com` DNS resolution returned `EAI_AGAIN`. Remote CI and live model grounding quality have not been verified here.
