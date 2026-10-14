# Milestone one: implementation and verification

Verified locally on October 13, 2026 with Node 24.16.0 and npm 12.2.0.

## Delivered

- Official MCP SDK v2 stdio server with `draft_post`, `get_draft`, and `list_drafts`.
- Shared validated tools/services used by MCP, direct CLI drafting, and a bounded agent workflow.
- Official OpenAI Responses SDK, structured draft output, strict tool calling, deadlines and bounded transport retries.
- Lightweight user identity/preferences JSON with profile snapshots and user-provided provenance.
- SQLite drafts and execution history, atomic commits, basic idempotency reserved before agent planning, and permission checks.
- Configuration examples, setup instructions, repository conventions, MIT license, and CI configuration for Linux/macOS/Windows.

No LinkedIn authentication, research retrieval, publishing, messaging, scheduler, approval engine, or advanced memory/recovery system is implemented. Future external actions and data imports retain the restrictions in [LinkedIn boundaries](linkedin-boundaries.md).

## Checks completed

Clean installation from the committed lockfile succeeded using an offline npm cache. Build, type checking, ESLint, and formatting checks passed. The automated suite passed **76 tests across five files**, with **two explicitly skipped subprocess-pipe tests** because this sandbox returns `EPERM`. Those tests remain enabled on ordinary hosts. GitHub Actions is configured; remote and other-OS runs have not been executed here.

The passing tests include actual SQLite persistence/reopen and transactional rollback, idempotency through two connections, preference overrides and identity partitioning, cancellation and failure records, bounded planning, strict OpenAI SDK serialization/parsing, and CLI subprocesses with regular-file output descriptors.

The official MCP client passed over serialized SDK stdio streams with both legacy and modern protocol negotiation. A shutdown test verified that an in-flight cancellation writes its failed audit record before SQLite closes.

An additional shell-launched server process passed official-client discovery, drafting, idempotent replay, listing and retrieval using protocol `2025-11-25`. Restarting the **production server** with no OpenAI credentials retrieved the same draft using protocol `2026-07-28`; the production CLI also listed it. Provider responses for this protocol check were clearly labeled deterministic HTTP fixtures through the real OpenAI SDK. They were not live OpenAI generations.

## Live verification outstanding

The live smoke command could not open Node subprocess pipes in this sandbox. An independent production CLI drafting attempt using the documented example model also failed: DNS lookup of `api.openai.com` returned `EAI_AGAIN`. The application recorded a failed provider run and stored no draft for that attempt. No live OpenAI success is claimed.

On a normal host with network access, configure the provider/model and run:

```sh
npm run smoke:live
```

This opt-in command makes paid provider requests through MCP and the autonomous CLI, then verifies retrieval after restart. The milestone's live-provider acceptance criterion remains unverified until that succeeds.

## Tradeoffs and next increment

The SQLite adapter uses built-in `node:sqlite` rather than the planned native addon, and operational logging uses an allowlisted JSON stderr writer instead of Pino. The native addon and Pino were unavailable offline. Node SQLite's release-candidate status and the supported Node 24 runtime are explicit; both adapters remain replaceable without changing drafting behavior. See [architecture](architecture.md).

Advanced leases/recovery are deferred. Failed or interrupted keyed requests require a deliberate new-key retry; API billing is not exactly-once. The agent executes one allowed drafting tool and preserves the original user brief. Its registry/provider interface accepts tool lists for later dynamic research workflows without adding an orchestration framework now.

The next implementation increment is authorized-source research with provenance and retention enforcement. Live provider verification should be completed before expanding autonomous behavior.
