# Evidence integrity remediation

GitHub release text retains Markdown and HTML as inert evidence. Removing
HTML-like substrings could delete comparisons, qualifications and generic type
notation. Control-character cleanup and excerpt limits still apply. Stable
release identity and provenance are unchanged; content hashes reflect the
preserved text on subsequent fresh retrievals. Existing records and cached
snapshots are not rewritten.

Private attribution in ordinary assessment, editorial assessment and legacy
grounding now requires equality with the **complete retrieved excerpt**,
allowing only whitespace normalization. A substring, even a complete sentence,
can omit negation, speaker attribution or a later qualification. Neither word
boundaries nor sentence segmentation establish semantic support. Public research
cannot satisfy this private check.

Body bindings also require a complete sentence; line breaks cannot detach a
speaker or qualifier, and technical-token dots cannot manufacture a claim
boundary. Legacy grounding permits surrounding quotation/Markdown delimiters
but rejects attached introductory clauses.

This deliberately increases false negatives: a legitimate sentence inside a
longer excerpt, an excerpt split into multiple assessment units, or an excerpt
above the existing 1500-character quote limit cannot receive exact-match status.
The system does not infer entailment or determine whether a source's first-person
speaker is the owner. Complete quotations still require human review, and
attribution never verifies truth. Retrieval may itself lack surrounding document
context; this change does not redesign retrieval or establish document authorship.

The ordinary and editorial grounding policy versions are bumped so new generation
fingerprints include the stricter policy. Historical report types remain readable;
records, migrations and historical replay compatibility are unchanged. Reusing an
idempotency key with a changed effective fingerprint follows the existing conflict
policy rather than silently replaying an older assessment.

Regression tests use synthetic private excerpts and local GitHub fetch fixtures.
They cover ownership substrings, negation, attribution, punctuation, Unicode,
line boundaries, exact quotations, release content hashes and provenance.
