# Keeping documentation current

Documentation is part of a change. The offline guard detects review obligations
and verifiable drift. It cannot establish that prose is correct, an editor
interaction works, or a live upgrade, restore, or rollback succeeds.

## Checks

Run from the repository root with Python 3.11 or newer and Git:

```sh
bun run check:docs
sh scripts/check-docs --base origin/develop
python3 scripts/check-docs.py --explain
python3 scripts/test-docs.py
python3 scripts/test-docs-facts.py
```

The wrapper reuses the existing release version check, checks documentation
facts, then checks source impact. The plain command validates current receipts
and working changes. `--base` checks the merge-base-to-current PR range plus
staged and unstaged tracked files. Stage new source and documentation files
before accepting a receipt; ignored and untracked scratch files are excluded.
Missing tooling, unresolved bases, and shallow history fail clearly.

The required interface CI job fetches complete history and checks against the
actual PR base, or the previous push commit. The release prepare job also runs
the gate before packaging. Tag publication checks the complete range from the
previous reachable alpha tag and publishes the same checked source commit.

An optional local hook can call `sh scripts/check-docs --base origin/develop`
from an existing pre-push hook. Keep existing hook protections; do not replace
them or change the repository's hook directory just to install this check.
Local hooks supplement required CI and release checks.

## Source impact and assessments

The single domain map lives in scripts/check-docs.py. Inspect it with
`--explain`; docs/docs-impact.json stores source-bound assessments.

| Domain | Source reviewed | Documentation affected |
| --- | --- | --- |
| Editor | Desktop and mobile interface code, CSS, HTML | README and screenshot gallery |
| Project format | Store, manuscript import/export, transport and associated assets | README and compatibility guide |
| Schema | SQLite store and profile migration | Compatibility and recovery guide |
| Backup and recovery | Recovery, salvage, archives, readable mirrors and transfer | Backup instructions and compatibility guide |
| Encryption | Archive encryption and privacy boundaries | Archive/key and privacy guidance |
| Native packaging | Host/build configuration, dependencies, platform scripts and release workflow | Contributor and packaged platform instructions |
| Maintenance | Documentation guard, its tests and CI | This guide and contributor instructions |

Each affected domain needs a current source fingerprint and either mapped
documents whose bytes actually changed in the PR or a concrete no-impact
reason. Cited document hashes are bound too. Receipt edits alone, unchanged
documents, stale receipts, and baseline resets cannot clear an obligation.

After reviewing the source and updating the relevant documents:

```sh
python3 scripts/check-docs.py --accept editor --docs README.md,docs/screenshots/README.md --note "Explain the new navigation controls and replace the affected gallery images." --breaking none
```

A refactor can record its actual lack of user-facing impact:

```sh
python3 scripts/check-docs.py --accept editor --no-impact "Extract the existing selection helper without changing keyboard behavior, labels, or persistence." --breaking none
```

Commit the receipt with the source and documentation. Accept only after the
last source or cited-document edit. When branches overlap, review the combined
behavior and accept a new receipt; do not select a convenient old fingerprint.
Specific explanations remain review assertions, not machine-proven semantics.

## Format changes and migrations

Production schema definitions, migration functions, application-profile
migration, and project-format code are conservative review boundaries. Even
a refactor there requires a compatibility assessment; the guard does not
interpret SQL semantics. ZIP extractor compatibility is not the SQLite schema.

Update docs/COMPATIBILITY.md and the affected user instructions. Declare the
actual breaking consequence, or `none` when compatibility is preserved, and
supply a concrete `--migration` assessment covering compatibility, backup,
upgrade, and rollback. A sensitive change cannot use the no-impact path.
Describe what a writer must preserve and what rollback loses or restores.
State the actual isolated validation performed and any untested platform.

Before release, run `sh scripts/check-docs --release` and review the complete
range. A later query-only or version-only commit cannot erase an earlier
migration obligation. The initial `--init --note` baseline records the existing
tree only; it does not certify historical documentation and cannot reset an
existing baseline or waive changes in a checked range.

## Facts and screenshots

The facts check validates common local Markdown/HTML links and Markdown
heading anchors, canonical CLI subcommand names, repository script paths, and
known package-script names. It inspects examples without executing them.
It does not fully parse shell commands or CommonMark, validate every argument,
check remote links, or contact companion websites.

The gallery manifest binds every PNG to its bytes, actual application version,
source revision, platform, and capture disclosure. Preserve original captures
and identify historical images explicitly; never relabel an older screenshot
as a new release. A matching hash cannot prove visual correctness or freshness.
Review the running app and inspect the affected captures when behavior changes.

The release registry checks its recorded tag, source version and platform
inventory offline. Updating it is an explicit observation of published state;
the guard cannot independently prove remote publication. Proposed features
belong in the separate development section until they ship.
