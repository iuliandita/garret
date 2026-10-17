# Compatibility and recovery

SQLite schema: 17.

This describes the current source. [Published releases](RELEASES.md) are
recorded separately; a change on develop is not a published download.

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

Both 0.0.1 and 0.0.2 use SQLite schema 17. The 0.0.2 DOCX importer adds
archive expansion limits: 128 entries, 128 MiB combined, and 64 MiB per entry.
An oversized foreign document can now be refused. Preserve the original and
split or simplify a copy before retrying; do not bypass the limits. This does
not change the stored manuscript schema or require converting existing books.

New desktop books can start as a novel, short fiction, or nonfiction. The
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
If migration stops, preserve both folders named in the warning, close garret,
and request recovery help. Do not merge, overwrite, or delete them. The Android
application identifier remains `cc.local.app`; profile migration is not sync.

The desktop application identifier is `com.usegarret.app`. This changes the
Linux menu-entry identity and macOS bundle identity without relocating books,
`settings.json`, recovery copies, or single-instance ownership. Linux keeps its
WebView data in the `garret` profile; Windows keeps its existing WebView2 data
under the local application-data directory's `cc.local.app` folder. Android
explicitly keeps `cc.local.app`, so installing an update preserves its sandbox.

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

The source stays at version 0.0.2 and Android version code 2 until release
preparation. The release-preparation change must raise both to 0.0.3/code 3
before distributing an update. The application ID stays `cc.local.app`; install
updates signed with the same retained key. Do not uninstall or clear app data
to update: both delete private books. Android normally refuses a lower version
code; rollback must preserve device data and use complete exported archives
with their separate recovery keys on a compatible desktop build. Installing
an older APK is not a recovery method.

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
before creating any library file, originals directory or catalog entry. Only an absent value or exactly `novel` is supported.
Empty, short-fiction, nonfiction, collection and unknown values are refused
with an English/German explanation. Desktop leniency for unknown presets does
not change this Android release's capability. Use desktop for those projects.

Import is bounded while reading and extracting: at most 1 GiB ciphertext and
512 MiB plaintext payload, plus a free-space allowance for verification and
copying. Storage failure, incomplete originals, invalid authentication, newer
schemas and stale sessions fail closed. Publication moves and syncs originals
before the database becomes visible; unsupported exclusive-rename kernels
refuse publication. No existing book is overwritten.

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
cast, Bible documents, comments and saved-typing ledger. SQLite stays at schema 17;
no new book or transfer format is introduced. Old day-baseline metadata is retained
and is not reclassified as typed progress. Daily targets use the desktop
`daily_target` string encoding in application settings; they are device preferences
and do not travel with a book. Text size is stored with Android appearance settings.
Synopsis edits the desktop synopsis panel field with explicit Save; closing the dialog discards unsaved drafts.
Only scene mutations are exposed; parts and chapters remain read-only on mobile.
Unsupported project presets remain refused before opening. Android relies on the
system lock screen for device privacy; an application privacy lock is not provided.
