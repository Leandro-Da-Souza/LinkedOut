import process from 'node:process';
import { setInterval } from 'node:timers';
import { writeFileSync } from 'node:fs';
import { SqliteStore } from '../../dist/infrastructure/sqlite.js';
import { DraftService } from '../../dist/application/drafting.js';
import { AgentWorkflow } from '../../dist/application/agent.js';
import { createTools } from '../../dist/application/tools.js';
import { userProfileSchema } from '../../dist/domain/contracts.js';
import { EMPTY_KNOWLEDGE } from '../../dist/domain/knowledge.js';

const [dir, mode, output, runId] = process.argv.slice(2);
const store = new SqliteStore(dir);
const context = { actor: 'test', permissions: new Set(['draft_local']) };
const logger = { log() {} };
const profile = userProfileSchema.parse({});
const save = () =>
  writeFileSync(output, JSON.stringify({ runs: store.listRuns('local') }));
const crash = () => {
  save();
  process.kill(process.pid, 'SIGKILL');
};
if (mode === 'reconcile') {
  try {
    writeFileSync(output, JSON.stringify(store.reconcileRun('local', runId)));
  } finally {
    store.close();
  }
} else if (mode === 'reserve' || mode === 'active') {
  store.reserveDraft('local', 'hash', {}, 'key', context);
  if (mode === 'reserve') crash();
  else {
    save();
    setInterval(() => {}, 1000);
  }
} else if (mode === 'research-items') {
  const { runId } = store.reserveResearch('local', 'hash', {}, 'key', context);
  store.saveResearchItems(
    'local',
    [
      {
        id: 'synthetic-item',
        identity: 'synthetic:1',
        contentHash: 'synthetic',
        retrievedAt: new Date().toISOString(),
      },
    ],
    runId,
  );
  crash();
} else if (mode === 'research-completed') {
  const { runId } = store.reserveResearch('local', 'hash', {}, 'key', context);
  store.completeResearch('local', {
    runId,
    createdAt: new Date().toISOString(),
    lookbackDays: 14,
    coverage: 'complete',
    outcomes: [],
    ideas: [],
    requests: 0,
    modelCalls: 0,
    knowledge: EMPTY_KNOWLEDGE,
    evidenceSnapshot: [],
  });
  crash();
} else {
  // Local service providers only: crash at actual workflow await boundaries.
  const provider = {
    provider: 'fixture',
    model: 'fixture',
    async generateDraft() {
      if (mode === 'generation' || mode === 'agent-child') crash();
      return {
        output: { body: 'What should we consider?', warnings: [] },
        metadata: { provider: 'fixture', model: 'fixture' },
      };
    },
    async assessDraft(request) {
      if (mode === 'assessment') crash();
      return {
        output: {
          units: request.units.map((unit) => ({
            id: unit.id,
            category: 'advice_opinion_question',
            evidence: null,
          })),
        },
        metadata: { provider: 'fixture', model: 'fixture' },
      };
    },
    async proposeTools() {
      return {
        calls: [
          {
            name: 'draft_post',
            callId: 'fixture',
            arguments: {
              brief: 'Synthetic',
              audience: null,
              tone: null,
              language: null,
            },
          },
        ],
        metadata: { provider: 'fixture', model: 'fixture' },
      };
    },
  };
  if (mode === 'before-commit') store.finishRun = () => crash(); // Kill after draft INSERT inside the actual transaction.
  const service = new DraftService(store, provider, profile, logger);
  if (mode === 'agent-child') {
    const agent = new AgentWorkflow(
      createTools(service, store, profile),
      provider,
      store,
      profile,
      logger,
    );
    await agent.run({ brief: 'Synthetic', idempotencyKey: 'key' }, context);
  } else {
    await service.create(
      { brief: 'Synthetic', idempotencyKey: 'key' },
      context,
    );
    crash(); // Success persisted, response delivery lost.
  }
}
