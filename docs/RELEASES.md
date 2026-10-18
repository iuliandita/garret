# Published and development builds

The current published release is [0.0.7 alpha](https://github.com/iuliandita/garret/releases/tag/v0.0.7).
Its source and platform inventory are recorded in [releases.json](releases.json).
That record is an explicit observation of published state, not an automatic
claim that the current develop commit has shipped. Update it only after the
release and complete downloads are public and verified.

The release switches on endnotes, scene breaks and pictures in the text on
desktop. Endnotes open a small editor and are numbered by book, chapter or
story; pictures get a width, caption and alt text, with a warning when they
would print below 300 dpi. EPUB, PDF, DOCX and Markdown exports include them.
Using them upgrades a book to schema 18 after consent and a verified copy of
the book from before the upgrade. Upgraded books open in 0.0.6 or later on
desktop and phone; 0.0.5 and earlier refuse them. Android shows these elements
and edits the text around them, but cannot add them and never upgrades a book
itself. Phone import now walks through the archive and recovery key step by
step. Desktop installers, signed checksums and the Android package
`com.usegarret.app` are as in 0.0.6.

Linux and Windows x86_64, Android, and macOS Apple Silicon and Intel packages
are published. Packaging success establishes a build and archive check, not new
native runtime certification. Android has fewer features than desktop and does
not synchronize books automatically.

## Develop-only work

The next release adds native Windows arm64 installers and portable archives.
Windows x86_64 downloads keep their existing names. Both architectures enter
the signed checksum manifest and artifact attestations with the other downloads.
Native packaging checks install the app and create a sample book; GUI behavior
still needs testing on Windows devices.

## Preparing the next release

Follow the [alpha release procedure](../CONTRIBUTING.md#alpha-testing-releases).
Review the complete range since the previous reachable release tag, including
earlier migrations superseded by later refactors. Check compatibility, backup,
upgrade, and rollback guidance across that whole range. Publish the same
integrated source commit that passed the required CI and release gate. The
latest CI push run for that exact commit on `develop` must succeed before
a tag can build release packages. A newer pending, running, or failed run
blocks publication even when an older run succeeded.

The deterministic checks are offline. They validate recorded tags, versions,
commands, links, hashes, and review obligations. They do not contact the
website or prove its published content matches the app. A companion website
update can be pending independently; check its actual deployment before
claiming it is aligned. See [maintenance](MAINTENANCE.md) for the guard's limits.

Desktop packaging uses the exact `@tauri-apps/cli` development dependency from
`bun.lock`, installed with `bun install --frozen-lockfile`. The AppImage bundler
also downloads linuxdeploy and its plugins at build time; the locked CLI does
not make those upstream downloads offline or reproducible. Linux packages ship
the visible `com.usegarret.app.desktop` entry and matching icons. The bundler's
product-name entry is hidden to avoid a duplicate menu item.
