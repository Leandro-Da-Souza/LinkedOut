# Private personal knowledge

This committed directory contains instructions, not evidence about you. It is never indexed automatically. Put your actual documents in the Git-ignored `knowledge/` directory:

```text
knowledge/
  cv.pdf                   # Your actual CV, not a fictional example
  projects/
    project-name.md        # Optional factual project notes
  references/
    career-notes.txt       # Optional UTF-8 text
```

Supported formats: `.pdf`, `.md`, `.markdown`, `.txt`. Markdown is read as text; links, scripts, code blocks and embedded instructions are never executed or fetched. Use UTF-8 for text. PDFs need a selectable text layer; scanned/image-only PDFs require a local OCR step outside LinkedOut. Password-protected PDFs are reported as unavailable evidence; no passwords are stored or guessed.

Keep `user.json` for identity and writing preferences: name, interests, audience, tone, language, and style examples. CVs and factual project history belong under `knowledge/`, not in preference fields. You do not need to copy this README into your knowledge directory.

Organize project notes into short paragraphs about the actual problem, your precise role, completed work, dates, and verified outcomes. Distinguish personal contributions from team contributions. Separate completed facts from plans, ideas, estimates and unknowns. A useful structure is:

```markdown
# Project name

## Confirmed facts

[Write factual statements you can support. Do not leave this placeholder.]

## My role and contributions

[State your actual contribution without inflating ownership or leadership.]

## Evidence and qualifications

[Explain the basis for dates/metrics, caveats and incomplete information.]

## Plans and unknowns

[Clearly label future intentions and questions; these are not completed work.]
```

Use declarative wording suitable for quoting verbatim: personal factual statements are included as exact evidence quotations in this milestone, not automatically paraphrased. Notes themselves remain untrusted, unverified reference material. Indexing a claim does not make it true.

Install Poppler's `pdftotext` locally for PDF support (`poppler-utils` on Debian/Ubuntu/Fedora, or `brew install poppler` on macOS). On Windows install Poppler via a trusted package/distribution and add its `bin` directory to `PATH`. Plain-text and Markdown support does not need Poppler. Keep the installed native parser updated through your system package manager.

```sh
npm run build
npm run knowledge -- index
npm run knowledge -- search --query "TypeScript reporting project"
npm run drafts -- create --brief "Draft a reflection on my TypeScript reporting work"
```

The application refreshes the index before new drafting requests. Only the best matching passages (at most six, no more than 6000 characters total, at most two per document) enter the generation request. Source IDs, relative paths, hashes, page/line references and exact excerpts are attached to the stored draft's provenance. Search results expose excerpts to your terminal; handle them as private information.

`knowledge/.index.sqlite` is a derived local FTS5 text index. Extraction uses short-lived files under `knowledge/.cache/`, cleaned after success or failure. All of `knowledge/` is ignored by Git, Prettier and ESLint. Existing source documents are never rewritten. On POSIX, the knowledge/cache directories and created index files are restricted to the owner; use normal account/file protections and disk encryption as appropriate. The application does not encrypt stored text.

You may set `LINKEDOUT_KNOWLEDGE_DIR` to an absolute path ending in `knowledge`. Keep that directory Git-ignored in any repository containing it. Custom directories with another basename are rejected to preserve the ignore convention.

Deleting or changing a source updates future retrieval. Previously generated drafts and execution history intentionally retain their original evidence snapshots in `.linkedout/`; removing a source does not erase those records or backups. Do not commit extracted text, indexes, caches, personal CVs, draft databases, or real private test fixtures.

Extraction, indexing and search run locally. Relevant excerpts leave the machine only in the existing configured LLM generation request, with `store: false` and the provider's documented retention limitations. There is no document upload API, embedding service, vector database, OCR service, or extra LLM verification call.
