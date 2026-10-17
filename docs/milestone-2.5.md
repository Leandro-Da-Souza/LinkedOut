# Milestone 2.5: accepted research to grounded drafts

An accepted content idea can initiate drafting through CLI or MCP. Acceptance expresses editorial interest and authorizes generating about that topic only. It never approves the generated draft, publishing, messaging, or any external action. Every generated draft requires human review. No publishing, scheduling, additional agent workflow, or public fetching is implemented here.

## First live accepted-idea experiment

Use Node 24.16+ within Node 24, with dependencies installed from the committed lockfile. Configure `OPENAI_API_KEY` and `OPENAI_MODEL` in your private environment or `.env`. Use the same profile/data/knowledge configuration as the original research run. No credentials belong in command arguments.

```sh
npm run build
npm run ideas -- list
npm run ideas -- get IDEA_UUID
npm run ideas -- review IDEA_UUID --status accepted
npm run ideas -- draft IDEA_UUID --idempotency-key idea-draft-live-001
```

Replace `IDEA_UUID` with an existing idea's ID after inspecting its evidence. The last command can incur **two paid model calls**, generation and independent assessment, and can send relevant private excerpts to the configured model. The implementation's automated tests make no paid calls. Optional `--audience TEXT`, `--tone TEXT`, and `--language TEXT` override profile preferences.

Inspect the returned draft and run IDs:

```sh
npm run drafts -- get DRAFT_UUID
npm run runs -- get RUN_UUID
```

If the result is blocked, its error includes `reviewArtifactId` when a valid candidate was retained:

```sh
npm run artifacts -- get ARTIFACT_UUID
npm run runs -- list
```

Repeating the draft command with the same key and unchanged acceptance, effective preferences, model configuration, and evidence replays the saved result without model calls. Private retrieval still runs to detect changes. Rejected/deleted ideas cannot replay through the drafting tool; existing drafts remain available through `drafts get`. A failed key does not retry. Inspect the failure before deliberately choosing a new key. Changed inputs under a key conflict. Without a key, independent drafts are allowed.

Existing research ideas are sufficient; fresh research is not part of this experiment. If there are no ideas, the separate `research run` workflow must first create some and can incur its own model call.

MCP exposes the same service as `draft_from_idea` with `{ ideaId, idempotencyKey?, audience?, tone?, language? }`. It requires `draft_local`; acceptance remains `review_content_idea`, requiring `review_local`. Tool arguments cannot supply source URLs, evidence, approval, or credentials. The bounded drafting agent continues to allow only `draft_post`.

## Evidence, representation, and grounding

The application resolves an idea against its immutable originating research result and persisted item revision. It validates identity, hash consistency, dates, allowlisted source URL, original source policy, and exact accepted quotation membership before retrieval/generation. Original source policies are retained; current application configuration explicitly authorizes `model_drafting` and `local_attributed_quotation`. Historical planning permission alone does not authorize drafting.

Existing research content hashes cover the full normalized release notes, while persisted excerpts can be truncated. Validation compares the frozen snapshot against its retained revision and records a separate hash of the drafting evidence; it does not claim to reconstruct full-note hashes or independently verify publisher claims. Historical quotation selection is preserved if valid.

The first implementation assembles this fixed representation:

```text
Publisher report: <repository> — <original publication date>
“<exact accepted quotation>”
Source: <stored URL>

<model-written commentary>
```

This block is an **attributed research attachment/intermediate representation**, not the desired final LinkedIn prose format. `publicCitations` separately preserves the quote, URL, publisher, dates, content hash, and UTF-16 attachment/quote spans. Future editorial workflows can separate evidence from prose without rediscovering it. No new rendering system is introduced.

The application writes all public attribution. The model returns commentary and warnings only, with no public citation fields. Public quotations retain their original language. Public factual restatement/paraphrase in commentary is blocked when classified as factual; this intentionally conservative first version admits personal facts only with existing exact private-source attribution and otherwise advice/opinion/questions without factual premises.

One fresh private retrieval uses configured topic aliases and supplies at most six passages/6000 characters. The idea's historical private quotation is not silently reused; its absence from current retrieval produces a warning. Profile interests and writing samples are style/configuration, never factual evidence. Public research never enters the private index or private `claims` collection. Public I/we/our refers to the publisher, not the local user.

Independent assessment covers every commentary unit. Existing private attribution and heuristic checks remain active. Public attachment spans are application-owned and deterministically recorded separately from assessed commentary spans. Reports hash the assembled body and both evidence contexts. Human review remains required: source matching proves attribution, not truth, and semantic assessment can miss disguised factual assertions.

## Persistence and lifecycle

Migration 5 adds idea review revisions and research-to-draft run links. Existing records and historical assessment versions remain readable without rewriting their payloads or inventing review events. Each status transition increments the revision; repeating the same status does not. Existing accepted ideas start at revision zero after migration and remain eligible after validation.

The shared drafting service owns one run/reservation and atomically commits its draft/result or blocked artifact/failure. It snapshots profile, private knowledge, accepted public evidence, policy, and originating research/idea/acceptance revision. It uses the existing owner/key namespace and fingerprints those semantic inputs plus generation versions. Public age/revision warnings are observations and do not invalidate otherwise matching replay. Direct and agent drafting retain their existing versions and behavior.

Acceptance is checked transactionally at reservation and completion. A concurrent rejection or reject/reaccept cycle blocks success, retaining a valid generated body privately. Completion also revalidates the original snapshot and current source policy. No database transaction spans retrieval or a model request.

Public evidence is never refreshed during drafting:

- An original publication outside the originating lookback window is allowed with an age warning.
- A more recently observed different local revision is warned about; it never replaces accepted evidence.
- Remote changes/deletion remain unknown. Every draft discloses lack of live revalidation.
- Missing, deleted, malformed, or inconsistent snapshots block generation.
- Empty private retrieval allows commentary without personal facts; operational retrieval failures do not fall back to historical evidence.

Deleting a research run retains derived drafts, blocked artifacts, execution snapshots, and frozen evidence. The deletion response lists retained derivative run/draft/artifact IDs. New drafting is impossible once the idea is deleted, but existing artifacts remain readable. Deletion is refused while a linked draft run is active/interrupted. This is logical deletion, not complete evidence erasure; existing retention limitations for SQLite free pages, backups, and request snapshots still apply.

A blocked artifact is never a successful draft. Valid candidates are retained after invalid assessment, cancellation, review changes, or final-length failure. An overlength candidate may exceed the successful-draft 3000-character ceiling in its private artifact; it is bounded by the generation contract plus the bounded attachment and is never truncated or promoted.

## Bounds and verification

The workflow makes at most one generation and one assessment operation, no planning call, no tools, and no SDK retries. Generation and assessment retain 2000/6000 output-token limits and 30-second request timeouts, within the configured overall deadline (default 120 seconds). Each serialized model input plus instructions is capped at 40,000 UTF-8 bytes. The assembled successful draft is at most 3000 UTF-16 characters. Truncation is never used to force a candidate under the limit.

Tests use synthetic temporary knowledge, real SQLite, actual CLI subprocesses, the official MCP client over serialized streams, mocked service providers, and the real OpenAI SDK with local HTTP response fixtures. They cover migration/history compatibility, evidence separation, public-to-personal claim rejection, citation spans, idempotency, concurrent review changes, deletion retention, blocked artifacts, cancellation, request bounds, and no-retry behavior. No automated test verifies live OpenAI behavior or independent truth of research claims.

Deferred: natural-prose public paraphrasing, new renderers, refreshed/revised idea generation, automatic retries/recovery, artifact editing, publication approval workflows, publishing, and scheduling.
