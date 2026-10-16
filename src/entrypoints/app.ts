import { ResearchWorkflow } from '../application/research.js';
import { GithubResearchFeed } from '../infrastructure/github-research.js';
import type { ResearchFeed, ResearchPlanner } from '../domain/research.js';
import type { DraftProvider } from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';
import type { Config } from '../infrastructure/config.js';
import { loadConfig } from '../infrastructure/config.js';
import { createLogger } from '../infrastructure/logger.js';
import type { Logger } from '../infrastructure/logger.js';
import { SqliteStore } from '../infrastructure/sqlite.js';
import { OpenAIProvider } from '../infrastructure/openai-provider.js';
import { DraftService } from '../application/drafting.js';
import { createTools } from '../application/tools.js';
import { AgentWorkflow } from '../application/agent.js';
import { KnowledgeIndex } from '../infrastructure/knowledge-index.js';
import { join } from 'node:path';

export function createApplication(
  config: Config = loadConfig(),
  overrides: {
    provider?: DraftProvider;
    logger?: Logger;
    researchFeed?: ResearchFeed;
    researchPlanner?: ResearchPlanner;
  } = {},
) {
  const logger = overrides.logger ?? createLogger();
  const unavailable = async (): Promise<never> => {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Generation requires OPENAI_API_KEY and OPENAI_MODEL.',
    );
  };
  const provider: DraftProvider =
    overrides.provider ??
    (config.apiKey && config.model
      ? new OpenAIProvider({ apiKey: config.apiKey, model: config.model })
      : {
          provider: 'openai',
          model: config.model ?? 'unconfigured',
          generateDraft: unavailable,
          assessDraft: unavailable,
          proposeTools: unavailable,
        });
  const store = new SqliteStore(config.dataDir);
  const knowledge = new KnowledgeIndex(
    config.knowledgeDir ?? join(config.dataDir, 'knowledge'),
  );
  const service = new DraftService(
    store,
    provider,
    config.profile,
    logger,
    config.runTimeoutMs,
    knowledge,
  );
  const researchPlanner: ResearchPlanner =
    overrides.researchPlanner ??
    (config.apiKey && config.model
      ? new OpenAIProvider({ apiKey: config.apiKey, model: config.model })
      : {
          provider: 'openai',
          model: config.model ?? 'unconfigured',
          planResearch: unavailable,
        });
  const research = new ResearchWorkflow(
    store,
    overrides.researchFeed ??
      new GithubResearchFeed(fetch, () => new Date(), store),
    researchPlanner,
    config.profile,
    knowledge,
    logger,
    config.researchLookbackDays ?? 14,
    config.runTimeoutMs,
  );
  const tools = createTools(service, store, config.profile, research);
  const agent = new AgentWorkflow(
    tools,
    provider,
    store,
    config.profile,
    logger,
    config.runTimeoutMs,
    knowledge,
  );
  return {
    config,
    logger,
    store,
    tools,
    agent,
    research,
    knowledge,
    close: () => {
      try {
        store.close();
      } finally {
        knowledge.close();
      }
    },
  };
}
export type Application = ReturnType<typeof createApplication>;
