// app/harness/src/cast-hover.ts
// The AT-SPI walk that finds the leftmost cast mark in the open scene's own
// prose and confirms the hover card came up over it -- shot-cli.ts's
// `--cast-card` and `--cast-alias`, and bible-cli.ts's boot 4 alias check,
// share this file rather than each carrying its own copy of the two
// Python scripts.
//
// THE ENTRY'S OWN TEXT INTERFACE, NOT A DOM ID. WebKitGTK exposes the
// ProseMirror contenteditable as a single accessible text object and hands a
// bare decoration `<span>` inside it no node of its own, so no DOM id on a
// mark -- kept or not -- is ever visible to this bridge. `getText` reads the
// string a writer would read; `getRangeExtents` answers where a character
// range in it is drawn on screen. `words-cli.ts` and `find-cli.ts` already
// read a caret and a selection the same way.
//
// XDO IS NOT CALLED HERE. shot-cli.ts and bible-cli.ts each carry their own
// small `xdo` wrapper already, and importing one into the other would be the
// wrong direction for two CLIs that share no module today. This file finds
// the rect and confirms the card; the caller moves the pointer and sleeps.
import { Database } from "bun:sqlite";
import { PY_READ_NODES, pidListArg } from "./atspi";

/** 098, W5: the card shows 450ms after the pointer arrives on a mark, per the
 *  design record's own number. `--hover`'s own settle (1500ms, `shot-cli.ts`)
 *  is what a plain mouseenter tooltip needs for WebKitGTK to actually
 *  deliver and paint the frame; this card is that same delivery PLUS its own
 *  450ms timer, so it gets the same 1500ms rather than a smaller number that
 *  only covers the timer and assumes delivery is free. */
export const CAST_CARD_SETTLE_MS = 1500;

/** Below this length a "name" is too likely to be an ordinary word to mark
 *  every occurrence of it -- `cast-marks.ts`'s own `MIN_CAST_NAME_LENGTH`,
 *  restated rather than imported: this harness never imports `app/ui/src`. */
const MIN_CAST_NAME_LENGTH = 3;

export interface CastHoverRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every name, and every alias, this project's cast table holds -- straight
 *  off the file `words-cli.ts`'s own precedent reads by path, not through the
 *  running host. */
export function castNamesAndAliases(projectPath: string): {
  readonly names: readonly string[];
  readonly aliases: readonly string[];
} {
  const db = new Database(projectPath, { readonly: true });
  try {
    const names = (db.query("SELECT name FROM cast_member").all() as { name: string }[]).map(
      (r) => r.name,
    );
    const aliases = (db.query("SELECT alias FROM cast_alias").all() as { alias: string }[]).map(
      (r) => r.alias,
    );
    return { names, aliases };
  } finally {
    db.close();
  }
}

/** One candidate this hover could land on: its text, and which family it
 *  came from. THE FAMILY TRAVELS WITH THE TEXT rather than being decided by
 *  a separate list, because "Roland Vetch" -- an alias of "Harbour Master
 *  Roland Vetch" -- sits inside every occurrence of the full name as a
 *  whole-word match of its own. Handing `--cast-alias` an alias-only text
 *  list would let it hover a span the page actually marked as the full
 *  NAME, defeating the flag's whole promise that the hover is provably on
 *  an alias; the family tag is what lets `locateCastHoverRect` tell the two
 *  apart at the SAME winning position, the way `matchesInText`'s own
 *  longest-first tie-break would. */
export interface CastHoverCandidate {
  readonly text: string;
  readonly alias: boolean;
}

/** Every name, and every alias, this project's cast holds, tagged by family. */
export function castHoverCandidates(projectPath: string): readonly CastHoverCandidate[] {
  const { names, aliases } = castNamesAndAliases(projectPath);
  return [
    ...names.map((text) => ({ text, alias: false })),
    ...aliases.map((text) => ({ text, alias: true })),
  ];
}

/** The screen rect of a whole-word, case-sensitive match in the open scene's
 *  own text, longest-first at a shared start offset -- `matchesInText`'s own
 *  tie-break, restated, walked left to right exactly as it walks a document.
 *
 *  "any" (`--cast-card`) ACCEPTS THE FIRST MATCH FOUND, whichever family
 *  won it. "alias-only" (`--cast-alias`, boot 4) skips every match the
 *  matcher's OWN algorithm would give to a name -- not merely every
 *  candidate whose text equals a name, "Roland Vetch"'s own case -- and
 *  takes the leftmost one an ALIAS wins outright, jumping past each skipped
 *  match by its own length so the scan does not re-enter the text it just
 *  matched.
 *
 *  Throws, naming `flagName`, when there is no cast to look for or no
 *  qualifying match at all. */
export function locateCastHoverRect(
  rootPid: number,
  candidates: readonly CastHoverCandidate[],
  flagName: string,
  mode: "any" | "alias-only" = "any",
): CastHoverRect {
  const usable = candidates.filter((c) => c.text.length >= MIN_CAST_NAME_LENGTH);
  if (usable.length === 0) {
    throw new Error(`${flagName}: the seeded project has no cast to look for in its prose.`);
  }
  const found = Bun.spawnSync(
    [
      "python3",
      "-c",
      String.raw`
import json, sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
pids = {int(p) for p in sys.argv[1].split(",") if p}
candidates = json.loads(sys.argv[2])
require_alias = sys.argv[3] == "1"
desktop = pyatspi.Registry.getDesktop(0)
matched = []
for i in range(desktop.childCount):
    try:
        app = desktop.getChildAtIndex(i)
        if app.get_process_id() in pids:
            matched.append(app)
    except Exception:
        pass
entry = None
def find_entry(node):
    global entry
    try:
        if entry is not None:
            return
        if node.getRoleName() == "entry":
            entry = node
            return
        for k in range(node.childCount):
            find_entry(node.getChildAtIndex(k))
    except Exception:
        pass
if len(matched) == 1:
    find_entry(matched[0])
if entry is None:
    sys.exit(4)
t = entry.queryText()
text = t.getText(0, -1)
# LONGEST FIRST, matcher's own tie-break; ties broken by text so two runs
# over one file agree.
ordered = sorted(candidates, key=lambda c: (-len(c["text"]), c["text"]))
best = None
i = 0
n = len(text)
while i < n and best is None:
    hit = None
    for c in ordered:
        needle = c["text"]
        if not text.startswith(needle, i):
            continue
        before = text[i - 1] if i > 0 else ""
        after = text[i + len(needle)] if i + len(needle) < n else ""
        if before.isalpha() or after.isalpha():
            continue
        hit = c
        break
    if hit is None:
        i += 1
        continue
    if hit["alias"] or not require_alias:
        best = (i, i + len(hit["text"]))
    else:
        i += len(hit["text"])
if best is None:
    sys.exit(5)
start, end = best
r = t.getRangeExtents(start, end, pyatspi.WINDOW_COORDS)
rx, ry, rw, rh = r
sys.stdout.write(json.dumps({"x": rx, "y": ry, "w": rw, "h": rh}))
`,
      pidListArg(rootPid),
      JSON.stringify(usable),
      mode === "alias-only" ? "1" : "0",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (found.exitCode !== 0) {
    throw new Error(
      `${flagName}: could not locate a cast match in the open scene's prose ` +
        `(exit ${found.exitCode}): ${found.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(found.stdout.toString()) as CastHoverRect;
}

/** Whether `#cast-card` (or the `tool tip`/`tooltip` role WebKitGTK maps
 *  `role="tooltip"` to) is anywhere in the accessibility tree right now.
 *  Throws, naming `flagName`, when it is not: `mirror-cli.ts`'s own measured
 *  exception to "one AT-SPI walk per capture" -- without this second walk, a
 *  card that never showed still produces a screenshot of the prose with
 *  nothing floating over it, and nothing about the capture would say so. */
export function confirmCastCardShown(rootPid: number, flagName: string): void {
  const check = Bun.spawnSync(
    [
      "python3",
      "-c",
      String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
pids = {int(p) for p in sys.argv[1].split(",") if p}
desktop = pyatspi.Registry.getDesktop(0)
matched = []
for i in range(desktop.childCount):
    try:
        app = desktop.getChildAtIndex(i)
        if app.get_process_id() in pids:
            matched.append(app)
    except Exception:
        pass
found = False
def walk(node):
    global found
    try:
        if found:
            return
        role = node.getRoleName()
        ident = ""
        try:
            for pair in node.getAttributes():
                if pair.startswith("id:"):
                    ident = pair[3:]
        except Exception:
            pass
        if ident == "cast-card" or role in ("tool tip", "tooltip"):
            found = True
            return
        for k in range(node.childCount):
            walk(node.getChildAtIndex(k))
    except Exception:
        pass
if len(matched) == 1:
    walk(matched[0])
sys.exit(0 if found else 5)
`,
      pidListArg(rootPid),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (check.exitCode !== 0) {
    throw new Error(
      `${flagName}: the card never appeared -- no accessible node with id cast-card or role ` +
        `tool tip after the settle (exit ${check.exitCode}): ${check.stderr.toString().trim()}`,
    );
  }
}

/** Every accessible NAME under `#cast-card` (or the `tool tip`/`tooltip`
 *  role), joined with a newline -- not just one node's, because the card's
 *  own name element (`.cast-card-name`, `cast-card.ts`) carries no DOM id
 *  for this bridge to key on, `matchesInText`'s own reason header restates:
 *  WebKitGTK hands a plain `<span>` inside an accessible subtree no node of
 *  its own where the framework does not ask for one. Collecting every name
 *  under the card and asking whether it CONTAINS the expected text is the
 *  same shape `words-cli.ts` already reads a caret through, and it survives
 *  a change to the card's own markup that a single hard-coded path would
 *  not. Returns None when the card is not there at all, which a caller
 *  turns into its own gate failure rather than this file's. */
/** The card's NAME NODE by its DOM id (`#cast-card-name`, 105): a plain div
 *  has no accessible name for the walk below to collect, and the first run
 *  of `cast_alias_marks` read back only "Open in Cast". The id-keyed text
 *  walk is the one `#scene-heading` and `#timeline-status` are read by. */
export function castCardNameText(rootPid: number): string | null {
  try {
    const proc = Bun.spawnSync(["python3", "-c", PY_READ_NODES, pidListArg(rootPid), "cast-card-name"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const texts = JSON.parse(proc.stdout.toString()) as Record<string, string>;
    const text = texts["cast-card-name"];
    return text === undefined || text === "" ? null : text;
  } catch {
    return null;
  }
}

export function castCardText(rootPid: number): string | null {
  const byId = castCardNameText(rootPid);
  if (byId !== null) return byId;
  const read = Bun.spawnSync(
    [
      "python3",
      "-c",
      String.raw`
import sys
try:
    import pyatspi
except Exception:
    sys.exit(3)
pids = {int(p) for p in sys.argv[1].split(",") if p}
desktop = pyatspi.Registry.getDesktop(0)
matched = []
for i in range(desktop.childCount):
    try:
        app = desktop.getChildAtIndex(i)
        if app.get_process_id() in pids:
            matched.append(app)
    except Exception:
        pass
card = None
def find_card(node):
    global card
    try:
        if card is not None:
            return
        role = node.getRoleName()
        ident = ""
        try:
            for pair in node.getAttributes():
                if pair.startswith("id:"):
                    ident = pair[3:]
        except Exception:
            pass
        if ident == "cast-card" or role in ("tool tip", "tooltip"):
            card = node
            return
        for k in range(node.childCount):
            find_card(node.getChildAtIndex(k))
    except Exception:
        pass
if len(matched) == 1:
    find_card(matched[0])
if card is None:
    sys.exit(5)
names = []
def collect(node):
    try:
        if node.name:
            names.append(node.name)
        for k in range(node.childCount):
            collect(node.getChildAtIndex(k))
    except Exception:
        pass
collect(card)
sys.stdout.write("\n".join(names))
`,
      pidListArg(rootPid),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (read.exitCode !== 0) return null;
  return read.stdout.toString();
}
