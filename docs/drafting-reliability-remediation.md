# Drafting reliability remediation

Both audit failures were reproduced before implementation with failing tests:
ordinary segmentation split `12.5` and `v1.2.3`, and the real OpenAI SDK rejected
an otherwise valid body containing an unexpected `approved` field.

Ordinary and research drafting now share the existing research sentence unit
implementation: English `Intl.Segmenter` within original lines, retaining UTF-16
offsets and original text. Research segmentation and editorial policy are unchanged.
Ordinary reports record `sentence-segmentation-v1`; the ordinary pipeline fingerprint
includes this version. Existing records remain readable without reassessment or
migration. Same-version retries retain existing replay behavior; an old ordinary
idempotency key with a different pipeline fingerprint conflicts rather than silently
replaying an assessment made with different unit boundaries. Existing historical
research replay compatibility is unchanged.

The pinned OpenAI 7.15.0 SDK's `responses.parse()` invokes the Zod parser while
mapping response content. A strict-schema exception prevents returning the response,
so the previous body recovery branch was unreachable for extra fields or invalid
warning types. Generation now uses `responses.create()` with the same strict wire
schema, checks completion/refusal and an unambiguous single assistant text message,
parses JSON locally, and applies the same strict bounded domain schema. Planning
and assessment still use their existing strict SDK parsers.

On schema failure, only an independently valid bounded body can cross the provider
boundary. The returned body-only object deliberately lacks required warnings and
therefore fails DraftService validation. The existing atomic failure path stores it
as a private, blocked, non-publishable review artifact with application warnings and
generation provenance. No provider warnings, unexpected fields, validation details
or raw response are retained. No assessment or recovery model call occurs. Existing
transport retry policies are unchanged; schema failures do not cause retries.

Recovery is unavailable for invalid JSON (including truncation), missing/non-string/
empty/oversized bodies, refusals, incomplete responses or messages, multiple messages
or text parts, unexpected tool output, cancellation, and transport failures. Reasoning
items may accompany the single message but are ignored. Body validation retains the
existing trimming behavior. No heuristic JSON repair or partial extraction is used.

Sentence segmentation is not semantic entailment and depends on the pinned Node
24 runtime's ICU data. Ambiguous abbreviations may still yield conservative failures.
Line splitting cannot bypass the separate whole-sentence attribution guard. Complete
private-excerpt equality, whitespace-only evidence normalization, unsupported-fact
blocking, provenance and mandatory human review remain unchanged. Adjacent text
without sentence whitespace may now form one unit; limit tests use actual separated
sentences. Source excerpts spanning multiple units may still fail exact attribution.

Regression tests use synthetic evidence and the real SDK with local HTTP response
fixtures, including SQLite artifact persistence, restart/replay, redaction and no
extra model calls. They are not live OpenAI verification.
