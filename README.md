<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/garret/garret-wordmark-paper.png">
    <img src="assets/brand/garret/garret-wordmark-ink.png" alt="garret." width="280">
  </picture>
</p>

## A writing studio for the whole book.

**garret** <img src="assets/brand/garret/garret-middle-dot.svg" alt="·" width="8" height="16"> is a powerful writing studio for novelists, completely free and open
source. It brings your manuscript, story planning, research, and revisions
into one app.

There are no subscriptions or paid feature unlocks. You don't need an account
or an internet connection to write. Your books stay on your own disk.

> **Early alpha.** garret moves fast; keep backups of your work.

![garret writing view](docs/screenshots/editor-light.png)

[Website](https://usegarret.com) | [Full screenshot gallery](docs/screenshots/README.md) | [Sample books](app/fixtures/classics/README.md)

## Write, plan, and revise

Write in a calm editor with formatting, book-wide search, undo/redo, and
scene history. Arrange parts, chapters, and scenes with outlines and cards.
Choose light or dark mode, in English or German.

### Keep the story straight

Build a story bible for your world, notes, and continuity rules. Keep character
profiles, aliases, pictures, and appearances alongside your manuscript. Write
scene synopses, connect research files, and use the timeline to follow events
across character and story tracks.

![Story timeline in garret](docs/screenshots/timeline.png)

### Work with your editor

Send a DOCX review document to your editor and import the returned changes
with attribution. Accept or reject proposals in garret, keep comments attached
to the text, and organize the next draft into revision passes and tasks.

![Attributed editorial review in garret](docs/screenshots/review.png)

### Prepare the book

Export to Markdown, DOCX, or EPUB, or make a PDF proof copy. Set up book design,
front and back matter, covers, and pen names before exporting.

### Keep control of your work

Books live on your own disk. Recovery copies, scene history, salvage tools,
and a readable mirror folder help you recover work. Encrypted portable archives
include a separate recovery key. An optional PIN lock conceals the app when
you step away; it does not encrypt manuscript files.

Series, optional session analytics, and local craft and consistency reports
are included too. All of these tools are free.

## Platforms

| Platform | |
| --- | --- |
| Linux | x86_64, glibc 2.39+, WebKitGTK 4.1 |
| Windows | x86_64, WebView2 |
| Android | Writing and editing on the go |
| macOS | Apple Silicon and Intel alpha builds; native testing needed |

Get [alpha testing builds from GitHub Releases](https://github.com/iuliandita/garret/releases),
or [build garret from source](#building-from-source-linux).

<p>
  <img src="docs/screenshots/android-editor-light.png" alt="Android writing view in light mode" width="240">
  <img src="docs/screenshots/android-editor-dark.png" alt="Android writing view in dark mode" width="240">
</p>

## Testing builds

Download alpha builds from [GitHub Releases](https://github.com/iuliandita/garret/releases).
Choose the download for your device, extract the whole desktop package, and
follow the included instructions. Android uses an APK; the phone app has fewer
features and does not sync books automatically. Keep a backup before trying a
new build.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, checks, and
pull request instructions.

## Where your work lives

New books default to `Documents/Books` until you choose another folder.
Settings and recovery copies live under `~/.local/share/cc.local.app/`. Pictures
and research originals sit in folders next to each book, so back up a book's
`.db` file together with those folders, with the app closed.

### Keep a safe copy of your book

Keep your working book outside cloud-synced folders. **Back up now** makes a
local recovery copy; it cannot protect your work if you lose the device.

1. Open **File > Open book > Backups and archives**.
2. Choose **Create recovery key** and keep the key separately from your backups.
   A lost key means you cannot restore an encrypted archive.
3. Select **Choose backup folder**, then **Make encrypted archive** and save
   the archive there. Use a Google Drive or Dropbox synced folder, or a USB
   drive. You can also copy the archive there afterward.
4. Use **Verify encrypted archive** to check the saved archive with your key.

garret remembers the backup destination folder. Making and saving each archive
is manual. **Restore encrypted archive** restores it as a separate book.

## Support garret

If you would like to support development, you can
[leave a tip on Ko-fi](https://ko-fi.com/Q3O027XM2F). It is entirely optional;
every feature remains free.

## License

garret is free software under the GNU General Public License, version 3 or
later; see [COPYING](COPYING). Third-party notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
