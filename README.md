<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/garret/garret-wordmark-paper.png">
    <img src="assets/brand/garret/garret-wordmark-ink.png" alt="garret." width="280">
  </picture>
</p>

garret is a local-first desktop writing studio for novelists. It runs offline,
needs no account, and keeps every book as a file on your own disk.

> **Early alpha.** garret moves fast; keep backups of your work.

![garret writing view](docs/screenshots/editor-light.png)

[Full screenshot gallery](docs/screenshots/README.md) | [Sample books](app/fixtures/classics/README.md)

## What it does

- Books with parts, chapters and scenes; a navigator, an outline table and cards.
- A calm prose editor with formatting, undo/redo, search, comments and history.
- A story bible: synopses, cast, appearances, a timeline, pictures and covers.
- Revision passes and tasks, series, optional session analytics, and local
  craft and consistency reports.
- Knowledge links and research files copied into the project.
- Export to Markdown, DOCX and EPUB, plus a PDF proof copy; DOCX review
  documents can go out and come back with their changes attributed.
- Recovery copies, salvage of damaged files, a readable mirror folder, and
  encrypted portable archives with a separate recovery key.
- Light and dark themes; English and German.
- An optional privacy lock that hides the app behind a PIN.

## Platforms

| Platform | |
| --- | --- |
| Linux | x86_64, glibc 2.39+, WebKitGTK 4.1 |
| Windows | x86_64, WebView2 |
| Android | Writing and editing on the go |
| macOS | In progress |

<p>
  <img src="docs/screenshots/android-editor-light.png" alt="Android writing view in light mode" width="240">
  <img src="docs/screenshots/android-editor-dark.png" alt="Android writing view in dark mode" width="240">
</p>

## Building from source (Linux)

You need [Bun](https://bun.sh), a stable Rust toolchain, and the
[Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
(WebKitGTK 4.1 development packages).

```sh
bun install
cd app/ui && bun run build && cd -
cd app/shell-tauri/src-tauri && cargo build --release && cd -
scripts/run-app
```

`scripts/run-app` rebuilds the interface, builds the host on first use, and
starts the app. `scripts/install-desktop-entry` adds a menu entry for that
launcher. Release-style packages come from `scripts/package-linux`,
`scripts/package-windows`, `scripts/package-macos` and `scripts/package-android`.

## Checks

```sh
bun test ./app                                   # interface and harness tests
bunx tsc --noEmit -p app/tsconfig.json           # typecheck
cd app/shell-tauri/src-tauri && cargo test --bin garret
```

`app/harness` drives the real app under Xvfb and AT-SPI to grade latency,
persistence and interface behavior; `app/results` holds the recorded
measurements. `lab` holds the frozen prototypes that chose the stack.

## Where your work lives

New books default to `Documents/Books` until you choose another folder.
Settings and recovery copies live under `~/.local/share/cc.local.app/`. Pictures
and research originals sit in folders next to each book, so back up a book's
`.db` file together with those folders, with the app closed.

## License

garret is free software under the GNU General Public License, version 3 or
later; see [COPYING](COPYING). Third-party notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
