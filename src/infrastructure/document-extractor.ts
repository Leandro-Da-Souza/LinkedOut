import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError, checkAbort } from '../domain/errors.js';
import type { KnowledgeIssue } from '../domain/knowledge.js';

export class DocumentExtractionError extends Error {
  constructor(public readonly code: KnowledgeIssue['code']) {
    super('The document could not be extracted safely.');
    this.name = 'DocumentExtractionError';
  }
}

const MAX_CHARACTERS = 500_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PDF_TIMEOUT_MS = 15_000;

function readableText(data: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new DocumentExtractionError('MALFORMED_FILE');
  }
  if (text.includes('\0')) throw new DocumentExtractionError('MALFORMED_FILE');
  if (text.length > MAX_CHARACTERS)
    throw new DocumentExtractionError('LIMIT_EXCEEDED');
  // Preserve tabs, line breaks and PDF page breaks; other control characters
  // are not readable reference content.
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- intentionally remove unreadable control bytes
      .replace(/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/g, '')
  );
}

async function runPdfTool(
  command: string,
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  await new Promise<void>((accept, reject) => {
    let failure: Error | undefined;
    const child = spawn(
      command,
      ['-layout', '-enc', 'UTF-8', '-f', '1', '-l', '101', input, output],
      { env, stdio: 'ignore', shell: false, windowsHide: true },
    );
    const cancel = () => {
      try {
        checkAbort(signal);
      } catch (error) {
        failure = error as AppError;
      }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      failure = new AppError(
        'TIMEOUT',
        'Document extraction exceeded its deadline.',
      );
      child.kill('SIGKILL');
    }, PDF_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', () => {
      failure ??= new DocumentExtractionError('PDF_TOOL_UNAVAILABLE');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new DocumentExtractionError('MALFORMED_FILE'));
      else accept();
    });
  });
}

export async function extractDocument(
  data: Uint8Array,
  format: 'pdf' | 'md' | 'txt',
  options: { cacheDir: string; signal?: AbortSignal; pdfCommand?: string },
): Promise<Array<{ text: string; page: number | null }>> {
  checkAbort(options.signal);
  if (data.byteLength > MAX_BYTES)
    throw new DocumentExtractionError('LIMIT_EXCEEDED');
  if (format !== 'pdf') {
    const text = readableText(data);
    if (!text.trim()) throw new DocumentExtractionError('NO_READABLE_TEXT');
    return [{ text, page: null }];
  }
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-'))
    throw new DocumentExtractionError('MALFORMED_FILE');

  let directory: string | undefined;
  try {
    const cacheDir = resolve(options.cacheDir);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(cacheDir, 'extract-'));
    await chmod(directory, 0o700);
    const input = join(directory, 'source.pdf');
    const output = join(directory, 'text.txt');
    await writeFile(input, data, { mode: 0o600, flag: 'wx' });
    // Pre-create privately, so Poppler never creates a publicly readable file.
    await writeFile(output, '', { mode: 0o600, flag: 'wx' });
    await runPdfTool(
      options.pdfCommand ?? 'pdftotext',
      input,
      output,
      options.signal,
    );
    checkAbort(options.signal);
    if ((await stat(output)).size > MAX_CHARACTERS * 4)
      throw new DocumentExtractionError('LIMIT_EXCEEDED');
    const text = readableText(await readFile(output));
    const pages = text.split('\f');
    // Poppler terminates each page with a form feed, including the last page.
    if (!pages.at(-1)?.trim()) pages.pop();
    if (pages.length > 100) throw new DocumentExtractionError('LIMIT_EXCEEDED');
    const result = pages.flatMap((page, index) =>
      page.trim() ? [{ text: page.trim(), page: index + 1 }] : [],
    );
    if (!result.length) throw new DocumentExtractionError('NO_READABLE_TEXT');
    return result;
  } catch (error) {
    if (error instanceof DocumentExtractionError || error instanceof AppError)
      throw error;
    throw new DocumentExtractionError('UNREADABLE_FILE');
  } finally {
    // Only the exact private directory returned by mkdtemp is removed.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
