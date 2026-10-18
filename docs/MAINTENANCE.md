# Keeping documentation current

Desktop profile migration tests exercise both Unix moves and the Windows copy
path. Keep the unused-folder allow-list conservative, preserve every set-aside
folder and its append-only receipt, and cover restart before and after the rename.
The CLI must remain read-only. Conflict guidance uses the host's English and
German catalogs and reports unknown book counts explicitly. Native Windows and
macOS verification remains separate from copy-path tests on Linux.
Missing book paths require a resolvable temporary ancestor; disconnected external
paths and temporary directories containing the home or profile must refuse.
Keep completed Windows migrations out of the set-aside path and count only books
that exist when explaining conflicts. Migration records prevent claiming that
nothing changed after a move or set-aside has started.
Pin the observed launch layout, the exact top-level HSTS cache exception, and
empty-only `spell/` handling; personally learned dictionary words must refuse.
Capture single-folder and two-folder guidance in both languages.

If an older book contains empty text runs from replace-all, the editor removes
those runs on load. The original database body stays intact until the next save;
no schema migration or manual repair is needed.

Format-write refusals leave the entire save batch pending. The protocol has no
per-entry refusal acknowledgement, so partial commits would lose unsaved buffers.
Restore and transfer preflights reject new nodes while retaining legacy bodies
and history; only incoming history bodies and changed replacement candidates
undergo strict write validation. Keep these recovery and mutation checks separate.

Retained-body readers must accept legacy empty text runs and unknown text marks
without rewriting stored bytes. Keep atom validation strict and test paragraph
search joining separately from the refusal to replace across a paragraph break.

Documentation is part of a change. The offline guard detects review obligations
and verifiable drift. It cannot establish that prose is correct, an editor
interaction works, or a live upgrade, restore, or rollback succeeds.

Figure retention checks use the proposed registry SQL only in disposable test
databases. Keep the production schema ceiling at 17 and new-node writes disabled.
Exercise history-only originals, canonical hashes, independent cast/cover
ownership, recovery, transfer, and loss-aware salvage before enabling authoring.

DOCX publication fixtures reuse the shared plan and validate native endnote
parts, settings separator declarations, scoped numbering starts, inline media,
and unchanged legacy bytes. Include a non-contiguous scope to exercise resumed
numbering. Validate generated packages and open them through an office reader.
The note-bearing interoperability fixture is LibreOffice-produced; native Word
qualification remains external. While conversion is disabled, both import routes
must retain develop's prose and counted note/picture losses, ignore note-body
parts, and store no atoms. Test the owned-note path separately with an isolated
open policy; its formatting, missing-body, and drawing losses count affected notes.

Scoped EPUB tests cover note restarts and placement, reference/backlink targets,
contents order, escaped figure text, relative PNG/JPEG media, and explicit
publication refusals. Set `GARRET_EPUB_TEST_OUTPUT` to a disposable directory
when running the publication and legacy export tests, then validate every emitted
file with epubcheck. The sample and three classic fixtures pin Markdown, Word,
and EPUB byte hashes; do not recapture those hashes to hide an export change.
Retained-body EPUB goldens exercise the destination writer with empty bodies,
missing content, inline breaks, and paragraph attributes; only the modification
timestamp is normalized. Mixed legacy/new-node fixtures keep tolerant prose
rendering separate from strict atom validation. Two chapters in one story
distinguish chapter and story numbering. Reject XML-forbidden characters in the
publication plan, without changing stored prose validation or the legacy renderer.
New-node publication fixtures do not enable production authoring or mirror output.
Export results report whether sibling assets were published; only those results
show asset-folder sharing guidance. Ordinary Markdown notices keep their existing text.
Markdown fixtures exercise the actual scoped render path, package publication,
relative asset resolution, reminted IDs, literal footnote syntax, placement
bounds, node ordering, BOM/CRLF handling, and disabled conversion through the shared
desktop/CLI import entry. Package destination-mode checks refuse Replace before
conversion or publication, and the native save route checks before opening its dialog.
Package tests plant a destination collision after originals become visible and
check that the staged Markdown survives without overwriting the external file;
errors name both the stage and any partially published assets folder. Hard-link
publication failures retain these paths instead of falling back to partial file writes.
The selected package root is canonicalized once. On Unix, asset resolution then
walks directory handles with no-follow opens so a symlink below that root cannot
redirect a component outside it.
Mirror fixtures cover matching-schema copies, relative media and format markers;
the unchanged existing reader's retained-extra-key behavior rejects those markers.
Stored-atom refusal remains independent of marker presence. Production new-format
mirror output refuses before creating a destination. Run the complete mirror suite
to retain the existing pause, conflict-copy, acceptance and undo checks.

## Checks

Run from the repository root with Python 3.11 or newer and Git:

```sh
bun run check:docs
sh scripts/check-docs --base origin/develop
python3 scripts/check-docs.py --explain
python3 scripts/test-docs.py
python3 scripts/test-docs-facts.py
```

The wrapper reuses the existing release version check, checks documentation
facts, then checks source impact. The plain command validates current receipts
and working changes. `--base` checks the merge-base-to-current PR range plus
staged and unstaged tracked files. Stage new source and documentation files
before accepting a receipt; ignored and untracked scratch files are excluded.
Missing tooling, unresolved bases, and shallow history fail clearly.

The required interface CI job fetches complete history and checks against the
actual PR base, or the previous push commit. The release prepare job also runs
the gate before packaging. Tag publication checks the complete range from the
previous reachable alpha tag and publishes the same checked source commit.

Release downloads are checked before `SHA256SUMS` is generated over all package
files and checksum sidecars. The publish job signs the manifest using only the
`release` environment secrets `RELEASE_GPG_PRIVATE_KEY` and
`RELEASE_GPG_PASSPHRASE`, in a
temporary GPG home that is removed after use. No key material is logged or
uploaded. A missing key blocks publication unless the repository variable
`ALLOW_UNSIGNED_RELEASE` is exactly `true`; a configured key that fails to sign
or verify always blocks publication. A signed release also requires removing
the unpublished fingerprint placeholder from both SECURITY.md and README.md.
Configure environment restrictions before the first signed tag, as described
in the signing policy. GitHub attestations cover the downloads,
manifest, and available signature before release upload. Only the publish job
has attestation and OIDC write permissions. The existing tag and CI eligibility
checks still apply. See the [signing policy](SIGNING.md) and
[verification instructions](../SECURITY.md#verifying-releases).

An optional local hook can call `sh scripts/check-docs --base origin/develop`
from an existing pre-push hook. Keep existing hook protections; do not replace
them or change the repository's hook directory just to install this check.
Local hooks supplement required CI and release checks.

Android packaging and the F-Droid draft share one unsigned build script with
pinned frontend tools, locked dependencies and deterministic path/time settings.
After changing tool versions or packaging, compare unsigned APKs from two clean
directories, then compare the independently rebuilt APK with the published
developer-signed release. Local determinism alone does not establish F-Droid
reproducibility. Follow the [F-Droid maintainer checklist](../fastlane/fdroid/README.md)
before submitting or enabling the disabled draft recipe.

The display-gated proof tests have per-test watchdogs on a separate OS thread:
90 seconds for rich paragraphs and typed dashes, and 180 seconds for notes, figures, and plates,
armed before GTK initialization and kept alive through process exit. The fixtures
run separately: a completed test body must not cancel protection while libtest
joins its worker and WebKit tears down thread-local run-loop state. Each render
leaves GTK from a low-priority idle callback so queued WebKit callbacks can
release their references before the worker exits. The watchdog reports the last
phase and thread wait channels before aborting, even if GTK stops dispatching
or thread teardown stalls. Core dumps are disabled
in these isolated test processes. Timestamped phase markers write directly to
stderr, bypassing libtest capture, including watchdog reports. The CI runner
uses `--nocapture` and prints its phase log on success or failure. Markers cover
compilation, Xvfb startup, test-process entry, GTK initialization, the watchdog,
WebKit creation, loading, pagination, render cleanup, test return, and Xvfb exit.
The paginator CI step runs the three fixtures in
separate processes under the same X display, with a 420-second
process timeout and 30-second kill grace, including compilation and startup.
Run `bash ../../../scripts/test-proof-paginator` from the host crate directory;
optional arguments select individual fixture names. Each invocation uses a fresh
HOME and XDG_DATA_HOME. Its diagnostic directory is printed before startup and
retains the phase log and Xvfb errors. Failures are not retried.
It uses an isolated X display, software rendering, disabled compositing and
DMA-BUF rendering, and no accessibility bridge.
CI native stacks locate the intermittent stall after the test body, in WebKit
run-loop thread teardown while libtest joins its worker. Deferring GTK exit
avoids the observed stall; #324 tracks the remaining native teardown risk.

Install Poppler tools for PDF text and image inspection. The publication fixture
checks delayed, rejected, and stalled figure decoding; damaged PNG/JPEG covers
remain non-fatal and never enter the decode barrier. Truncated mid-data PNG/JPEG
covers must retain a cover-page image in the printed PDF; a header-only fixture
cannot detect lost partial painting. The disabled-production PDF assertion must
require the explicit build refusal and fail when that gate is removed.
PNG eXIf and JPEG EXIF fixtures compare decoded dimensions,
placed aspect ratio, and DPI. Check heading companions on interior plates and
caption containment at the smaller, spaced caption size. Render and inspect
representative PDF pages after changing these placement rules. Production stays
at schema 17 with the write and publication gates closed; these fixtures add no
migration or activation.

The figure fixture also checks a visible gap above a figure following prose.
Page fitting reserves the figure's top margin as well as caption space. Verify
unsafe empty-registry salvage directories, unreadable-row PNG/JPEG copies, and
live/bin/history references without a figure table. Markdown package tests inject
unsupported hard links before asset staging and exercise both save-as and export
replacement refusals through the shared rendering boundary. A disappearing probe
link exercises cleanup of the empty stage after probe-file removal fails.
XML export fixtures cover all 31 forbidden characters, counted cleanup, unchanged stored bodies,
selected-story counts, identity checks after cleanup, and identical clean package
contents. Vertical-tab and form-feed cases preserve word separation with spaces.
Interface and subprocess CLI notices cover zero, singular, and plural cleanup
counts in writer-facing language. Replace-all's unknown-mark
fixture pins atomic refusal and unchanged history.

The non-required Windows PDF workflow builds the native host on `windows-2025`
with the opt-in `pdf-smoke` Cargo feature and seeds the sample through `--seed`.
Release and package builds omit this feature and its hook. A nonempty
`GARRET_PDF_SMOKE` opts into a separate Tauri event loop without an editor or
command bridge. Its existing absolute directory contains `sample.db`; the probe
rejects a symlinked root and confines its WebView2 profile, phase log, result
JSON, and `proof.pdf` to that directory. It refuses preexisting outputs and uses
the existing exclusive-create writer and page-count reader after rendering.
The result must have one PDF page per proof leaf. The probe has a 240-second
watchdog; worker disconnection is a separate error. The runner adds a 270-second
process bound and retains the PDF, runtime facts, logs, and timeout process
diagnostics even on failure. Export failures make the job fail; it remains
outside required branch checks. Path filters cover the renderer, hook, export
writer, sample, native dependencies, workflow, and runner script; manual dispatch
is also available. This exercises the export renderer and writer through a CI
hook; it does not exercise the menu, preview, or command bridge.
This check does not provide Windows CLI PDF support. Inspect downloaded PDFs
with `pdfinfo`, `pdftotext`, and rendered pages to verify trim size, folios, and
any fixture cover; runner evidence does not qualify every machine or font set.

macOS packaging retries the specific hdiutil resource-busy creation failure up
to three attempts, waiting 10 seconds between attempts. It prints disk-image
diagnostics and detaches only images from the current build's bundle directory.
Other bundler failures stop immediately. Signing, content verification and
release eligibility checks still apply.

## Source impact and assessments

The single domain map lives in scripts/check-docs.py. Inspect it with
`--explain`; docs/docs-impact.json stores source-bound assessments.

| Domain | Source reviewed | Documentation affected |
| --- | --- | --- |
| Editor | Desktop and mobile interface code, CSS, HTML | README and screenshot gallery |
| Project format | Store, manuscript import/export, transport and associated assets | README and compatibility guide |
| Schema | SQLite store and profile migration | Compatibility and recovery guide |
| Backup and recovery | Recovery, salvage, archives, readable mirrors and transfer | Backup instructions and compatibility guide |
| Encryption | Archive encryption and privacy boundaries | Archive/key and privacy guidance |
| Native packaging | Host/build configuration, dependencies, platform scripts and release workflow | Contributor and packaged platform instructions |
| Maintenance | Documentation guard, its tests and CI | This guide and contributor instructions |

Each affected domain needs a current source fingerprint and either mapped
documents whose bytes actually changed in the PR or a concrete no-impact
reason. Cited document hashes are bound too. Receipt edits alone, unchanged
documents, stale receipts, and baseline resets cannot clear an obligation.

After reviewing the source and updating the relevant documents:

```sh
python3 scripts/check-docs.py --accept editor --docs README.md,docs/screenshots/README.md --note "Explain the new navigation controls and replace the affected gallery images." --breaking none
```

A refactor can record its actual lack of user-facing impact:

```sh
python3 scripts/check-docs.py --accept editor --no-impact "Extract the existing selection helper without changing keyboard behavior, labels, or persistence." --breaking none
```

Commit the receipt with the source and documentation. Accept only after the
last source or cited-document edit. When branches overlap, review the combined
behavior and accept a new receipt; do not select a convenient old fingerprint.
Specific explanations remain review assertions, not machine-proven semantics.

## Format changes and migrations

Production schema definitions, migration functions, application-profile
migration, and project-format code are conservative review boundaries. Even
a refactor there requires a compatibility assessment; the guard does not
interpret SQL semantics. ZIP extractor compatibility is not the SQLite schema.

Update docs/COMPATIBILITY.md and the affected user instructions. Declare the
actual breaking consequence, or `none` when compatibility is preserved, and
supply a concrete `--migration` assessment covering compatibility, backup,
upgrade, and rollback. A sensitive change cannot use the no-impact path.
Describe what a writer must preserve and what rollback loses or restores.
State the actual isolated validation performed and any untested platform.

Project presets use the optional `project.preset` metadata key at SQLite schema
17, with no schema migration or preset conversion for rollback. Missing and
unknown stored values use novel defaults; preserve unknown values verbatim.
Backup snapshots, encrypted archive restores, portable copies, and salvage must
carry this metadata with the rest of the book, including per-story
`collection.author.<item-id>` public bylines. Collection stories are ordinary
outermost manuscript chapters; title/status remain item fields. Scoped exports
must share the normal preflight and crash-safe destination writer, rebase the
selected subtree, and exclude collection matter and covers. Android admits
collections because its scene placement already uses these ordinary containers.
Keep the complete closed-book
and profile backup and separate-copy rollback instructions in the
[compatibility guide](COMPATIBILITY.md) when reviewing later changes. A preset
assessment supplements the migration, backup, and rollback assessment for the
full checked range; it does not replace it.

Collection placement checks must distinguish the selected part's last story
from earlier and later stories, including nested parts and section chapters.
Check empty-part fallback separately. Statistics captures should show each group
heading on its own row with consistent spacing in light and dark themes.

Before release, run `sh scripts/check-docs --release` and review the complete
range. A later query-only or version-only commit cannot erase an earlier
migration obligation. The initial `--init --note` baseline records the existing
tree only; it does not certify historical documentation and cannot reset an
existing baseline or waive changes in a checked range.

## Facts and screenshots

The facts check validates common local Markdown/HTML links and Markdown
heading anchors, canonical CLI subcommand names, repository script paths, and
known package-script names. It inspects examples without executing them.
It does not fully parse shell commands or CommonMark, validate every argument,
check remote links, or contact companion websites.

The gallery manifest binds every PNG to its bytes, actual application version,
source revision, platform, and capture disclosure. Preserve original captures
and identify historical images explicitly; never relabel an older screenshot
as a new release. A matching hash cannot prove visual correctness or freshness.
Review the running app and inspect the affected captures when behavior changes.

PDF proofs keep typed two- and three-hyphen dashes together, including across
inline formatting and page boundaries. Longer hyphen rules retain their line
and page break points. The isolated display regression
`printer::tests::typed_dashes_stay_on_one_line_and_page` measures glyph positions
and checks that text and formatting survive pagination, including oversized
hyphen runs in prose and headings. This proof-only layout
rule does not rewrite manuscript text or change legacy export goldens.

The release registry checks its recorded tag, source version and platform
inventory offline. Updating it is an explicit observation of published state;
the guard cannot independently prove remote publication. Proposed features
belong in the separate development section until they ship.
