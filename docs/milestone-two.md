# Milestone 2: release-to-idea research

The first slice discovers public GitHub releases without a writing brief, ranks them deterministically, retrieves bounded private context, and makes at most one model call to select editorial lenses and optional private-evidence indices. The application constructs exact evidence quotations. It persists up to five review-required ideas. It does not draft posts, schedule jobs, publish, or automate LinkedIn.

## First live run

Use Node 24.16+ within Node 24. Configure `OPENAI_API_KEY` and `OPENAI_MODEL` in your existing private `.env` or environment. The model must support Responses structured outputs. Do not put credentials in command arguments. Optional `LINKEDOUT_PROFILE_PATH` and `LINKEDOUT_KNOWLEDGE_DIR` select your existing private profile and knowledge; relevant private excerpts can be sent to the configured model.

From the repository root:

```sh
npm ci
npm run build
npm run research -- sources
npm run research -- run --lookback-days 14 --idempotency-key research-first-live-001
npm run ideas -- list
npm run runs -- list
```

The research run makes public GitHub requests and, if eligible unseen releases exist, one paid model request. No model request is made for an empty shortlist. No paid requests were used in automated verification.

A 14-day window can legitimately return no ideas. For a wider **new** run:

```sh
npm run research -- run --lookback-days 90 --idempotency-key research-first-live-002
```

Publication dates remain the original dates. A wider window does not make older developments recent. `--lookback-days` accepts integers 7–90; the default is `LINKEDOUT_RESEARCH_LOOKBACK_DAYS`, or 14 when unset.

Replay the first command with the same explicit lookback and key to obtain its immutable historical result. It returns `execution: "historical_replay"` and makes no public requests, private retrievals, or model calls. This also works without provider credentials after restarting. Changing the explicit lookback under that key conflicts. Changing current profile, default lookback, model, or knowledge does not alter history. For fresh research, use a new key or omit the key.

```sh
npm run ideas -- get IDEA_UUID
npm run ideas -- review IDEA_UUID --status rejected
npm run ideas -- list --status rejected
npm run research -- items --limit 20
npm run research -- get ITEM_UUID
npm run runs -- get RUN_UUID
```

Replace UUID placeholders with returned IDs. Review states are `proposed`, `accepted`, and `rejected`; acceptance is editorial interest, never publication approval. Current idea reads reflect later reviews; historical replay retains the original result and review state.

## Architecture and evidence

`ResearchWorkflow` is a fixed application service, separate from the one-tool drafting agent. CLI and MCP call the shared registry. `ResearchFeed` and `ResearchPlanner` are domain interfaces. GitHub fetching and OpenAI serialization live in infrastructure. SQLite migration 4 adds research items/revisions, run-item links, source caches, immutable results, ideas, and review history. Existing drafting migrations and result semantics remain intact.

The six fixed sources are `microsoft/TypeScript`, `react/react`, `vuejs/core`, `vitejs/vite`, `ollama/ollama`, and `modelcontextprotocol/typescript-sdk`. Access uses GitHub's documented public releases API without authentication. Repository selection, primary-source classification, permitted local/model uses, and retention policy are application-owned configuration in `RESEARCH_SOURCES`; tool arguments cannot supply source URLs. Adding a source requires reviewing its origin and permitted uses. Public accessibility does not grant unrestricted redistribution.

Each item preserves repository/release identity, URL, original publication field, parsed publication date/date quality, retrieval timestamp, normalized excerpt, truncation flag, content hash, and source policy. A new collection validates unchanged cached entries with ETags; a failed fetch never substitutes cached research. Cached `retrievedAt` records the latest successful retrieval/revalidation. Each completed result separately freezes the evidence used by that execution.

Official release notes are **publisher-reported**, not independently verified. Personal evidence stays in a distinct field with its private source ID and exact quote. Profile interests are preferences, not achievements. Quotes are checked against the supplied public/private excerpts; matching an excerpt does not establish truth. No model-authored factual summary is stored.

Selection excludes drafts, prereleases, absent/invalid/future dates, notes shorter than 20 characters, and developments already represented by an idea. Deduplication uses repository/release identity across runs, including rejected ideas and revised release notes. It also deduplicates identical revision hashes within a run. No title-similarity detector is included. Stable identity suppression is intentionally stronger than rejection alone: accepted and proposed ideas remain available for review instead of being regenerated.

Scoring is versioned and deterministic:

- Topic: 20 for the allowlisted priority project, plus 10 per profile-interest alias match, capped at 40.
- Significance: 5 per matched release-note signal (`breaking`, `security`, `deprecat`, `migration`, `support`, `feature`), capped at 25.
- Recency: linear decay from 20 to zero over the selected lookback.
- Personal relevance: 5 per retrieved passage matching a project's aliases, capped at 15.

Signals are stored and visible; keyword scores are editorial heuristics, not proof of importance. Candidates are ranked before the model, with at most one release per repository and two per primary topic. The model selects from four editorial lenses (migration checklist, architectural tradeoffs, local experiment, team discussion) and returns only an angle and an optional zero-based private-evidence index for each candidate in input order. It does not reproduce source identifiers or quotations. The application constructs English question templates. Profile language is retained in preferences but this slice's displayed templates are English.

### Application-owned evidence and temporary prefix limitation

New runs use `research-v2-app-evidence`. The application binds each ordered response entry to its selected public candidate and constructs the public quotation from the first at most 800 UTF-16 code units of its frozen excerpt. It avoids a trailing unmatched high surrogate and does not normalize whitespace or append an ellipsis. Each quotation must be at least 20 code units and an exact substring of the original source.

Private options use the same prefix strategy, excluding passages shorter than 20 code units. The model sees the bounded options, returns an index or null, and never supplies private identifiers or quotations. The application checks index bounds, validates the chosen quotation, and applies the existing project-alias relevance check to the offered prefix. It resolves the original private source ID and provenance locally. Public and private evidence remain in separate fields.

**Temporary limitation:** the 800-character prefix can omit useful context or cut a sentence. It is a source preview, not independent verification or evidence for a model-authored claim. A relevant term after the prefix does not make the offered private excerpt eligible. No evidence-ranking or semantic excerpt-selection infrastructure is added. Deterministic candidate ranking still uses the existing retrieved passages.

Historical successful results are replayed unchanged, including their original quotations. Historical failures are not reconstructed or relabelled; the original live failure's exact rejected rule remains unknown.

## Limits and failures

- Six serial public GETs maximum per new run; one page of 20 releases per source. Pagination truncation is reported as partial coverage.
- No public-request retries in this slice. Each source has a 10-second deadline; the configured application deadline also applies (default 120 seconds).
- Decode at most 1 MiB per response and 6 MiB per run. No redirects, asset downloads, recursive links, HTML execution, or arbitrary destinations.
- At most five public excerpts of 2400 characters; one private retrieval, at most six passages/6000 characters across the run.
- One model operation with no tools or SDK retries, maximum 2500 output tokens, and a 30,000-byte serialized input/instruction cap. Oversized input fails explicitly. Actual usage is recorded when returned. There is no dollar-denominated ceiling or automatic pricing lookup.
- Persistent origin-wide cooldown after GitHub 403/429 responses respects `Retry-After` and rate-reset headers, with a minimum 60-second wait before a later run. A 403 can also mean denied access; diagnostics deliberately report both possibilities.
- Some failed or truncated sources produce a partial result with per-source diagnostics. All sources unavailable fail the run. No qualifying releases produces a successful empty result. Refusals, invalid evidence, and incomplete model output fail without fabricated alternatives.

Research validation failures now carry `groundingDiagnostic` with `scope: "research"`, an allowlisted `stage` and `reason`, and a zero-based idea `index` (or null for response-wide failures). Validation reports the first rejected rule: schema before count; public quote length before exact-source membership; private selection bounds before quote validation and candidate relevance. SDK JSON/schema parsing failures use a response-wide schema diagnostic.

These diagnostics are stored atomically with failed status in both existing run and execution records, including research `INVALID_OUTPUT` failures. Inspect them with `npm run runs -- get RUN_UUID`. CLI error output and MCP tool errors expose the same allowlisted fields; repeating a failed keyed request also exposes its stored diagnostic without new work. No raw model responses, rejected values, source IDs, quotations, or private paths are included. Existing drafting diagnostic behavior and database schema are unchanged.

For another live attempt after a failed key, use a new key:

```sh
npm run build
npm run research -- run --lookback-days 14 --idempotency-key research-evidence-v2-live-001
npm run ideas -- list
npm run runs -- list
```

The live command can incur one paid model request when eligible unseen candidates exist. Use a different new key for subsequent fresh attempts.

CLI signals and MCP cancellation propagate to fetching, private retrieval, and planning. A failed key cannot retry; use a new key deliberately. An abruptly interrupted reservation remains `running`/`IN_PROGRESS` for inspection. Automatic recovery and remote cancellation are deferred. Provider billing may be uncertain after interruption; no silent model retry occurs.

Unique-key reservations share the existing owner/key namespace with drafting. Idea/result completion is transactional. Concurrent distinct runs recheck release identities at commit, preventing duplicate ideas; they may each have incurred their single model call before commit. No transaction spans network/model work.

All retrieved strings are untrusted data. Neither release notes nor private passages can grant permissions, alter sources, or execute tools. Stored public text strips HTML tags and control characters. Logs contain allowlisted operational metadata only. Research requires `research_local`; review requires `review_local`; deletion requires `delete_local`. The research workflow never invokes review or deletion tools.

## Retention and deletion

Public items/caches without idea references expire after 90 days, pruned during a new research run. Evidence used by completed results, private snapshots, and review decisions remain in private `.linkedout/` storage until explicit deletion. No research material is added to `knowledge/` or treated as verified personal knowledge.

```sh
npm run research -- delete-run RUN_UUID
```

Deletion removes that completed/failed run's payload, ideas and reviews, associated public items not shared by other runs, and the public HTTP response cache (rate-limit cooldown remains enforced). It preserves safe execution history and the key tombstone, so replay reports deletion instead of regenerating. Deleting ideas also forgets their suppression/review decisions. Active/interrupted runs cannot be deleted through this command. Logical deletion does not erase SQLite free pages/WAL, backups, or externally copied outputs.

MCP exposes `research_run`, `list_research_sources`, `list_research_items`, `get_research_item`, `list_content_ideas`, `get_content_idea`, `review_content_idea`, and `delete_research_run`. All use the same services as the CLI. Lists omit private excerpts; explicit idea reads and run results include evidence.

## Verification and deliberate first-slice limits

Tests use synthetic private files, isolated SQLite databases, and local HTTP fixtures. The real OpenAI SDK is exercised with fixture responses, including bounded output, refusal, and no-retry behavior. Tests cover history replay, date windows, persistent rejection, evidence separation, invalid citations, rate-limit cooldown, ETag validation, unsafe URLs, oversized/malformed responses, ownership, concurrent reservations, deletion, migrations, actual CLI subprocesses, and the official MCP client over serialized stdio streams. Existing real-process MCP tests remain enabled on ordinary hosts and explicitly report sandbox `EPERM` where applicable.

Compared with the architecture proposal, this slice uses zero GET retries instead of one, fixed English editorial lenses instead of freeform generated angles, and token/byte/call limits instead of an optional monetary ceiling. These choices keep the failure and factual-validation surface small. Source adapters and model interfaces permit later extensions without widening the drafting agent.

Deferred: RSS/Atom and commentary sources, independent corroboration, title similarity, configurable source catalogs, automatic drafting from ideas, scheduling, automatic recovery, and all external social actions.
