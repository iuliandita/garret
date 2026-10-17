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

Extract the new desktop package into a separate folder, keeping its interface
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

The desktop profile now uses `garret` instead of `cc.local.app`, preserving a
compatibility link after migration. Close older versions before first launch.
If migration stops, preserve both folders named in the warning, close garret,
and request recovery help. Do not merge, overwrite, or delete them. The Android
application identifier remains `cc.local.app`; profile migration is not sync.

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
and a small state marker survive an unverified provider write. Startup sweeps
disposable stages and strips plaintext from uncertain export stages without
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
