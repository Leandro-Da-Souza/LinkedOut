# LinkedOut

LinkedOut turns a professional writing brief into a locally stored LinkedIn draft. It exposes the same drafting service through an MCP server, a CLI, and a bounded autonomous workflow. Milestone one uses OpenAI and requires no LinkedIn authentication.

The application creates drafts only. Milestone 1.5 adds private local factual knowledge for drafting. External research retrieval, scheduling, publishing, comments, messages, and LinkedIn account integrations are future work governed by [integration boundaries](docs/linkedin-boundaries.md).

## Setup

Use **Node.js 24.16 or newer within 24.x** and npm. Other Node major versions are outside this milestone's tested runtime contract.

```sh
npm ci
cp .env.example .env
cp examples/user.example.json user.json
npm run build
```

Edit `.env` to supply `OPENAI_API_KEY` and `OPENAI_MODEL`. The example model is `gpt-4.1-mini-2025-04-14`, which supports Responses, function calling, and structured outputs. Model access depends on your OpenAI account; there is no silent fallback. See [official model capabilities](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

To personalize drafts, set `LINKEDOUT_PROFILE_PATH` to your `user.json` path. The example profile contains fictional identity details; replace them before generation. A profile is optional: without one, LinkedOut uses a generic local profile. Explicitly configured missing or invalid files fail clearly.

The npm entry points load `.env` from the working directory. Environment variables already set by your shell take precedence. Windows users can use `Copy-Item` instead of `cp` in PowerShell.

## Private personal knowledge

Put your CV and optional project notes in the Git-ignored `knowledge/` directory. Supported formats are PDF, Markdown and UTF-8 plain text. The committed [knowledge.example guide](knowledge.example/README.md) explains organization and privacy; it contains no personal facts and is never automatically indexed. Keep identity/style preferences in `user.json` separate from factual references.

PDF extraction uses the maintained Poppler library's local `pdftotext` utility: install `poppler-utils` on Linux or `brew install poppler` on macOS. On Windows use a trusted Poppler distribution and add its `bin` directory to `PATH`. Text/Markdown work without the utility; malformed, encrypted, scanned or unavailable PDFs produce safe diagnostics.

```sh
npm run knowledge -- index
npm run knowledge -- search --query "TypeScript reporting project"
```

Drafting refreshes automatically and sends at most six relevant excerpts/6000 characters to generation and independent assessment, instead of attaching every document. Document links are never fetched. Evidence IDs, excerpts and hashes are saved in provenance. Changes to evidence invalidate old idempotency fingerprints.

Generation produces a body; an independent assessor then identifies claims in that immutable body. Application checks distinguish exact evidence matches, proposed paraphrases, unsupported assertions and invalid references. Only exact factual attribution can pass automatic checks; unresolved content fails with `UNGROUNDED_OUTPUT` and is retained as a private, non-publishable review artifact. Every new draft requires human review and surfaces missing evidence. Exact quotes do not prove truth, and heuristic checks cannot certify arbitrary prose or other languages. Review the [grounding tradeoffs](docs/milestone-1.5.md).

## Draft and retrieve

```sh
# Direct drafting: generation followed by assessment.
npm run drafts -- create --brief "Share three lessons from adopting TypeScript in a small team."

# Autonomous entry point: propose one tool call, then generate through the shared handler.
npm run agent -- run --brief "Draft a practical post about keeping code review feedback specific." --idempotency-key weekly-review-001

npm run drafts -- list --limit 20 --offset 0
npm run drafts -- get <draft-uuid>
npm run runs -- list
npm run runs -- get <run-uuid>
npm run artifacts -- list
npm run artifacts -- get <artifact-uuid>
npm run artifacts -- delete <artifact-uuid>
```

Commands return JSON. A stored draft has a UUID, body, warnings, fixed `draft` status, user/run IDs, timestamps, model metadata, and generation provenance including the profile snapshot and supplied input. Review its facts and wording before manually sharing it.

Both generation commands accept `--audience`, `--tone`, `--language`, and `--idempotency-key`. Writing samples come from the profile, or from `writingSamples` when using MCP.

Repeating the same request and key returns the stored result without another model call, including through the agent entry point. Changing input, profile, model, or generation settings under that key returns a conflict. Direct drafting and agent workflows share a key namespace, so switching modes requires a new key. An in-progress, interrupted, or failed request remains visible in history and is not automatically restarted. A new key can cause another paid generation. Database idempotency does not guarantee the provider billed only once.

## MCP server

```sh
npm run mcp
```

The server waits for an MCP client over stdio; it is not an interactive terminal command. stdout is reserved for MCP protocol messages; logs and runtime notices go to stderr.

Adapt [examples/mcp-client.json](examples/mcp-client.json) to your client's configuration format. Replace every placeholder with an absolute path, and use a Node 24 executable. Copy a personal profile first, or remove `LINKEDOUT_PROFILE_PATH` from the example. The configuration uses an `.env` file so the key need not be copied into client configuration. There is no network listener or remote authentication in this milestone.

| Tool          | Input                                                                                         | Result                       |
| ------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| `draft_post`  | Required `brief`; optional `audience`, `tone`, `language`, `writingSamples`, `idempotencyKey` | Stored draft and replay flag |
| `get_draft`   | `id` UUID                                                                                     | Stored draft                 |
| `list_drafts` | Optional `limit` (1–100), `offset`                                                            | Paginated draft summaries    |

Review artifacts are available through `list_review_artifacts` (pagination), `get_review_artifact` (`id`) and `delete_review_artifact` (`id`). They are separate from ordinary drafts. Lists return safe summaries; explicit retrieval returns private content/evidence. Deletion retains safe execution history and existing request snapshots; it does not securely erase database free space or backups.

Discovery and retrieval work without an OpenAI key. Generation requires both key and model. The user identity comes from local configuration, never tool arguments or model output. Per-request writing preferences override profile defaults; writing samples and briefs are treated as untrusted input.

## Configuration and privacy

| Variable                   | Purpose                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`           | Required for generation; never stored in drafts or logs                                |
| `OPENAI_MODEL`             | Explicit compatible model; required for generation                                     |
| `LINKEDOUT_DATA_DIR`       | Optional local storage directory; defaults to `.linkedout` under the working directory |
| `LINKEDOUT_PROFILE_PATH`   | Optional validated JSON profile; absolute path recommended                             |
| `LINKEDOUT_KNOWLEDGE_DIR`  | Optional private directory ending in `knowledge`; defaults to `./knowledge`            |
| `LINKEDOUT_RUN_TIMEOUT_MS` | Optional overall deadline; default 120000 ms                                           |

Profile fields are `id`, `name`, `headline`, `interests`, `audience`, `tone`, `language`, and `writingSamples`. Profiles allow at most 20 interests and three writing samples of 4000 characters each. Briefs allow at most 8000 characters; generated post bodies allow at most 3000 characters. Profiles are configuration, not learned memory.

SQLite stores drafts, blocked review artifacts, normalized inputs, profile snapshots, and execution history locally. Protect the data directory and backups as personal information; storage is not encrypted by the application. `.env`, personal `user.json`, and local data are ignored by Git. Logs contain sanitized operational metadata, not keys, briefs, writing samples, draft bodies, or raw provider errors.

OpenAI receives the brief, relevant profile information, and writing samples during generation and planning. Requests use `store: false`; this does not eliminate ordinary provider abuse-monitoring retention. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) before supplying sensitive content. Assessment separately sends the finished body and selected evidence, excluding profile and source paths. Drafting can incur API charges: direct drafting normally makes two model requests and the agent path three. SDK retries can add requests; there is no exact monetary spending cap.

## Verify

```sh
npm run typecheck
npm run lint
npm run format:check
npm test

# Opt-in paid verification, requiring real credentials and network access.
npm run smoke:live
```

Automated tests require no live credentials. They cover shared services, real SQLite persistence, idempotency, failures and permissions, and the official MCP client against the compiled stdio server. Local HTTP fixtures exercise the real OpenAI SDK with deterministic responses. These are not live OpenAI results.

The opt-in smoke command calls the real provider through MCP and the autonomous CLI entry point, then verifies both stored drafts through MCP after restarting the server. It normally makes five provider requests and retains the generated drafts in the configured data directory. A missing key, unavailable model, or network failure is reported as unsuccessful live verification; fixture responses are never substituted. CI is configured to run deterministic checks on Linux, macOS, and Windows; it does not run paid smoke tests.

## Troubleshooting and architecture

- **Generation configuration errors:** set both `OPENAI_API_KEY` and `OPENAI_MODEL`; retrieval does not need either.
- **MCP appears idle:** connect an MCP client; the server reads protocol messages from stdin.
- **Drafts seem missing:** use the same absolute `LINKEDOUT_DATA_DIR` in CLI and MCP. Different working directories produce different default storage locations.
- **Profile errors:** check its absolute path, JSON format, accepted fields, and size limits.
- **Timeout or interrupted run:** inspect execution history. LinkedOut does not silently retry a previously interrupted workflow.
- **SQLite runtime notice:** Node's built-in SQLite driver may emit an experimental notice to stderr. Node 24 is required.

See [architecture and tradeoffs](docs/architecture.md), [LinkedIn restrictions](docs/linkedin-boundaries.md), and [repository conventions](AGENTS.md). SQLite's built-in driver and minimal JSON logging are documented deviations from the original native-addon/Pino proposal, selected to permit complete local verification in the available offline environment.

See [milestone-one verification](docs/milestone-one.md) for the actual checks performed and outstanding live-provider verification. The project is [MIT licensed](LICENSE).
