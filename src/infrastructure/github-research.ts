import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkAbort } from '../domain/errors.js';
import {
  RESEARCH_SOURCES,
  type ResearchFeed,
  type ResearchItem,
  type SourceOutcome,
  type ResearchCache,
} from '../domain/research.js';

const releaseSchema = z.object({
  id: z.number().int().positive().safe(),
  html_url: z.string().max(2000),
  name: z.string().nullable(),
  tag_name: z.string().max(300),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});
// Stored text is plain data. Remove HTML and terminal controls, never render or follow it.
export const plainResearchText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, '')
    .replace(/\p{Cc}/gu, ' ')
    .trim();

export class GithubResearchFeed implements ResearchFeed {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = () => new Date(),
    private readonly cache?: ResearchCache,
  ) {}
  async collect(signal: AbortSignal) {
    const items: ResearchItem[] = [];
    const outcomes: SourceOutcome[] = [];
    let requests = 0;
    let bytes = 0;
    const cooldown = this.cache?.getResearchCache('github-cooldown');
    if (typeof cooldown === 'number' && cooldown > this.now().getTime())
      return {
        items,
        requests,
        outcomes: RESEARCH_SOURCES.map((source) => ({
          repository: source.repository,
          status: 'failed' as const,
          code: 'RATE_LIMIT_COOLDOWN',
          truncated: false,
          count: 0,
        })),
      };
    for (const source of RESEARCH_SOURCES) {
      checkAbort(signal);
      let truncated = false;
      try {
        const cached = this.cache?.getResearchCache(source.repository) as
          | {
              etag?: string;
              items: ResearchItem[];
              savedAt: number;
              truncated: boolean;
            }
          | undefined;
        const freshCache =
          cached && this.now().getTime() - cached.savedAt < 90 * 86_400_000
            ? cached
            : undefined;
        // Fixed origin and paths: neither remote content nor tool inputs choose destinations.
        requests++;
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(10_000),
        ]);
        const response = await this.fetcher(
          `https://api.github.com/repos/${source.repository}/releases?per_page=20&page=1`,
          {
            signal: requestSignal,
            redirect: 'error',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
              'User-Agent': 'LinkedOut-local-research',
              ...(freshCache?.etag ? { 'If-None-Match': freshCache.etag } : {}),
            },
          },
        );
        if (response.status === 304 && freshCache) {
          const refreshed = freshCache.items.map((item) => ({
            ...item,
            retrievedAt: this.now().toISOString(),
          }));
          items.push(...refreshed);
          this.cache?.setResearchCache(source.repository, {
            ...freshCache,
            items: refreshed,
            savedAt: this.now().getTime(),
          });
          outcomes.push({
            repository: source.repository,
            status: 'ok',
            truncated: freshCache.truncated,
            count: refreshed.length,
          });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          outcomes.push({
            repository: source.repository,
            status: 'failed',
            code:
              response.status === 429 || response.status === 403
                ? 'RATE_LIMIT_OR_ACCESS'
                : 'HTTP_ERROR',
            truncated: false,
            count: 0,
          });
          // GitHub limits are origin-wide. Do not issue more requests after a limit response.
          if (response.status === 429 || response.status === 403) {
            const retry = response.headers.get('retry-after');
            const retryMs =
              retry && /^\d+$/.test(retry)
                ? this.now().getTime() + Number(retry) * 1000
                : retry
                  ? Date.parse(retry)
                  : NaN;
            const resetMs =
              Number(response.headers.get('x-ratelimit-reset')) * 1000;
            this.cache?.setResearchCache(
              'github-cooldown',
              Math.max(
                this.now().getTime() + 60_000,
                Number.isFinite(retryMs) ? retryMs : 0,
                Number.isFinite(resetMs) ? resetMs : 0,
              ),
            );
            for (const remaining of RESEARCH_SOURCES.slice(outcomes.length))
              outcomes.push({
                repository: remaining.repository,
                status: 'failed',
                code: 'RATE_LIMIT_OR_ACCESS',
                truncated: false,
                count: 0,
              });
            break;
          }
          continue;
        }
        if (
          !response.headers.get('content-type')?.toLowerCase().includes('json')
        ) {
          await response.body?.cancel();
          throw new Error('content-type');
        }
        if (!response.body) throw new Error('empty');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            checkAbort(requestSignal);
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            bytes += value.byteLength;
            if (size > 1_048_576 || bytes > 6_291_456) throw new Error('size');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
        const parsed = z
          .array(z.unknown())
          .max(20)
          .parse(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            ),
          );
        truncated = Boolean(
          response.headers.get('link')?.includes('rel="next"'),
        );
        const start = items.length;
        let invalid = 0;
        let count = 0;
        for (const raw of parsed) {
          const result = releaseSchema.safeParse(raw);
          if (!result.success) {
            invalid++;
            continue;
          }
          const release = result.data;
          if (release.draft) continue;
          let url: URL;
          try {
            url = new URL(release.html_url);
          } catch {
            invalid++;
            continue;
          }
          if (
            url.protocol !== 'https:' ||
            url.hostname !== 'github.com' ||
            url.port ||
            url.username ||
            url.password ||
            !url.pathname
              .toLowerCase()
              .startsWith(`/${source.repository.toLowerCase()}/releases/tag/`)
          ) {
            invalid++;
            continue;
          }
          url.hash = '';
          url.search = '';
          const publishedMs =
            release.published_at &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(release.published_at)
              ? Date.parse(release.published_at)
              : NaN;
          const validDate =
            Number.isFinite(publishedMs) &&
            publishedMs! <= this.now().getTime() &&
            new Date(publishedMs!).toISOString().replace('.000Z', 'Z') ===
              release.published_at;
          const text = plainResearchText(release.body ?? '');
          const title = plainResearchText(
            release.name ?? release.tag_name,
          ).slice(0, 300);
          const publishedAt = validDate
            ? new Date(publishedMs!).toISOString()
            : null;
          const contentHash = createHash('sha256')
            .update(
              JSON.stringify({
                title,
                text,
                tag: release.tag_name,
                publishedAt,
                prerelease: release.prerelease,
                url: url.href,
              }),
            )
            .digest('hex');
          items.push({
            id: randomUUID(),
            identity: `${source.repository.toLowerCase()}:${release.id}`,
            repository: source.repository,
            releaseId: release.id,
            url: url.href,
            title,
            tag: plainResearchText(release.tag_name),
            publishedAt,
            rawPublicationDate: release.published_at
              ? plainResearchText(release.published_at).slice(0, 100)
              : null,
            dateQuality: validDate ? 'valid' : 'invalid',
            retrievedAt: this.now().toISOString(),
            excerpt: text.slice(0, 2400),
            contentHash,
            prerelease: release.prerelease,
            truncated: text.length > 2400,
            source,
            verification: 'publisher_reported',
          });
          count++;
        }
        if (!invalid)
          this.cache?.setResearchCache(source.repository, {
            etag: response.headers.get('etag') ?? undefined,
            items: items.slice(start),
            savedAt: this.now().getTime(),
            truncated,
          });
        outcomes.push({
          repository: source.repository,
          status: invalid ? 'failed' : 'ok',
          ...(invalid ? { code: 'INVALID_ITEMS' } : {}),
          truncated,
          count,
        });
      } catch {
        checkAbort(signal);
        outcomes.push({
          repository: source.repository,
          status: 'failed',
          code: 'SOURCE_UNAVAILABLE_OR_INVALID',
          truncated,
          count: 0,
        });
      }
    }
    return { items, outcomes, requests };
  }
}
