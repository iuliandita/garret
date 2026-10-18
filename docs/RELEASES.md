# Published and development builds

The current published release is [0.0.6 alpha](https://github.com/iuliandita/garret/releases/tag/v0.0.6).
Its source and platform inventory are recorded in [releases.json](releases.json).
That record is an explicit observation of published state, not an automatic
claim that the current develop commit has shipped. Update it only after the
release and complete downloads are public and verified.

The release is the reader step for endnotes, pictures in the text and scene
breaks. Desktop and Android open books that use them (schema 18) and keep them
intact through editing, saving, history, backups and transfer. New books are
still created at schema 17, and adding notes or pictures is not switched on
yet; 0.0.5 and earlier refuse schema-18 books instead of dropping their
contents. Pasting a copied image is refused with a short notice instead of
inserting its source as text. In a story collection, a new scene added to an
empty part creates a story inside that part. Desktop installers, signed
checksums and the Android package `com.usegarret.app` are as in 0.0.5.

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
