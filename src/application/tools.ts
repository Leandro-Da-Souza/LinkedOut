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
): ToolRegistry {
  return new ToolRegistry([
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
