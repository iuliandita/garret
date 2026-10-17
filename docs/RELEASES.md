# Published and development builds

The current published release is [0.0.4 alpha](https://github.com/iuliandita/garret/releases/tag/v0.0.4).
Its source and platform inventory are recorded in [releases.json](releases.json).
That record is an explicit observation of published state, not an automatic
claim that the current develop commit has shipped. Update it only after the
release and complete downloads are public and verified.

The release adds in-project collections of short stories (story containers,
per-story author and status, whole-collection and single-story export), books
without chapters and short fiction and nonfiction on Android, and a lighter
preview rail that mounts only nearby documents. It fixes replace-all with an
empty replacement leaving scenes unreadable, and repairs affected scenes
automatically. Saved documents are now checked more strictly against the
supported format. The Android package is now `com.usegarret.app`, with the same
signing certificate. It installs next to the old `cc.local.app` app, and books
move by export and import once; see
[the Android notes](../scripts/android/README.md). Desktop installers and signed
checksums are as in 0.0.3.

Linux and Windows x86_64, Android, and macOS Apple Silicon and Intel packages
are published. Packaging success establishes a build and archive check, not new
native runtime certification. Android has fewer features than desktop and does
not synchronize books automatically.

## Develop-only work

Nothing user-visible is pending on develop. Future user-visible capabilities
awaiting release belong here and in the
separate `develop_only` list in releases.json.

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
