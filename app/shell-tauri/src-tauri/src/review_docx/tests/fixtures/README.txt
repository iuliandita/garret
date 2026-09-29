Review DOCX interoperability fixtures

handwritten.xml is a manually authored WordprocessingML revision document.
python-docx.xml contains runs and paragraphs produced by python-docx; generate.py
adds a scene content control and removes page-layout metadata outside
this format's strict subset. python-docx-version.txt records the producer.

The two .docx packages are independently assembled by Python's zipfile and XML
serialization, with manifest hashes calculated from the documented format. They
do not use the application's exporter. The corresponding -body.json files are
the accepted host baselines. Run generate.py with python-docx and lxml installed
to reproduce them. Archive timestamps are fixed for deterministic output.

The ignored Rust test review_docx_write_interoperability_fixtures writes actual
application exports to an explicitly supplied REVIEW_DOCX_FIXTURE_DIR. It is a
fixture generator for external XML validation and editor inspection, not an
interoperability assertion. Native Microsoft Word preservation remains untested.

python-docx-full.docx preserves python-docx's actual default package (styles,
settings, theme, and document properties) and attaches the review manifest and
comments relationship. The parser refuses its unsupported bibliography/numbering parts; the
stripped minimal fixture is not proof of compatibility with normal editor saves.

libreoffice-26.8 contains actual saved copies of the application's fixtures,
including structural changes and discussion. evidence.json is emitted by
inspect_saved.py from the original exports and saved packages; it records the
producer, hashes, parts, properties, and bookmarks. The source shared fixture
cases and extra-documents.json supply the independent accepted and proposed
bodies. These are save-preservation checks, not interactive accept/reject tests.

v1-lost-manifest.docx preserves the original failed save: the editor discarded
the custom XML manifest and changed the block control into an inline control.
Version 2 carries bounded, numbered manifest chunks in standard custom string
properties. The entire document body is one scene; content control topology
supplies no authority. Unknown parts and semantic markup still refuse. Known
unused MIME declarations and nonsemantic layout properties may be ignored.
Default or referenced styles that add marks refuse rather than changing text.

A paragraph bookmark may move between the outside of a paragraph and its text
edge during an editor save. It is normalized only when the immutable fragment
owns that Open/Close token and the returned marker is immediately at that same
paragraph edge. Exact expected positions and both old/new fragments must still
match after normalization. No quote search or approximate match is used.

Word comment IDs are document-local. An existing immutable message matches only
one returned comment with the exact author, body, rejected anchor range, and
accepted anchor range. Missing, changed, duplicate, or ambiguous matches refuse.
This permits editor renumbering without treating a Word ID as store identity.
Discussion that would require an out-of-paragraph comment reference remains an
explicit export refusal. Ordinary scene notes are also an explicit refusal.

The merge and cross-paragraph deletion fixtures were saved without an outer
content control. With that optional wrapper, LibreOffice moved their start
bookmarks across unchanged prefix text. Those original files remain under
refusals/ and must fail reconciliation. The exporter now emits body paragraphs
directly. Other saved fixtures also demonstrate that imported inline controls
are non-authoritative wrappers when the exact complete body still matches.
