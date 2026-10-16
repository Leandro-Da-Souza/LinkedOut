import { pathToFileURL } from 'node:url';
import { publicError, researchErrorDetails } from '../domain/errors.js';

export function isMain(url: string): boolean {
  return Boolean(
    process.argv[1] && pathToFileURL(process.argv[1]).href === url,
  );
}
export function reportFailure(error: unknown): void {
  const safe = publicError(error);
  process.stderr.write(
    `${JSON.stringify({ error: { code: safe.code, message: safe.message, ...researchErrorDetails(safe), ...(safe.reviewArtifactId ? { reviewArtifactId: safe.reviewArtifactId } : {}) } })}\n`,
  );
  process.exitCode = 1;
}
