# Changelog

User-visible changes in each published alpha. Downloads, checksums and
signatures are on [GitHub Releases](https://github.com/iuliandita/garret/releases).
Read [compatibility and recovery](docs/COMPATIBILITY.md) before upgrading, and
keep a backup of your books before trying a new version.

## 0.0.10 - 2026-10-19

- A figure at the end of a scene always has a writable paragraph after it, so
  you can keep typing below a picture.
- Alternative text sits on the image instead of showing as a second caption.
  A figure without a description is marked.
- Publishing without alternative text names Figure properties instead of a
  generic "That could not be finished" error.
- The EPUB preview shows pictures, including after a refresh. A failed preview
  refreshes again once the book renders.
- The stored format is unchanged from 0.0.9.

## 0.0.9 - 2026-10-19

- The format 18 upgrade question works when a book is opened from the library.
  In 0.0.8 its buttons did nothing, so older books could not be opened there.
- The library menu matches the book view: New book, Open book, Import,
  Encrypted backups, Preferences, the privacy lock, Help and Quit.
- Preferences and Help open in front of the library.
- The saved-words summary shows by default and can be turned off in
  Preferences > Application.
- Series, universe and project type are pill selectors, and each book on the
  desk and shelf shows its project type.
- The stored format is unchanged from 0.0.8.

## 0.0.8 - 2026-10-19

- Native Windows arm64 installers and portable archives. Windows on ARM no
  longer runs garret through x64 emulation.
- The checksum manifest is signed with the published key. Signing,
  attestation and upload run as separate release jobs.
- Every published package is installed and launched on its own platform in CI
  after release.
- On Android, book transfer stays available after the system recreates the
  screen.
- The stored format is unchanged from 0.0.7.

## 0.0.7 - 2026-10-18

- Endnotes, scene breaks and pictures in the text on desktop. Endnotes open a
  small editor and are numbered by book, chapter or story. Pictures get a
  width, caption and alternative text, with a warning when they would print
  below 300 dpi.
- EPUB, PDF, DOCX and Markdown exports include them.
- Using them upgrades a book to schema 18 after consent and a verified copy of
  the book from before the upgrade. Upgraded books open in 0.0.6 or later;
  0.0.5 and earlier refuse them.
- Android shows these elements and edits the text around them, but cannot add
  them and never upgrades a book itself.
- Phone import walks through the archive and recovery key step by step.

## 0.0.6 - 2026-10-18

- Desktop and Android open books that use endnotes, pictures in the text and
  scene breaks (schema 18) and keep them intact through editing, history,
  backups and transfer. New books are still created at schema 17.
- Pasting a copied image is refused with a short notice instead of inserting
  its source as text.
- In a story collection, a new scene added to an empty part creates a story
  inside that part.

## 0.0.5 - 2026-10-18

- The desktop move from the old `cc.local.app` profile folder to `garret`
  handles more cases by itself. Real conflicts are explained in plain English or
  German, with the number of books found in each folder.
- PDF proofs keep typed double and triple hyphens together.
- EPUB and DOCX exports remove control characters from titles and metadata.
- In collections, a new scene goes into the selected part's last story.
- Find results no longer repeat the prose label, References pages use a hanging
  indent, numbers are not flagged as misspelled, and statistics headings no
  longer run together.

## 0.0.4 - 2026-10-17

- Story collections in one book, with per-story author and status, and
  whole-collection or single-story export.
- Android supports books without chapters, short fiction and nonfiction.
- A lighter preview rail that mounts only nearby documents.
- Replace-all with an empty replacement no longer leaves scenes unreadable, and
  affected scenes are repaired automatically.
- The Android package is now `com.usegarret.app`, with the same signing
  certificate. It installs next to the old `cc.local.app` app; move books once
  by export and import. See [the Android notes](scripts/android/README.md).

## 0.0.3 - 2026-10-17

- Project types for short fiction and nonfiction.
- Chapter opener positions, sinks and ornaments, and a References back-matter
  page.
- A resizable preview rail with device frames.
- Windows `-setup.exe`, Linux `.deb`, `.rpm` and `.AppImage`, and macOS `.dmg`
  installers beside the portable archives. Desktop builds use the identifier
  `com.usegarret.app`.
- Releases carry signed checksums and build attestations.
- Android adds book export and import archives, scene rename and move, search,
  goals, synopsis, Bible and cast lookup, comments, and a text size setting.

## 0.0.2 - 2026-10-09

- Simpler grouped menus and contextual manuscript and Bible creation controls.
- A home icon returns to the library.
- Tabbed preferences, help on hover and keyboard focus, and custom writing
  goals.
- Optional quieter scene, chapter and part word counts. Scene counts are on by
  default; chapter and part counts are off.
- Book moves and application-data migration include recovery safeguards.

## 0.0.1 - 2026-09-30

- First public alpha for Linux and Windows x86_64, macOS Apple Silicon and
  Intel, and Android arm64/x86_64.
