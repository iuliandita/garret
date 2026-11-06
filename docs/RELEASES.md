# Published and development builds

The current published release is [0.0.11 alpha](https://github.com/iuliandita/garret/releases/tag/v0.0.11).
Its source and platform inventory are recorded in [releases.json](releases.json).
Earlier releases are listed in the [changelog](../CHANGELOG.md).
That record is an explicit observation of published state, not an automatic
claim that the current develop commit has shipped. Update it only after the
release and complete downloads are public and verified.

The release is a round of interface fixes. A DOCX import's loss report stays
on screen and can be shown again from Books. A day spent cutting reads as words
cut. Side panels and the publishing preview make room instead of covering the
prose, and take the whole window when no split fits. Encrypted backups read
folder, key, then archive, with device transfer in its own disclosure. Revision
tasks and Who appears where open their scenes, and Cards shows chapters as
headings. The PDF proof centres its byline, sets paragraphs ragged-right and
defaults new fiction designs to the bundled Crimson Pro. German uses formal
address and Strg throughout, and Focus mode, the outline and the Word export
have menu entries. The stored format is unchanged from 0.0.10; a DOCX import
adds one optional metadata row that older builds ignore. The Android package
`com.usegarret.app` keeps its signing certificate.

Linux x86_64, Windows x86_64 and arm64, Android, and macOS Apple Silicon and
Intel packages are published. Install-and-launch checks on CI runners are not
native certification on real devices. Android has fewer features than desktop
and does not synchronize books automatically.

## Develop-only work

The next release is a round of hardening. Pictures, the readable folder and
salvage refuse links instead of following them, and a save made while the
readable folder's changes are being accepted is kept. Review copies get the
pen-name check, statistics CSV exports keep formula-like text as plain text,
and published files drop embedded image metadata. DOCX imports bound note
expansion and long Markdown imports stay fast. New application data is private
to the user, a second launch checks the running instance before handing over,
and Windows refuses import names with a colon. The stored format is unchanged
from 0.0.11.

Develop pins the desktop main window to the app origin and refuses page-created
windows. Clipboard HTML validation uses an inert document, and Android's CSP
refuses base URLs and form submissions, matching desktop. These changes preserve
the stored book format. A WebKitGTK/WebView2 runtime CSP rig has not been added.
Future user-visible capabilities awaiting release belong here and in the
separate `develop_only` list in releases.json.

Storage hardening rejects negative book schema versions, applies defensive
SQLite connection settings, and publishes migration records atomically. Backup
errors identify the deliberate cleanup command. See the
[compatibility guide](COMPATIBILITY.md) for archive authentication limits.

Unix storage permission changes apply only to newly created application data;
existing file permissions and user-chosen export destinations keep their modes.
See [compatibility and recovery](COMPATIBILITY.md) for the creation rules.

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
