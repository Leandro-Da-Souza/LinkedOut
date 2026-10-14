import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeContext,
  KnowledgeIssue,
  KnowledgeReader,
  KnowledgeSource,
} from '../domain/knowledge.js';
import { AppError, checkAbort } from '../domain/errors.js';
import {
  DocumentExtractionError,
  extractDocument,
} from './document-extractor.js';

const VERSION = 'knowledge-v1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CORPUS_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_CHUNKS = 5000;
const STOPWORDS = new Set(
  'a an and are as at be been being by can could did do does draft for from had has have how i in is it its me my of on or our please post should some that the their them these they this to was we were what when which who will with write about linkedin share short reflect reflection practical professional useful personal experience project projects lessons'.split(
    ' ',
  ),
);
const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const documentId = (path: string): string => `doc_${hash(path).slice(0, 20)}`;

interface IndexSummary {
  revision: string;
  documents: number;
  chunks: number;
  issues: KnowledgeIssue[];
}
interface FileEntry {
  absolute: string;
  path: string;
}

/** Private, local derived cache. No networking, embeddings, or model calls. */
export class KnowledgeIndex implements KnowledgeReader {
  private db: DatabaseSync | undefined;
  private pending: Promise<IndexSummary> | undefined;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    if (basename(this.root) !== 'knowledge')
      throw new AppError(
        'CONFIGURATION_ERROR',
        'The private knowledge directory must be named knowledge so ignore rules protect its contents.',
      );
  }
  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async index(signal?: AbortSignal): Promise<IndexSummary> {
    // One process shares refresh work; SQLite handles independent process writers.
    if (!this.pending)
      this.pending = this.refresh(signal).finally(() => {
        this.pending = undefined;
      });
    const result = await this.pending;
    checkAbort(signal);
    return result;
  }

  async retrieve(
    query: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeContext> {
    const summary = await this.index(signal);
    const tokens = [
      ...new Set(
        query
          .toLowerCase()
          .normalize('NFKC')
          .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [],
      ),
    ]
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
      .slice(0, 32);
    const sources: KnowledgeSource[] = [];
    if (tokens.length && summary.chunks && this.db) {
      // Generate literal terms ourselves. Never accept a caller's MATCH expression.
      const match = tokens.map((token) => `"${token}"`).join(' OR ');
      const rows = this.db
        .prepare(
          `SELECT chunks.*, documents.content_hash
        FROM chunks JOIN documents ON chunks.document_id = documents.id
        WHERE chunks MATCH ? ORDER BY bm25(chunks, 0, 0, 2, 1, 0, 0), chunks.id LIMIT 40`,
        )
        .all(match);
      const perDocument = new Map<string, number>();
      let characters = 0;
      for (const row of rows) {
        const id = String(row['document_id']);
        const excerpt = String(row['text']);
        if (
          (perDocument.get(id) ?? 0) >= 2 ||
          sources.length >= 6 ||
          characters + excerpt.length > 6000
        )
          continue;
        sources.push({
          id: String(row['id']),
          documentId: id,
          path: String(row['path']),
          contentHash: String(row['content_hash']),
          excerpt,
          page: row['page'] === null ? null : Number(row['page']),
          startLine:
            row['start_line'] === null ? null : Number(row['start_line']),
        });
        characters += excerpt.length;
        perDocument.set(id, (perDocument.get(id) ?? 0) + 1);
      }
    }
    return {
      revision: summary.revision,
      sources,
      issues: [
        ...summary.issues,
        ...(sources.length
          ? []
          : [
              {
                code: summary.documents
                  ? ('NO_MATCHES' as const)
                  : ('EMPTY_KNOWLEDGE' as const),
              },
            ]),
      ],
    };
  }

  private async safeDirectory(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new AppError(
          'CONFIGURATION_ERROR',
          'Knowledge directories must be real local directories, not links.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') await chmod(path, 0o700);
  }
  private async database(): Promise<DatabaseSync> {
    await this.safeDirectory(this.root);
    await this.safeDirectory(join(this.root, '.cache'));
    if (this.db) return this.db;
    for (const name of [
      '.index.sqlite',
      '.index.sqlite-journal',
      '.index.sqlite-wal',
      '.index.sqlite-shm',
    ]) {
      try {
        if ((await lstat(join(this.root, name))).isSymbolicLink())
          throw new AppError(
            'CONFIGURATION_ERROR',
            'Knowledge index paths must not be links.',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const file = join(this.root, '.index.sqlite');
    const db = new DatabaseSync(file);
    try {
      if (process.platform !== 'win32') await chmod(file, 0o600);
      db.exec(`PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL, content_hash TEXT NOT NULL, version TEXT NOT NULL, issue TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(id UNINDEXED, document_id UNINDEXED, path, text, page UNINDEXED, start_line UNINDEXED, tokenize='unicode61 remove_diacritics 2');`);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  private async refresh(signal?: AbortSignal): Promise<IndexSummary> {
    checkAbort(signal);
    const db = await this.database();
    const files: FileEntry[] = [];
    const issues: KnowledgeIssue[] = [];
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      checkAbort(signal);
      const entries = (await readdir(directory, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name, 'en'),
      );
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        visited++;
        if (visited > 1000 || depth > 8 || files.length >= MAX_FILES) {
          issues.push({ code: 'LIMIT_EXCEEDED' });
          return;
        }
        const absolute = join(directory, entry.name);
        const path = relative(this.root, absolute).split(sep).join('/');
        if (entry.isSymbolicLink()) {
          issues.push({ code: 'UNSAFE_PATH', documentId: documentId(path) });
          continue;
        }
        if (entry.isDirectory()) await visit(absolute, depth + 1);
        else if (entry.isFile() && /\.(pdf|md|markdown|txt)$/iu.test(path))
          files.push({ absolute, path });
      }
    };
    try {
      await visit(this.root, 0);
    } catch (error) {
      checkAbort(signal);
      if (error instanceof AppError) throw error;
      throw new AppError(
        'STORAGE_ERROR',
        'Cannot read the private knowledge directory. No cached evidence was supplied.',
      );
    }
    const seen = new Set<string>();
    let bytes = 0;
    let corpusChunks = 0;
    for (const file of files) {
      checkAbort(signal);
      const id = documentId(file.path);
      seen.add(id);
      let data: Uint8Array;
      try {
        // O_NOFOLLOW plus fstat reject linked and non-regular source files.
        const handle = await open(
          file.absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new DocumentExtractionError('UNSAFE_PATH');
          if (
            info.size > MAX_FILE_BYTES ||
            bytes + info.size > MAX_CORPUS_BYTES
          )
            throw new DocumentExtractionError('LIMIT_EXCEEDED');
          data = await handle.readFile();
          bytes += data.length;
          if (data.length > MAX_FILE_BYTES)
            throw new DocumentExtractionError('LIMIT_EXCEEDED');
        } finally {
          await handle.close();
        }
      } catch (error) {
        const code =
          error instanceof DocumentExtractionError
            ? error.code
            : 'UNREADABLE_FILE';
        issues.push({ code, documentId: id });
        this.replaceDocument(db, id, file.path, 'unreadable', [], code);
        continue;
      }
      const contentHash = hash(data);
      const previous = db
        .prepare('SELECT * FROM documents WHERE id = ?')
        .get(id);
      if (
        previous?.['content_hash'] === contentHash &&
        previous['version'] === VERSION &&
        previous['issue'] === null
      ) {
        const count = Number(
          db
            .prepare('SELECT count(*) AS n FROM chunks WHERE document_id = ?')
            .get(id)?.['n'],
        );
        if (count + corpusChunks > MAX_CHUNKS) {
          issues.push({ code: 'LIMIT_EXCEEDED', documentId: id });
          this.replaceDocument(
            db,
            id,
            file.path,
            contentHash,
            [],
            'LIMIT_EXCEEDED',
          );
        } else corpusChunks += count;
        continue;
      }
      try {
        const extension = extname(file.path).toLowerCase();
        const pages = await extractDocument(
          data,
          extension === '.pdf' ? 'pdf' : extension === '.txt' ? 'txt' : 'md',
          {
            cacheDir: join(this.root, '.cache'),
            ...(signal ? { signal } : {}),
          },
        );
        const chunks = pages.flatMap((page) =>
          splitPassages(page.text, page.page),
        );
        if (chunks.length + corpusChunks > MAX_CHUNKS)
          throw new DocumentExtractionError('LIMIT_EXCEEDED');
        this.replaceDocument(db, id, file.path, contentHash, chunks, null);
        corpusChunks += chunks.length;
      } catch (error) {
        checkAbort(signal);
        if (
          error instanceof AppError &&
          (error.code === 'CANCELLED' || error.code === 'TIMEOUT')
        )
          throw error;
        const code =
          error instanceof DocumentExtractionError
            ? error.code
            : 'MALFORMED_FILE';
        issues.push({ code, documentId: id });
        this.replaceDocument(db, id, file.path, contentHash, [], code);
      }
    }
    // Remove deleted, unsupported, or newly unsafe sources before any retrieval.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT id FROM documents').all()) {
        const id = String(row['id']);
        if (!seen.has(id)) {
          db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
          db.prepare('DELETE FROM documents WHERE id = ?').run(id);
        }
      }
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      throw new AppError('STORAGE_ERROR', 'Knowledge cache update failed.');
    }
    const manifest = db
      .prepare('SELECT id, content_hash, issue FROM documents ORDER BY id')
      .all();
    return {
      revision: hash(JSON.stringify({ version: VERSION, manifest, issues })),
      documents: files.length,
      chunks: Number(
        db.prepare('SELECT count(*) AS n FROM chunks').get()?.['n'],
      ),
      issues,
    };
  }

  private replaceDocument(
    db: DatabaseSync,
    id: string,
    path: string,
    contentHash: string,
    chunks: Passage[],
    issue: string | null,
  ): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
      db.prepare(
        'INSERT OR REPLACE INTO documents (id, path, content_hash, version, issue) VALUES (?, ?, ?, ?, ?)',
      ).run(id, path, contentHash, VERSION, issue);
      const insert = db.prepare(
        'INSERT INTO chunks (id, document_id, path, text, page, start_line) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const [index, chunk] of chunks.entries())
        insert.run(
          `${id}:${contentHash.slice(0, 16)}:${index}`,
          id,
          path,
          chunk.text,
          chunk.page,
          chunk.startLine,
        );
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      throw new AppError('STORAGE_ERROR', 'Knowledge cache update failed.');
    }
  }
}

interface Passage {
  text: string;
  page: number | null;
  startLine: number | null;
}
function splitPassages(text: string, page: number | null): Passage[] {
  const chunks: Passage[] = [];
  let content = '';
  let startLine = 1;
  const flush = () => {
    if (content.trim())
      chunks.push({
        text: content.trim(),
        page,
        startLine: page === null ? startLine : null,
      });
    content = '';
  };
  for (const [index, line] of text.split('\n').entries()) {
    for (let offset = 0; offset < Math.max(1, line.length); offset += 900) {
      const part = line.slice(offset, offset + 900);
      if (
        content.length + part.length + 1 > 1000 ||
        (!line.trim() && content.length > 300)
      )
        flush();
      if (!content) startLine = index + 1;
      content += `${part}\n`;
    }
  }
  flush();
  return chunks;
}
