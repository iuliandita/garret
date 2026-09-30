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
bunx tsc --noEmit -p app/tsconfig.json   # typecheck
bun test ./app/ui                        # interface tests
bun test ./app/harness                   # harness unit tests
cd app/shell-tauri/src-tauri && cargo test --bin garret
```

The host tests need the built interface in `app/shell-tauri/dist`
(`cd app/ui && bun run build`, then copy `app/ui/dist` there). A few host tests
are known to fail; CI skips exactly those and links the tracking issue.

The GUI rigs in `app/harness` drive the real app under Xvfb and AT-SPI and need
`xvfb`, `xdotool` and the AT-SPI bus. Run them on an isolated display, never on
your live desktop session. Screenshots they capture land in
`app/results/screenshots/`, which is not committed. The curated public gallery
lives in `docs/screenshots/`. Rebuild its [classic sample books](app/fixtures/classics/README.md)
when refreshing those captures.

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
4. PRs are squash-merged once CI passes and review is done.

## Commit style

Conventional commits: `type(scope): description`, for example
`fix(export): keep scene breaks in DOCX`. Types: `feat`, `fix`, `docs`,
`refactor`, `test`, `perf`, `build`, `ci`, `chore`, `revert`. Keep subjects
plain ASCII and at most 72 characters; put detail in the body.

## License

By contributing you agree that your work is licensed under the GNU General
Public License, version 3 or later, like the rest of garret.
