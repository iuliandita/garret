# Published and development builds

The current published release is [0.0.2 alpha](https://github.com/iuliandita/garret/releases/tag/v0.0.2).
Its source and platform inventory are recorded in [releases.json](releases.json).
That record is an explicit observation of published state, not an automatic
claim that the current develop commit has shipped. Update it only after the
release and complete downloads are public and verified.

The release includes simpler grouped menus, contextual manuscript and Bible
creation controls, a home icon returning to the library, tabbed preferences,
help on hover and keyboard focus, custom writing goals, and optional quieter
scene, chapter, and part counts. Scene counts are the default; chapter and
part counts default off. The story-clock heading has more space above its
timeline. Book moves and application-data migration include recovery safeguards.

Linux and Windows x86_64, Android arm64/x86_64, and macOS Apple Silicon and
Intel packages are published. Packaging success establishes a build and
archive check, not new native runtime certification. Android provides the
library and scene editor with manual book transfer; it has fewer features
than desktop and does not synchronize books automatically.

## Develop-only work

Documentation drift checks and the versioned screenshot manifest are
development tooling added after 0.0.2. They do not change the published app.
Future user-visible capabilities awaiting release belong here and in the
separate `develop_only` list in releases.json.

## Preparing the next release

Follow the [alpha release procedure](../CONTRIBUTING.md#alpha-testing-releases).
Review the complete range since the previous reachable release tag, including
earlier migrations superseded by later refactors. Check compatibility, backup,
upgrade, and rollback guidance across that whole range. Publish the same
integrated source commit that passed the required CI and release gate.

The deterministic checks are offline. They validate recorded tags, versions,
commands, links, hashes, and review obligations. They do not contact the
website or prove its published content matches the app. A companion website
update can be pending independently; check its actual deployment before
claiming it is aligned. See [maintenance](MAINTENANCE.md) for the guard's limits.
