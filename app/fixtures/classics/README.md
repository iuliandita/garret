# Classic sample books

Three populated excerpts for development, testing, and screenshots. They are
kept in this repository and are not included in installable garret builds.

Each book contains its first three chapters, with an outline, a synopsis for
every scene, cast entries and aliases, appearances, bible notes, and a linked
timeline. The added annotations cover only the excerpt and are identified as
sample editorial material. The original prose is not rewritten.
The books are pinned to Jane Austen, Lewis Carroll, and Bram Stoker as their
writing identities. Screenshot runs use an isolated vault containing those authors.

| Book | Source |
| --- | --- |
| Pride and Prejudice, Jane Austen | [Project Gutenberg 1342](https://www.gutenberg.org/ebooks/1342) |
| Alice's Adventures in Wonderland, Lewis Carroll | [Project Gutenberg 11](https://www.gutenberg.org/ebooks/11) |
| Dracula, Bram Stoker | [Project Gutenberg 345](https://www.gutenberg.org/ebooks/345) |

The original English texts are listed as public domain in the USA by Project
Gutenberg. Each `src/source.txt` retains the complete source, credits, and
Project Gutenberg license. No modern translation, cover, or character art is
used. Print wrapping and illustration captions are removed where needed for
import. Alice's shaped tail poem keeps its words but loses its print indentation.
The source notes in each book describe these adjustments.

## Build openable books

From the repository root, with the release host built:

```sh
scripts/build-samples
```

This regenerates the fixtures offline through garret's own Markdown importer
and seeds validated `.db` files into `app/dist-samples/`. Open those files in
garret. Existing sample databases are never overwritten; pass a different
output directory to make another set.

Edit `src/cast.json`, `src/synopses.json`, `src/bible/*.md`, or
`src/timeline.json` to update annotations. Edit `src/extract.py` for changes to
extraction; `src/manuscript.md` is regenerated. Rebuild rather than editing the
generated JSON and NDJSON files.

## Capture screenshots

Build the interface first (`cd app/ui && bun run build`), then run from the root:

```sh
env -u WAYLAND_DISPLAY -u NO_AT_BRIDGE GDK_BACKEND=x11 APP_GUI=1 \
  bun app/harness/src/shot-cli.ts pride-and-prejudice \
  --theme light --scheme light --size 1440x960
```

The fixture names are `pride-and-prejudice`, `alice`, and `dracula`. Add `--cast`,
`--synopsis`, `--appears`, `--appears-map`, `--timeline`, or `--outline-view table`
to show their populated features. `--library` shows all three books. Captures
use temporary copies; the source fixtures and your writing are untouched.
