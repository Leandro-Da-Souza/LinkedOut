import {
  RESEARCH_SOURCES,
  researchInputSchema,
  reviewIdeaSchema,
  listIdeasSchema,
} from '../domain/research.js';
import type { ResearchWorkflow } from './research.js';
import { z } from 'zod';
import type {
  ExecutionContext,
  Permission,
  ToolSpec,
  UserProfile,
} from '../domain/contracts.js';
import {
  draftInputSchema,
  getDraftSchema,
  listDraftsSchema,
  parseInput,
  plannedDraftSchema,
} from '../domain/contracts.js';
import { AppError, checkAbort } from '../domain/errors.js';
import type { DraftService } from './drafting.js';
import type { SqliteStore } from '../infrastructure/sqlite.js';

export interface RegisteredTool {
  name: string;
  description: string;
  permission: Permission;
  inputSchema: z.ZodType;
  plannerSchema?: z.ZodType;
  readOnly: boolean;
  openWorld?: boolean;
  execute(input: unknown, context: ExecutionContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;
  constructor(tools: RegisteredTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    if (this.tools.size !== tools.length)
      throw new AppError('CONFIGURATION_ERROR', 'Duplicate tool names.');
  }
  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }
  specs(allowed: readonly string[]): ToolSpec[] {
    return allowed.map((name) => {
      const tool = this.tools.get(name);
      if (!tool?.plannerSchema)
        throw new AppError(
          'PERMISSION_DENIED',
          'Tool is not available to this workflow.',
        );
      return {
        name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.plannerSchema),
      };
    });
  }
  async invoke(
    name: string,
    raw: unknown,
    context: ExecutionContext,
  ): Promise<unknown> {
    checkAbort(context.signal);
    const tool = this.tools.get(name);
    if (!tool || !context.permissions.has(tool.permission))
      throw new AppError(
        'PERMISSION_DENIED',
        'The requested tool is not allowed.',
      );
    const input = parseInput(tool.inputSchema, raw);
    return tool.execute(input, context);
  }
}

export function createTools(
  service: DraftService,
  store: SqliteStore,
  profile: UserProfile,
  research?: ResearchWorkflow,
): ToolRegistry {
  const researchTools: RegisteredTool[] = research
    ? [
        {
          name: 'research_run',
          description:
            'Discover public releases and persist up to five review-required ideas. One bounded model call. A keyed replay returns historical evidence without refreshing.',
          permission: 'research_local',
          inputSchema: researchInputSchema,
          readOnly: false,
          openWorld: true,
          execute: (input, context) => research.run(input, context),
        },
        {
          name: 'list_research_sources',
          description:
            'Inspect configured public research sources and usage policies.',
          permission: 'read_local',
          inputSchema: z.strictObject({}),
          readOnly: true,
          execute: async () => ({ sources: RESEARCH_SOURCES }),
        },
        {
          name: 'list_research_items',
          description: 'List public research summaries.',
          permission: 'read_local',
          inputSchema: listDraftsSchema,
          readOnly: true,
          execute: async (input) => {
            const { limit, offset } = parseInput(listDraftsSchema, input);
            return {
              items: store.listResearchItems(profile.id, limit, offset),
              limit,
              offset,
            };
          },
        },
        {
          name: 'get_research_item',
          description: 'Inspect one public research item and provenance.',
          permission: 'read_local',
          inputSchema: getDraftSchema,
          readOnly: true,
          execute: async (input) => ({
            item: store.getResearchItem(
              profile.id,
              parseInput(getDraftSchema, input).id,
            ),
          }),
        },
        {
          name: 'list_content_ideas',
          description: 'List content ideas with current editorial decisions.',
          permission: 'read_local',
          inputSchema: listIdeasSchema,
          readOnly: true,
          execute: async (input) => {
            const { limit, offset, status } = parseInput(
              listIdeasSchema,
              input,
            );
            return {
              ideas: store.listIdeas(profile.id, limit, offset, status),
              limit,
              offset,
            };
          },
        },
        {
          name: 'get_content_idea',
          description:
            'Inspect an idea and its separate public and private evidence.',
          permission: 'read_local',
          inputSchema: getDraftSchema,
          readOnly: true,
          execute: async (input) => ({
            idea: store.getIdea(
              profile.id,
              parseInput(getDraftSchema, input).id,
            ),
          }),
        },
        {
          name: 'review_content_idea',
          description:
            'Record a local editorial decision; acceptance never grants publication approval.',
          permission: 'review_local',
          inputSchema: reviewIdeaSchema,
          readOnly: false,
          execute: async (input) => {
            const { id, status } = parseInput(reviewIdeaSchema, input);
            return { idea: store.reviewIdea(profile.id, id, status) };
          },
        },
        {
          name: 'delete_research_run',
          description:
            'Delete a completed research run payload and its ideas. Retain safe history and key tombstone. Does not erase backups.',
          permission: 'delete_local',
          inputSchema: getDraftSchema,
          readOnly: false,
          execute: async (input) => {
            store.deleteResearchRun(
              profile.id,
              parseInput(getDraftSchema, input).id,
            );
            return { deleted: true };
          },
        },
      ]
    : [];
  return new ToolRegistry([
    ...researchTools,
    {
      name: 'list_review_artifacts',
      description:
        'List private blocked review artifact summaries; never publication-ready.',
      permission: 'read_local',
      inputSchema: listDraftsSchema,
      readOnly: true,
      execute: async (input) => {
        const { limit, offset } = parseInput(listDraftsSchema, input);
        return store.listReviewArtifacts(profile.id, limit, offset);
      },
    },
    {
      name: 'get_review_artifact',
      description:
        'Explicitly retrieve a private non-publishable body and its assessment evidence.',
      permission: 'read_local',
      inputSchema: getDraftSchema,
      readOnly: true,
      execute: async (input) => {
        const { id } = parseInput(getDraftSchema, input);
        return { artifact: store.getReviewArtifact(profile.id, id) };
      },
    },
    {
      name: 'delete_review_artifact',
      description:
        'Delete one private review artifact; preserves safe run history and existing request snapshots.',
      permission: 'delete_local',
      inputSchema: getDraftSchema,
      readOnly: false,
      execute: async (input) => {
        const { id } = parseInput(getDraftSchema, input);
        store.deleteReviewArtifact(profile.id, id);
        return { deleted: true };
      },
    },
    {
      name: 'draft_post',
      openWorld: true,
      description:
        'Generate and persist one LinkedIn draft from user-provided information. Costs two bounded LLM operations; does not research or publish.',
      permission: 'draft_local',
      inputSchema: draftInputSchema,
      plannerSchema: plannedDraftSchema,
      readOnly: false,
      execute: (input, context) => service.create(input, context),
    },
    {
      name: 'get_draft',
      description: 'Retrieve a local draft belonging to the configured user.',
      permission: 'read_local',
      inputSchema: getDraftSchema,
      readOnly: true,
      execute: async (input) => {
        const { id } = parseInput(getDraftSchema, input);
        return { draft: store.getDraft(profile.id, id) };
      },
    },
    {
      name: 'list_drafts',
      description:
        'List paginated local draft summaries belonging to the configured user.',
      permission: 'read_local',
      inputSchema: listDraftsSchema,
      readOnly: true,
      execute: async (input) => {
        const { limit, offset } = parseInput(listDraftsSchema, input);
        return {
          ...store.listDrafts(profile.id, limit, offset),
          limit,
          offset,
        };
      },
    },
  ]);
}
