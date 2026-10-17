# Interrupted-run recovery

A process crash can leave a reserved research, drafting, or agent execution in `running`. Research deletion refuses to remove evidence while its own execution or a linked draft remains running. Explicit CLI maintenance can now reconcile a reservation only when the original local process is provably gone.

**Interruption describes local execution state only. It does not establish that a remote model or research request was cancelled, completed, or not billed. Remote work may finish after local process death.** Reconciliation never invokes a provider, fetches research, retries work, promotes a partial result, or releases an idempotency key for reuse.

## Inspect and reconcile

Use Node 24.16+ within Node 24. Stop old CLI/MCP instances before upgrading, then build the new version. Use the same profile and data-directory configuration as the original run; no API credentials are needed for maintenance.

```sh
npm run build
npm run runs -- list
npm run runs -- inspect-recovery RUN_UUID
```

Replace `RUN_UUID` with the run ID. Inspection returns safe status, an observation/reason, eligibility, parent/linked run IDs, and any existing reconciliation event. It does not return prompts, process metadata, private evidence, or generated bodies. Inspection is advisory and makes no execution-state changes.

- `running` plus `active`: the original process identity still exists. This includes suspended, unresponsive, and unreaped zombie processes; it does not prove progress.
- `running` plus `abandoned`: the local original process is provably gone, but the reservation still blocks deletion until reconciled.
- `running` plus `unknown`: death cannot be established. The reservation remains protected.
- `succeeded`, `failed`, and `interrupted` are terminal outcomes. Handled cancellation/timeouts remain ordinary failures.

If inspection reports `eligible: true`, explicitly reconcile that single run:

```sh
npm run runs -- reconcile RUN_UUID
npm run runs -- inspect-recovery RUN_UUID
```

Reconciliation repeats inspection inside a short SQLite writer transaction. It atomically marks both run and execution interrupted and records an immutable audit event. Concurrent or repeated reconciliation returns the same event without another transition. Completed/failed executions are unchanged. A process may exit after an inspection reports active; inspect again rather than assuming a timeout proves abandonment.

For a research deletion blocker, inspect and reconcile each eligible linked run individually. Parent and child outcomes are independent; a completed child never automatically completes its abandoned parent. Then request deletion separately:

```sh
npm run research -- delete-run RESEARCH_RUN_UUID
```

Any remaining running research or linked drafting reservation still blocks deletion. No force option, age threshold, lease, heartbeat, automatic recovery, process termination, or retry is provided. A deliberately new request requires a new key and can incur additional cost; recovery itself never creates that request.

## Ownership and transaction boundaries

Migration 6 adds immutable process ownership to new reservations and an append-only reconciliation table. Ownership includes an application-instance UUID, platform/PID, and (where available) Linux start time, boot identity, PID/mount/user/time namespaces, proc mount visibility, and user identity. Infrastructure supplies these values; no model or CLI/MCP input can assign them. Unsupported environments still reserve work with an instance identity, but cannot establish recoverable process identity.

The initial Linux inspector accepts only the same boot and verified visibility scope with one ordinary unrestricted proc mount. It compares PID **and** process-start identity. Verified absence or a different process-start identity proves the original process exited. Permission errors, malformed reads, scope changes, restricted/stacked proc mounts, unexpected process overmounts, unsupported systems, and unavailable metadata fail closed. Boot changes and database moves/copies are not recovery evidence. Do not use database copies concurrently with the original: local process identity is not a distributed ownership protocol.

Every execution-owned write checks matching application ownership, user ownership, kind where relevant, and both running records inside its write transaction. Drafts, artifacts, research items/results, planning updates, scoped HTTP-cache writes, and research pruning cannot be written by another instance or a terminal execution. Terminal updates require exactly one affected row in each table. If a guard or final update fails, **all associated payload and state writes roll back**. Agent completion additionally requires its own completed child's draft; artifact references retain execution lineage. No transaction spans a model call or research request.

Interruption uses existing database `failed` states with `INTERRUPTED` error codes; application run views expose `interrupted`. Keys, request hashes, and lineage are retained. Matching interrupted keys return `PREVIOUS_FAILURE` with an interruption explanation. Changed input still conflicts. Historical success/replay behavior remains intact.

The audit event stores only IDs, previous/resulting states, timestamps, the initiating CLI instance, and a bounded local-death reason. Safe stderr logging reports the transition; the database event is authoritative even if the process exits before logging or delivering a response. Events cannot be updated/deleted through the store. Reconciliation requires both CLI actor and `recover_local`; only CLI composition grants that permission. No recovery tool is registered with MCP or the agent planner.

## Retention, compatibility, and limitations

Research deletion preserves the existing policy: remove originating research payloads, ideas/reviews, eligible unshared public items, and response caches; retain rate-limit cooldown, execution/key tombstones, lineage, and audit events. Derived drafts, blocked artifacts, derivative request snapshots, and their frozen public/private evidence remain, including snapshots of interrupted derivatives with no draft/artifact. The deletion response identifies retained derivatives. Recovery does not purge source files, SQLite free pages/WAL, backups, or exported copies.

Existing running reservations receive no invented process ownership and remain `unknown`. Their keys remain blocked. There is no legacy override. Cross-boot recovery and additional platform adapters require a separately reviewed mechanism. A stranded reservation in a still-live process also remains blocked until that process exits; the command does not manage that process.

Stop all older application instances before migration: the schema-version check rejects older binaries on reopening, but an already-open old binary cannot acquire the new write guards retroactively. Migrations are numbered and transactional; no historical payloads or fingerprints are rewritten. Normal completion and handled failure remain available on platforms where recovery is unsupported.

## Verification

Tests use isolated temporary databases, synthetic evidence, deterministic process-read failures, local provider fixtures, and real SIGKILL subprocesses. They cover PID reuse, stopped active processes, mismatched visibility, ownership rejection, late writes, rollback after payload insertion, audit failure, migration, CLI permissions, retained derivatives, and simultaneous reconcilers. Crash fixtures exercise reservation, generation, assessment, persisted research items, agent/child reservations, and committed responses lost before delivery.

On restricted proc layouts the real crash fixtures assert refusal rather than pretending death was proved; the supported-process concurrency test explicitly skips with a reason. Run that test on an ordinary Linux host to verify actual process-death reconciliation. Automated checks do not establish live provider behavior, remote cancellation, or billing outcomes.
