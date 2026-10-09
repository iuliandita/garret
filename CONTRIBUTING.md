# Contributing to garret

garret is an early alpha. Issues and small, focused pull requests are welcome.
For anything larger, open an issue first so we can agree on the shape.

## Dev setup

Linux is the development platform. You need [Bun](https://bun.sh) 1.4 or newer,
a stable Rust toolchain, and the
[Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
(WebKitGTK 4.1 development packages).

```sh
git clone https://github.com/iuliandita/garret.git
cd garret
bun install
scripts/run-app
```

`scripts/run-app` rebuilds the interface, builds the host on first use and
starts the app. Use a sample book while developing, never your only copy of real
writing.

## Checks

```sh
bun run check:docs
bunx tsc --noEmit -p app/tsconfig.json   # typecheck
bun test ./app/ui                        # interface tests
bun test ./app/harness                   # harness unit tests
cd app/shell-tauri/src-tauri && cargo test --bin garret
```

Documentation checks require Python 3.11 or newer, Git, and full history with
release tags. For a PR, run `sh scripts/check-docs --base origin/develop`.
Review each affected domain and record a specific documentation update or
no-impact assessment. See [documentation maintenance](docs/MAINTENANCE.md)
for the commands, migration requirements, optional hook, and limits.

The host tests need the built interface in `app/shell-tauri/dist`
(`cd app/ui && bun run build`, then copy `app/ui/dist` there). A few host tests
are known to fail; CI skips exactly those and links the tracking issue.

The GUI rigs in `app/harness` drive the real app under Xvfb and AT-SPI and need
`xvfb`, `xdotool` and the AT-SPI bus. Run them on an isolated display, never on
your live desktop session. Screenshots they capture land in
`app/results/screenshots/`, which is not committed. The curated public gallery
lives in `docs/screenshots/`. Rebuild its [classic sample books](app/fixtures/classics/README.md)
when refreshing those captures.

## Website

The website lives at [usegarret.com](https://usegarret.com), built from
[garret-web](https://github.com/iuliandita/garret-web). Send website changes
there. The GitHub Pages site in `site/` is only a redirect to usegarret.com for
old links; it has no content of its own. Preview it locally with:

```sh
bash scripts/build-site
python3 -m http.server 8080 --bind 127.0.0.1 --directory app/dist-site
```

The Website workflow builds it on pull requests and deploys changes from
`develop`.

## Code style

- TypeScript is strict; no `any`. Match the surrounding style, and do not
  reformat code you did not change (the Rust code is not `rustfmt`-normalized).
- Comments explain why, not what. No TODO or FIXME markers: note deferred work
  in an issue instead.
- User-facing text lives in the English and German catalogs under
  `app/ui/src/i18n/`; change both.
- Nothing that identifies a person or a machine goes into tracked files:
  no home paths, hostnames or private manuscripts in fixtures or results.
  Public-domain sample texts retain their source credits and licenses.

## Submitting a PR

1. Branch from `develop`: `git switch develop && git pull --ff-only && git switch -c feat/my-thing`
2. Keep commits focused and run the checks above.
3. Open a PR against `develop` and fill in the template. `main` only receives
   release merges from `develop`.
4. Feature and fix PRs are squash-merged once CI passes and review is done.

### Promoting and synchronizing branches

Promote `develop` to `main` through a PR using **Create a merge commit**.
After the promotion, open a PR from `main` back to `develop` and merge it
the same way. These merges preserve the shared history between the two
long-lived branches, so later promotions do not repeat already merged work.

Do not squash or rebase these branch-to-branch PRs. Both branches still require
PRs and passing `interface` and `host` checks, including for administrators.
Force pushes and branch deletion remain blocked.

## Alpha testing releases

The **Alpha builds** workflow packages Linux x86_64, Windows x86_64, Android
arm64/x86_64, and macOS for Apple Silicon and Intel. Packaging changes are
built on pull requests. **Run workflow** makes testing artifacts without
publishing a release. Android artifacts from these build-only runs use a
disposable signing key; use the published release APK for updates.

To prepare the first release, the source version is `0.0.1`. For later releases:

```sh
python3 scripts/release.py set-version 0.0.2
```

Commit the changed Cargo manifest/lockfile and Tauri configuration files through
a PR into `develop`. Wait for CI to pass on the resulting `develop` commit.

Before tagging, also run `sh scripts/check-docs --release`. It checks the
complete range since the previous reachable alpha tag, including migration
changes in earlier commits. Review the [compatibility and rollback guide](docs/COMPATIBILITY.md).
Keep [published state](docs/RELEASES.md) separate from work on develop; update
its release record only after the complete download set is public and verified.

Then create and push an annotated tag from that exact checked commit:

```sh
git switch develop
git pull --ff-only
git tag -a v0.0.1 -m "garret 0.0.1 alpha"
git push origin v0.0.1
```

Replace the version in both commands for subsequent releases. Tags in `v0.x.y`
are alpha prereleases, even without an `-alpha` suffix. Each version must match
the checked-in source. Stable `v1.x.y` releases are a separate release policy.

A tag starts the builds. Only after every platform succeeds does the workflow
assemble a draft release, verify all download checksums, and publish it as a
prerelease. No partial set is published, and an existing public release is not
replaced. A failed upload leaves a draft that a rerun can finish. Use a new
version to replace a public build.

Android tag builds require repository secrets `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD`, containing the retained testing keystore and its
password. The keystore uses alias `preview`. Keep an offline copy: a new key
cannot update an app installed with the old one. Release builds refuse missing
signing material. Keys are restored only for tag builds and removed from the
runner afterward. No app store or paid signing account is required.

macOS packages use ad-hoc signing without notarization. They need native tester
feedback; successful packaging does not certify platform behavior. Windows
packages use `scripts/package-windows-native.ps1` on a native Windows builder;
`scripts/package-windows` remains available for local Linux cross-builds.

## Commit style

Conventional commits: `type(scope): description`, for example
`fix(export): keep scene breaks in DOCX`. Types: `feat`, `fix`, `docs`,
`refactor`, `test`, `perf`, `build`, `ci`, `chore`, `revert`. Keep subjects
plain ASCII and at most 72 characters; put detail in the body.

## License

By contributing you agree that your work is licensed under the GNU General
Public License, version 3 or later, like the rest of garret.
