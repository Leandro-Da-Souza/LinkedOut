export interface KnowledgeSource {
  id: string;
  documentId: string;
  path: string;
  contentHash: string;
  excerpt: string;
  page: number | null;
  startLine: number | null;
}
export interface KnowledgeIssue {
  code:
    | 'MALFORMED_FILE'
    | 'NO_READABLE_TEXT'
    | 'PDF_TOOL_UNAVAILABLE'
    | 'LIMIT_EXCEEDED'
    | 'UNSAFE_PATH'
    | 'UNREADABLE_FILE'
    | 'NO_MATCHES'
    | 'EMPTY_KNOWLEDGE';
  documentId?: string;
}
export interface KnowledgeContext {
  revision: string;
  sources: KnowledgeSource[];
  issues: KnowledgeIssue[];
}
export interface KnowledgeReader {
  retrieve(query: string, signal?: AbortSignal): Promise<KnowledgeContext>;
}
export const EMPTY_KNOWLEDGE: KnowledgeContext = {
  revision: 'empty',
  sources: [],
  issues: [{ code: 'EMPTY_KNOWLEDGE' }],
};
