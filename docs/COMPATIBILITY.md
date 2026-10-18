# Compatibility and recovery

SQLite schema: 18. The reader ceiling and creation/migration target share one
version constant. The 17-to-18 ladder step uses the same figure-registry SQL as
the schema-18 reader fixtures. On desktop, opening an existing book for writing requires consent before upgrading to 18;
read-only operations never migrate. Schema 19 and higher refuse before writable
setup. An existing schema-18 book keeps its registry and version unchanged.

Restores preserve format 17 (older schemas advance only to 17 for recovery
bookkeeping), or preserve an existing format 18. Open a restored format-17 book
with the previous package for rollback; the new application asks before upgrading
it again. Android creates and opens schema-17 books without upgrading or writing
an upgrade copy; existing schema-18 books remain 18. Android transfer imports
preserve the source schema (17 stays 17; 18 stays 18), without modifying the archive.
Android has no upgrade consent prompt.

Before an older book opens for writing on desktop, an app-owned dialog explains
the format change and requires an upgrade decision. Startup defers that opening
until the interface can ask. Consent first retains a complete verified `.point`
bundle beside the book, including history, cast/cover originals and retained
research. A missing original blocks migration. Failed attempts clean up their own
stages and incomplete output; unrelated stages do not block retries. Free space is
checked when available; an unavailable capacity query leaves write-time failure
handling in charge. A process crash can leave a private `.garret-backup.stage-*`
directory. It does not block retries and is not reaped automatically. After closing
every garret process, inspect abandoned stages and remove only stages whose
contents are no longer needed; they can contain plaintext writing and originals.
Completed `.point` bundles are separate and must be kept. Cancel keeps the book at
its previous format. Originals remain untouched. Keep the complete database,
adjacent originals and profile before upgrading an installation, and try a
disposable copy first.

Desktop authoring supports plain-text endnotes and explicit scene breaks.
Choose Edit > Insert or edit endnote, or press Ctrl+Alt+N (without Shift); this
chord is reserved for endnotes in both interface languages. A numbered reference
also opens the anchored textarea. Enter inserts a newline; Save commits one
isolated undo step; Cancel or Escape discards the draft. A failed save keeps the
draft available. Leaving a scene or book requires Save, Discard or Cancel.
Edit > Endnote numbering chooses book, chapter or story; editor and publication
numbers derive from that scope and the manuscript reading order. Collections
default to story numbering. Identifiers remain stable through edit and undo.

Edit > Insert scene break creates an explicit block rendered as `* * *`.
Literal typed asterisks remain ordinary prose. Select a note or break and choose
Edit > Delete selected note, figure or scene break to delete it; undo and redo retain
its content. Edit > Insert or edit figure opens the native PNG/JPEG picker;
each insertion retains an independent, durable original and registers it before
placing the figure. Cancel leaves no placement and retains an already copied
original. Figure properties are available on the figure and through the Edit
menu. Full text width, half text width and a separate interior page are supported,
with caption and alternative text. Saving or editing is one isolated undo step.
Empty alternative text may be saved as a draft, but blocks publication.
Properties estimate print DPI from the oriented pixels and book dimensions;
the PDF proof measures the actual placed size, including caption space. Below
300 DPI warns; below 200 DPI is flagged. Originals are never automatically removed.
Retention checks count and total bytes before decoding a newly picked image.
A crashed import can leave originals without a database; a later creation skips
that occupied name and preserves the orphaned originals for inspection. A figure
preview blocked by a failed save reports that save failure rather than claiming
the original is missing.

Android can read notes, figures and scene breaks; open a numbered note to read
its body; edit surrounding prose; save, close and reopen; and import/export a
complete archive. Android cannot insert, edit, delete, duplicate or reorder these
atoms through its editor. Its UI retains the reader's atom-preservation guard.
Android checks schema first, then book type: absent, novel, short, nonfiction
and collection are supported; empty and unknown presets refuse. Desktop can
retain an unknown preset, but it cannot send it as a supported mobile book.

For a device copy, use Books > Copies > Export book for another device and
check the app version on the receiving device first. Android export requires
the same explicit capability check. Unknown capability refuses; update or check
the receiving app before retrying. The host checks the source schema before
preset support and before opening destination pickers. The 0.0.6 capability
supports format 18 and all four current book types; the legacy capability stops
at 17 and novels. These are manual version checks, not device discovery or sync.
Ordinary recovery and encrypted backup creation remain available independently.
The recipient rechecks the staged database before publishing a separate book.

Complete backups, encrypted archives, restores and transfers retain schema 18,
exact atom payloads, history and registered originals. Markdown packages, EPUB,
DOCX and PDF use the shared publication plan. Empty figure alternative text
blocks publication; missing or changed originals refuse. DOCX and marked
Markdown imports preserve plain-text endnotes and explicit breaks. Figure-package
import verifies and retains relative originals before publishing the separate book.
New-format readable-folder copies require schema 18 and carry `document_format: 18`,
notes, captions and relative hashed originals beside each scene. They are one-way:
marker removal does not allow inbound replacement of atom-bearing scenes. Ordinary
scenes remain bidirectional. Pauses, conflict copies and undo protections remain;
changed asset bytes are retained and refuse replacement. Blank-alt drafts remain
readable-folder copies while publication still refuses them. Salvage retains readable notes, figure links, breaks,
verbatim JSON for affected current/named documents and registered originals;
automatic-version drops remain reported. Salvage is not a downgrade route.

Apps 0.0.5 and earlier refuse schema 18. Release 0.0.6 reads and preserves it,
including new writing in surrounding prose, but has no atom authoring. To roll
back, keep the upgraded book separately and restore the complete pre-upgrade
schema-17 copy as a separate book with the previous package. Writing after
upgrade is absent from that copy. Never lower `user_version`, overwrite the
newer book or delete its originals. A schema-18 archive cannot restore into a
schema-17 app; update the receiver or use the retained pre-upgrade copy.

Host tests cover migration, cancellation, incomplete-copy refusal, independent
originals, history, transfer checks and schema-specific writes. Interface tests
cover isolated note undo, failed drafts and explicit scene-break deletion.
`scripts/android/reader-fixture OUTPUT_DIRECTORY` generates a synthetic encrypted
archive and separate key for reader qualification. The owner has qualified the
0.0.6 reader on a physical phone. Android authoring and Windows/macOS native
qualification remain separate work. First-launch Android activity recreation
is tracked in [issue 403](https://github.com/iuliandita/garret/issues/403).
`design-apply` requires schema 18; older books require consented migration first.
Batch saves and retained-document validation share one schema/registry read.

Proof paginator test diagnostics use isolated temporary profiles and timestamped
phase logs. They do not change PDF output, stored books, profile migration, or
the application's rendering settings.

Shared restore normalization, preset validation, and canonical UUID checks retain
their existing acceptance rules and errors. These helper cleanups add no migration
and leave stored books, transfer formats, and rollback requirements unchanged.

The schema-18 reader shares figure UUID validation and one reader-version export.
Legacy-node refusal and picture-paste detection retain their existing acceptance
rules, including the file-list fallback. These cleanups do not enable authoring,
change stored data, or add migration, backup, upgrade, or rollback steps.

EPUB and DOCX exports replace vertical tabs and form feeds with spaces and remove
the other XML 1.0-forbidden characters from prose, item and book titles, contents
labels, collection bylines, and EPUB author, sort name, publisher, and rights in
the exported copy. Front and back matter, including References, use the same
cleanup. Prepared publication exports also clean note bodies, captions,
alternative text, and note headings; production publication uses the same cleanup.
The export result adds `xml_characters_removed`, counting both replacements and
deletions; the interface and CLI explain a nonzero count in plain language.
Stored prose, titles, metadata, marks, history, and ordinary XML
whitespace remain unchanged. Fixtures without these characters retain identical
output bytes. Identity preflight inspects cleaned prose, titles, names, and metadata. Export
word counts inspect the cleaned prose.
Markdown and PDF prose are unchanged by this cleanup.
Each source field is counted once even when repeated in headings, navigation,
or OPF metadata. DOCX emits no core/app properties, headers, or footers.
Markdown and PDF titles and metadata are unchanged by this cleanup.

Backup reports figure references in live, bin, and retained history bodies even
when a schema-17 database lacks the registry table. An unreadable row with a
safe figure UUID retains both PNG and JPEG filename candidates in the incomplete
inventory so any available originals are copied. Missing candidates remain gaps;
this never certifies damaged metadata. Salvage reports an existing unsafe or
unreadable pictures directory even with no registered figures. Without a registry
table, bodies without the substring `figure` bypass reference parsing.

Only a format marker on the first line selects the garret Markdown dialect
(with an optional BOM). Unmarked files containing garret comments import as
ordinary Markdown. A Markdown package requires filesystem hard links; the host
probes support before staging originals or creating the published assets folder.
An unsupported filesystem produces a plain refusal and leaves no probe debris.
Probe-file cleanup failures also attempt to remove the empty staging directory.
Existing uncertain publication stages remain retained for inspection.

Replace-all still refuses a body with unknown marks and rolls back the whole
transaction, including its snapshot and history rows. Readability fixtures pin
explicit exceptions independently of the structural validator.

PDF figures have a 0.6em top margin, included in their page-fit calculation.
EPUB already gives figures 1.5em vertical margins. Legacy proof output is unchanged.

Prepared PDF publication reuses the shared scoped publication plan for endnotes,
figures, captions, and scene breaks. Notes follow their scope, never the bottom
of a page. Full and half figures fit within the text column; page figures use a
separate interior leaf with normal margins and a folio. Images preserve their
decoded aspect ratio without crop or bleed. Captions have 0.4em of space above
and use 0.9em type in PDF and EPUB. Images shrink to retain that caption size,
and an unfit caption refuses the proof. Pagination waits only for figure image
decoding; failed figure decoding refuses the proof under the existing timeout.
Covers are never passed to `decode()`, preserving legacy partial-image painting
for truncated originals. Damaged legacy covers remain non-fatal. A heading group
directly before an interior plate travels with it.
Legacy prose rendering and existing proof fixtures retain their behavior.

An advisory native Windows CI probe exercises the existing GUI PDF renderer and
destination writer on a disposable seeded sample. It records page and leaf
counts, requested trim dimensions, font resolution, and bounded diagnostics;
downloaded output still needs geometry, text, and visual inspection. This adds
no book migration or Windows CLI PDF support. Keep closed-book backups and
adjacent originals before upgrading; rollback uses the previous package with a
separate complete copy. Runner verification does not qualify other WebView2
versions, font installations, or individual machines.

The paginator reports effective DPI for each figure from oriented pixels and its
actual placed size. Below 300 DPI is a warning; below 200 DPI is also flagged.
These advisories do not block publication. A 1200 by 1800 image is 300 DPI at
4 by 6 inches, 200 DPI at 6 by 9, and 150 DPI at 8 by 12. Decoded image dimensions
determine whether pixel axes swap before calculation. WebKit applies JPEG EXIF
rotation but retains raw PNG dimensions for PNG eXIf; the proof follows that
displayed geometry. EPUB retains the original PNG and DOCX uses its raw drawing
dimensions. Preview reports include per-placement `figures`
with item and instance IDs, DPI, warning, and flag values. Existing schema-18
books can publish these nodes. Release 0.0.6 keeps authoring disabled and creates
schema 17; the current activation described above creates schema 18 and requires
consent before upgrading existing writable books. Native Linux output is exercised under a virtual
display; Windows and macOS layout qualification remains external.

Release 0.0.6 imports DOCX as prose and reports omitted notes and pictures.
Current activation converts footnotes and endnotes to owned plain-text endnotes;
note formatting and unsupported pictures remain counted losses. Keep the original
DOCX to retain its formatting and pictures. Import creates a separate current-format
book. Back up closed books and adjacent originals; rollback uses the previous
package with a separate complete pre-upgrade copy.

Prepared DOCX publication uses the shared plan for native endnotes, scoped
numbering, inline pictures, captions, alternative text, and scene breaks. Legacy
DOCX bytes remain unchanged. Existing schema-18 books can publish these nodes;
new-node conversion and authoring remain disabled. Scoped publications include section restart settings and native
custom note marks so readers that ignore those settings still display the plan's
numbers. Those custom labels are fixed at export; after editing notes, export
again to derive their numbering. LibreOffice opens native notes with these
labels but collects them at the document end rather than each section end.
Microsoft Word placement and editing behavior still need native qualification.

The prepared importer keeps Word footnotes and endnotes as independent owned
plain-text notes with new IDs. Prepared export/import preserves note-body
whitespace and line breaks without adding marker text. It reports affected-note
counts separately for
flattened formatting, missing bodies (empty notes retained), and dropped note
drawings. It does not preserve rich-note formatting. The interoperability fixture
was written by LibreOffice, not Microsoft Word; native Word import qualification
remains external. The CLI JSON loss object adds `note_formatting`,
`missing_note_bodies`, and `note_drawings`; human-readable notices name each loss.

Restoring a backup or transferring a book preserves legacy document bodies and
history, including empty text runs. The copy is refused if a stored document or
version contains the new node types, and the refusal names its item ID. History
restores normalize empty runs before validating the body being written. Unchanged
snapshot rows and documents untouched by replace-all are left alone.

A refused save keeps the batch atomic: the interface cannot acknowledge partial
success safely. Saving stops with the scene's name in English or German, and the
unsaved text remains in the editor and pending buffers. Keep the book open and copy
the text before restarting; the phone's recovery-copy action remains available.

This describes the current source. [Published releases](RELEASES.md) are
recorded separately; a change on develop is not a published download.

New and changed prose bodies are validated before saving or restoring a
batch. Unsupported nodes, marks, and attributes are refused without changing
the book. New-node authoring remains disabled. Schema-17 books retain the
strict write refusal; existing schema-18 books use the preservation policy above.
This adds no migration or upgrade. Existing supported
documents remain compatible. Keep closed-book backups using the steps below;
rollback uses the previous application and a complete backup copy.

Figure-original retention is prepared without enabling figure authoring or a
schema upgrade. The proposed registry migration runs only in isolated tests.
Shared backup checks include every registered original, even when abandoned or
referenced only by the bin or automatic history, and compare its SHA-256 against
the copied database. Missing mappings, unreadable references, missing files, and
hash mismatches make a copy incomplete. Cast and cover deletion cannot remove
figure-owned originals. The archive envelope remains version 2; legacy archives
remain readable. Supporting salvage preserves unknown bodies verbatim, writes
readable notes and figure placeholders with relative original links, and retains
registered originals even when automatic text versions are omitted. Salvage
reports those omissions and layout losses; it is not an editable downgrade.
Legacy bodies retain the existing readable Markdown fallback, including unknown
marks. Read-only database integrity checks accept retained unknown text marks
and empty runs without rewriting the bodies. Atom shapes and note formats remain
strict; figure mapping and original completeness are checked separately against
the copied database. Production writes and database restoration still enforce
the disabled new-node policy. A damaged original is copied with a
`corrupt_figure_original` loss and its recorded hash kept for diagnosis. An unreadable registry row or directory records
a loss without stopping the remaining recovery. The salvage manifest adds
`figure_assets_recovered` and `figure_originals_recovered` counts, plus `figures`
for the relative registry filename, or null when no registry was recovered.

Consumers are prepared for endnotes, figures, and scene breaks using isolated
fixtures. Search keeps prose, note bodies, captions, and alternative text in
separate fields. Adjacent prose paragraphs retain their searchable space;
atoms and attribute fields stop a match. Replacement refuses matches spanning
paragraph breaks and never edits attributes. Word counts
exclude attribute text and count neither references nor block atoms as words.
History compares note, caption, and alternative text separately from prose.
Review proposals retain complete atoms and refuse affected review Word handoffs.
Clipboard copies remint instance IDs and reject duplicate IDs; figure pastes and
copied atom drops are refused until original transfer is available. Phone recovery
copies retain note text, captions, alternative text, and figure placeholders, and
state that formatting, structure, and originals are omitted. These reader changes
keep the schema-17 creation target and the schema-aware preservation policy
described above.

EPUB export prepares scoped endnotes, figures, and scene breaks through isolated
fixtures. Notes use book, typed chapter, or collection-story numbering; selected
stories include only their own notes and verified originals. Figure media uses
relative hashed names and declared MIME types. Endnotes include reference links,
backlinks, and contents entries; a page-width preference is a reflowable break
hint. Bodies containing new nodes use strict publication validation, refusing
unsupported content, unresolved figures, missing or changed originals, blank
alternative text. Direct publication-plan inputs still refuse XML-forbidden
characters; EPUB/DOCX export copies clean them before building that plan. Bodies without new nodes keep the existing tolerant EPUB renderer, including
empty bodies, missing content, inline breaks, and paragraph attributes. Unknown
note-numbering metadata does not block legacy exports or preflight. Existing
sample and classic Markdown, Word, and EPUB exports retain their byte hashes. This does not enable
new-node authoring, Markdown conversion, or new-format readable-folder output,
and adds no production migration. Existing schema-18 atoms can be saved unchanged. Keep the closed-book backups described below;
rollback uses the previous build and complete copy. Reader popup behavior and
native reading-system qualification remain unverified.

Markdown publication fixtures reuse the scoped publication plan for footnote
references and definitions, relative hashed PNG/JPEG assets, captions, scene
breaks, and bounded figure placement metadata. Literal footnote syntax remains
escaped prose. The matching package reader remints instance and asset IDs and
resolves originals only below the selected Markdown file's parent directory;
the selected parent is canonicalized once, so a symlinked user folder works,
while absolute paths, traversal, URLs, and symbolic links below it are refused. The desktop and
CLI refuse marked new-format conversion before creating a book while authoring
is disabled, including marked files with a leading UTF-8 BOM or CRLF line endings.
Ordinary Markdown keeps its existing BOM and line-ending behavior, and ordinary
Markdown and Word output retains its existing byte hashes.

Keep a Markdown file and its adjacent `assets` folder together when sharing.
A package export stages originals beside the destination, publishes them before
the Markdown file, and refuses existing destinations or asset folders. Asset-bearing
packages refuse Export as during the pre-save check, before the native dialog can
ask about replacing a file; use Export manuscript in a folder without `assets`.
A failure after staging keeps the stage and reports its location and any partially
published assets folder; preserve both until the
outcome is known. It never overwrites an existing package to resolve a collision.

Readable-folder output refuses the entire pass before writing any files when
any stored document contains endnotes, figures or scene breaks. The background
caller records one persistent failing-folder status; it does not emit repeated
notices or save-failure banners. An explicit enable attempt reports its refusal
once. Subsequent scheduled attempts may retry and log the same failure, leaving
the folder stale and the book untouched. Turn the folder off until authoring
activation provides this output. Production emits no `document_format: 18`
front matter. Matching-schema output with relative hashed assets exists only
in isolated tests. The existing inbound reader retains unknown keys and refuses
every document-format marker; stored atoms also prevent acceptance after marker
removal. Ordinary books keep their existing bidirectional, pause, conflict-copy
and undo behavior. Removing a marker and importing as ordinary Markdown is a
lossy conversion, not a mirror round-trip.

The default `garret search book.db QUERY --json` result adds a `locators` array
to each hit, retaining the existing keys. Each locator contains `field`,
`item_id`, `instance_id`, `from`, and `to`. Consumers that require an exact key
set must accept this additive change. Ranges use UTF-16 code units, with an
inclusive `from` and exclusive `to`. Prose ranges are absolute document positions,
including structural positions, rather than offsets into flattened text or the
snippet; prose locators have a null `instance_id`. Attribute ranges for `note`,
`caption`, and `alt` are relative to the start of that field, and `instance_id`
identifies the endnote or figure. This changes CLI output without a schema
migration or book conversion.

The command-line `design-apply` operation requires the exact current SQLite
schema. Open older books in the application to upgrade them before applying a
design; a preview token cannot bypass that requirement.

## Before upgrading

Close every instance of garret. Make a separate copy of each manuscript's
`.db` together with its adjacent `.pictures` and `.research` folders. Keep
the old application package and a copy of its settings and recovery folder.
Keep encrypted archive recovery keys separately. A database-only copy omits
original pictures and research; a recovery point on the same device does not
protect against losing that device.

## Upgrade and compatibility

For installed builds, close garret and run the new installer or use your package
manager to upgrade. Removal keeps manuscripts, settings and recovery data; it
does not replace a backup. For portable builds, extract into a separate folder,
keeping the interface
files beside the executable or inside the macOS bundle. First open a disposable
copy of a book and check its prose, outline, pictures, research, and exports.
Opening a supported older book can upgrade its SQLite schema. A newer schema
is refused by an older build; do not edit `PRAGMA user_version` to bypass this.
Static version checks do not establish that every legacy book upgrades correctly.

0.0.1 through 0.0.6 create SQLite schema 17; 0.0.6 also opens and preserves schema-18 books. The 0.0.2 DOCX importer adds
archive expansion limits: 128 entries, 128 MiB combined, and 64 MiB per entry.
An oversized foreign document can now be refused. Preserve the original and
split or simplify a copy before retrying; do not bypass the limits. This does
not change the stored manuscript schema or require converting existing books.

Book-wide replacement with an empty value removes the matched text runs and
keeps empty paragraphs readable. Scenes containing empty text runs left by
0.0.3 reopen automatically: the editor normalizes them on load, without changing
the stored body until the next save. This requires no schema migration.

New desktop books can start as a novel, short fiction, nonfiction, or collection. The
optional `project.preset` metadata key adds no schema migration: a missing or
unknown value uses novel defaults, and unknown values remain stored unchanged.
Older desktop builds ignore this key and show novel tools. Short fiction starts
with one scene at the root; nonfiction uses the non-fiction book design and
keeps fiction tools under Planning > More. Reference notes use the same stored
section as the Bible. Existing books and their data are unchanged.

A manuscript consisting of one scene, optionally inside its chapter and part,
exports without generated contents in Markdown, EPUB, PDF proof, and Word.
Only empty or automatically numbered outline headings are omitted; titles
written by the author still export. Front and back matter keep their headings
and EPUB navigation entries. EPUB omits body entries from its navigation
document and keeps that document outside the reading spine. The first scene
paragraph keeps its drop cap when enabled by the book design; an ornament is
omitted with its heading, and PDF running heads fall back to the book title.
Adding another scene or a separate section restores normal outline headings
and contents. These are export defaults, not changes to saved prose.
Complete backups, encrypted archive restores, salvage, and portable book
copies retain the metadata key verbatim.
Use the closed-book backup and disposable-copy upgrade steps above; rollback
to an older desktop build needs no preset conversion. Android preset support
is handled separately; do not assume an older Android build understands it.

Collections use ordinary chapter containers as stories. The outermost chapters
in the manuscript are stories; nested chapters remain sections. New story follows
the selected story in the same parent, without an automatic part. Scenes stay in
the selected story or section, or follow a selected scene in its container.
With a part selected, a new scene appends to the last story inside that part.
An empty part gets a new numbered story containing the scene, as one undoable
step. A part containing only loose scenes and other selections outside a story
use the nearest preceding story in outline order; no selection uses the last
story. If the fallback finds no story, a new story holds the scene, inside the
selected part if any.
Each story keeps its existing title and revision status; navigator counts sum
its scenes. Right-click a story (or press Shift+F10) and choose Story details to
edit its title, optional public author, and status, or save and export it alone.
The optional author is stored as `collection.author.<item-id>` metadata. It
travels with backups, archives, transfer and salvage; enter only a name intended
for publication. Older desktop builds retain it but show ordinary chapters and
omit story authors from exports. Older Android builds can refuse collections;
update before transferring one to the phone.

Whole-collection exports list stories and their explicit authors in contents,
with each explicit author below the story heading. Collection front/back matter
and covers appear once. Exporting one story uses its title and its author, or
the book's pinned pen name when the story author is empty. It inherits book
typography, but omits collection covers, front/back matter, and other stories.
A one-scene story has no generated contents page or default scaffold headings.
EPUB stores its effective author as creator; all four formats print its byline.
An explicit story author omits the book pin's other identity and publishing
fields. Falling back to the book author retains that pin's export fields.
The CLI supports `garret export book.db story.epub --format epub --story ID`;
use the `stories` list in `garret inspect book.db --json` to find each live story's
`id`, `title` and `author` (or null when inherited). A whole-book export omits
`--story`. The `garret preflight` command checks the whole book and does not
accept `--story`.
DOCX contents are generated only for a whole collection. Scoped EPUB identifiers
combine the book identity and story ID. Only chapter items receive chapter
openers in scoped exports. No export changes stored book metadata.

Collections introduce no schema migration. Keep the complete closed-book and
profile backup described above. Rollback needs no conversion; preserve the
upgraded copy and use the previous package with a separate pre-upgrade backup.
Changes made after that backup are absent from it. Android editing uses the
same scene containers and retains story author metadata; story creation,
publication fields and scoped exports are desktop features.

Chapter openers add three optional words to a book's stored chapter options:
`ornament-above`, `sink-third` and `sink-half`, plus three more ornament names.
The SQLite schema is unchanged and the defaults of existing books are
unchanged: ornament below the title, chapters starting at the top. The sink
means a chapter opening starts a third or half of the way down the text area
(the page inside its margins, a proof's text block), measured from the top of
that area; in an EPUB it is relative spacing and a reading system decides the
page. PDF pagination changed on purpose: a heading, the heading above it and
any adjacent ornament now move to the next leaf together instead of leaving a
heading at the foot of a page, so some proofs gain a page. An older build
ignores the words (the ornament sits below the title and chapters start at the
top of the page), draws no ornament for the new names, drops the words if it
saves the chapter options, and refuses a book-design transfer file that
carries them.

The desktop profile now uses `garret` instead of `cc.local.app`, preserving a
compatibility link after migration. Close older versions before first launch.
On Linux, macOS and Windows, an unused newer folder is kept as a dated sibling
named `garret.set-aside-...` before normal migration continues. Only settings
without non-temporary book references, lock/focus files and explicitly
recognized browser cache/storage directories qualify. The exact top-level HSTS
cache `hsts-storage.sqlite` and its `-wal`/`-shm` companions also qualify, as does
an empty `spell/` directory. Any file in `spell/` refuses: rendered project
dictionaries and personally learned words share that location. Unknown entries, other database
files (including SQLite and local-storage suffixes), book/recovery/import/export folders, dictionaries, identities and encrypted
backup preferences still stop migration. The CLI only explains; open the app to
perform the move. A synced, append-only sibling receipt records each attempted
set-aside before an exclusive atomic rename. Interrupted attempts retain all
folders and receipts, and normal migration resumes on the next app launch.
The success notice is logged without interrupting startup. Real conflicts show
the existing folders and counts of books found on disk in English or German, with an
explanation when books cannot be counted. Missing paths on disconnected storage
still stop migration; only missing paths whose nearest resolvable ancestor is
temporary qualify. Temporary storage must not contain the home or profile folder.
A completed Windows migration is never set aside again. Keep both folders and
request recovery help at the address shown. When the newer folder does not exist,
the message names only the older folder and asks you to keep that folder.
Back up both closed profiles before upgrade or recovery. For rollback, retain the
set-aside folder and complete migrated profile, then use a separate pre-upgrade
backup with the previous package; do not overwrite newer writing.
Android uses the separate package move described below; desktop profile migration
is not sync. Windows and macOS native upgrade behavior still needs platform testing.

The desktop application identifier is `com.usegarret.app`. This changes the
Linux menu-entry identity and macOS bundle identity without relocating books,
`settings.json`, recovery copies, or single-instance ownership. Linux keeps its
WebView data in the `garret` profile; Windows keeps its existing WebView2 data
under the local application-data directory's `cc.local.app` folder. Android also uses `com.usegarret.app`, which creates a separate sandbox from
the old Android package.

On macOS, the new identifier starts fresh WebKit and HTTP caches, temporary
caches, and native window positions and restore state. The previous native window
positions and restore state do not carry over. Old `cc.local.app` entries in your
home Library and temporary folder are left in place; garret does not move or
delete them. Books and application settings are unaffected: garret keeps its
preferences in the existing `settings.json`, and the desktop interface does not
store writing or settings in WebView localStorage or IndexedDB.
Linux old-to-new book and settings reuse is exercised on disposable data; macOS
and Windows native upgrade behavior still requires testing on those platforms.


On Windows, the uninstaller's optional "Delete the application data" checkbox
removes only `%APPDATA%\com.usegarret.app` and
`%LOCALAPPDATA%\com.usegarret.app` for the current user. It also clears installer
registry preferences. Neither directory contains books or settings: those remain
under `%APPDATA%\garret` (including its library and recovery files), or in a
folder you selected. The single-instance lock remains under
`%APPDATA%\cc.local.app`, and the pinned WebView2 profile remains under
`%LOCALAPPDATA%\cc.local.app`. The checkbox does not remove those folders and
is not applied during an installer upgrade.

## Android transfer and updates

Android now uses `com.usegarret.app` instead of `cc.local.app`, keeping the
same signing key. It installs alongside the old app and cannot access its
private books. First update the old package to the transfer-capable 0.0.3
release, export every complete book archive and its separate recovery key,
then install the new package and import. Compare manuscripts, notes and pictures
before removing the old app. Preferences must be set again; there is no sync.
See the [step-by-step move](../scripts/android/README.md#one-time-package-move).

Release preparation must increase the version and Android version code without
resetting the sequence for the new package. Updates within one package require
the same signing key. Do not uninstall or clear app data to update: both delete
private books. Keep exported archives and separate keys for rollback. Before
new edits, the old app still holds the original books; later edits require a
fresh export/import into a compatible transfer-capable build. Android normally
refuses a lower version code; installing an older APK is not a recovery method.

Transfer reuses the desktop binary age archive and complete point bundle.
There is no new schema or archive format. Every import creates a fresh owned
book identity while retaining source lineage, prose, history and originals;
a matching lineage never authorizes replacement. A changed archive or bundle
invalidates its preview. Imported books use separate catalog entries.

Before any writable opening or migration, Android refuses a newer database
schema first, then checks the raw `project.preset` metadata. Library probes read the SQLite header without copying the database. Closed
books use immutable read-only connections; books with pending WAL data use a
WAL-aware read-only connection with `readonly_shm=1` and require an existing
shared index. They create no library sidecars and have no transfer-size or
free-space admission limit. SQLite can update read marks in an already mapped
shared index when another connection in this process owns it. Database bytes,
originals and catalog entries stay unchanged on refusal. A WAL without its
shared index, or a pending rollback journal, is reported as unavailable rather
than repaired during a probe; preserve the complete files for desktop recovery.
An unreadable library neighbor is flagged and skipped during related-copy
inspection, so it cannot block a separate import. Import checks authenticated archive metadata and the staged database
before creating any library file, originals directory or catalog entry. Absent values and exactly `novel`, `short`, `nonfiction`, or `collection` are supported.
Empty and unknown values are refused
with an English/German explanation. Desktop leniency for unknown presets does
not change this Android release's capability. Use desktop for those projects.

New scenes follow the active scene in its current container. Chapterless short
fiction keeps scenes at the manuscript root without creating chapters or parts.
Nonfiction uses the same writing and reference data; its preset is preserved.
This change adds no schema migration or preset conversion for rollback.

Import is bounded while reading and extracting: at most 1 GiB ciphertext and
512 MiB plaintext payload, plus a free-space allowance for verification and
copying. Storage failure, incomplete originals, invalid authentication, newer
schemas and stale sessions fail closed. Publication moves and syncs originals
before the database becomes visible; unsupported exclusive-rename kernels
refuse publication. No existing book is overwritten.

A recovery key is a separate text file limited to 512 bytes. Selecting a book
archive in the key picker reports a recovery-key error; it does not mean the
book exceeds the archive or payload limits. A key that does not open the archive
also reports a key error. Extraction maps only its explicit size-limit errors to
the book-size message; verification details containing the words "too large" remain
verification errors. These diagnostic changes do not alter size budgets,
archive contents, schemas or rollback requirements. Existing valid schema-18
archives do not need regeneration.

Cancellation keeps admission until the original picker callback, stream and
cancellation closer have drained. If the system picker remains open, close it
to finish cancellation. A provider that cannot close within 15 seconds puts
transfer into a restart-required state; it cannot admit another operation.

Finishing removes every import stage and any export stage that never reached
a destination write. Failed exports delete recovery keys and plaintext
snapshots as soon as the destination state is known. Only encrypted output
and a small state marker survive an unverified provider write. A verified export
stays successful if temporary cleanup fails; finishing retries that cleanup.
Startup sweeps disposable stages and strips plaintext from uncertain export stages without
touching books. The library's **Discard leftover transfer files** action deletes
remaining transfer files, including uncertain ciphertext, without deleting books.
Probe directories never count toward the 16-stage admission bound. Transfers
are disabled with an explanation if temporary storage cannot be prepared;
existing books remain available. The app requests truncating provider writes
and attempts to delete documents it created if verification fails. A provider
may refuse deletion; any such destination remains unverified. A later retry
creates another separate copy.

Focused host tests exercise preparation, complete archive restoration,
copy-only publication with originals, schema-before-preset refusal precedence,
unchanged libraries after refusal, changed/truncated
input, free-space admission, cancellation and stale session completion. Mobile
interface tests cover preview/confirmation, localization and delayed
cancellation, restart-required states and leftover-file disposal. Android transfer
is not certified on physical devices. Host/interface checks do not certify native
providers, APK updates or an emulator round trip; those require separate runtime
evidence. Local emulator runs without a tracked artifact are identified as such
in the change review.

## Backup, restore, and rollback

Use a disposable book to verify an encrypted archive with its separately saved
key and restore it as a separate book before relying on the backup. Encryption
protects the portable archive, not the working database, ordinary recovery
copies, readable mirror, or temporary plaintext staging files. Read the
[backup and interrupted-archive instructions](../README.md#keep-a-safe-copy-of-your-book).

There is no automatic schema downgrade. For rollback, close garret, preserve
the upgraded book and profile separately, then use the previous package with
the complete pre-upgrade book copy in a separate location. Changes written
after the backup are not present in that copy. Do not replace a live database
or remove its adjacent originals. If profile compatibility is uncertain, keep
both profiles and ask for recovery help before launching the older package.

For a format or migration change, the change's assessment must identify who
is affected, compatibility with the old build, the backup needed, the upgrade
steps, what rollback restores, and what was actually tested. Existing schema
test exclusions and platform limits still apply; a documentation gate cannot
certify a live upgrade or restore.

### Android drafting data

Android drafting tools reuse the existing item revisions and positions, synopsis,
cast, Bible documents, comments and saved-typing ledger. New Android books use
schema 17; existing 17 books remain 17, and existing 18 books remain 18. Android
never upgrades a book and needs no upgrade consent or private rollback copy. Old day-baseline metadata is retained
and is not reclassified as typed progress. Daily targets use the desktop
`daily_target` string encoding in application settings; they are device preferences
and do not travel with a book. Text size is stored with Android appearance settings.
Synopsis edits the desktop synopsis panel field with explicit Save; closing the dialog discards unsaved drafts.
Only scene mutations are exposed; parts and chapters remain read-only on mobile.
Unsupported project presets remain refused before opening. Android relies on the
system lock screen for device privacy; an application privacy lock is not provided.

Ordinary desktop Delete, replacement and Select All edits cannot remove document
atoms. Use the explicit deletion action; its undo/redo remains available. Android
enforces atom preservation at the host save boundary, independently of desktop
authoring. Encrypted archives remain backups; their interface warns to use the
recipient-checked device export for transfers.

Figure package imports admit at most 128 distinct originals and 256 MiB of
original bytes. Each image is inspected once before retention. Originals and
their database are staged together; failed publication cleans up originals
owned by that attempt and refuses an existing destination pictures folder.
Cancelled figure insertions retain their original for recovery, with admission
limited to 1,024 retained figure files and 2 GiB per book. Nothing is deleted
automatically to make room. Missing or changed originals produce a properties
warning; caption and alternative text remain editable, while publication still
requires valid originals. DPI estimates precede caption and heading layout;
the proof checks the final placed size. Figure copy/paste is refused, including
within the same book; use insertion and explicit deletion with undo instead.
