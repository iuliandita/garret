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
