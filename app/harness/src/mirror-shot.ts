// app/harness/src/mirror-shot.ts
// A capture of the readable folder's change set, with REAL rows.
//
// GRADES NOTHING and writes no result, like `shot-cli`. It exists because the
// change-set panel cannot be photographed the way every other surface here can:
// its content is produced by a writer editing a file OUTSIDE the application
// while the application is closed, which takes two boots and an edit in between.
//
// TWO BOOTS, and each one is doing something the other cannot:
//   1. The application writes the mirror. It needs a KEYSTROKE first -- the
//      pass is owed only after a committed flush, so a boot that types nothing
//      leaves nothing to write and the folder stays empty. That cost this
//      script three runs.
//   2. After a file is rewritten from outside, the scan at open notices it,
//      the entry is paused, and File > Changes in your folder... has something
//      to say.
//
// THE OTHER THING THAT COST THREE RUNS: `xdotool windowfocus` before typing.
// Without it the click lands on an unfocused window, the keystrokes reach
// nothing, no flush commits, nothing marks the mirror dirty, and the folder is
// empty for a reason that looks exactly like a broken mirror. `windowfocus`,
// never `windowactivate`, is the harness's recorded rule; and a BARE `click`
// after a windowed `mousemove`, because WebKitGTK ignores `click --window` and
// the pointer only hovers.
//
// NOT A GRADED RIG. `mirror-cli.ts` beside it is the graded one; this
// stays because a capture is a measurement of its own and the two want
// different things from the same two boots -- this one paints a panel with a
// diff open and photographs it, and grades nothing.
//
// THE COMPARE CONTROL IS FOUND BY ITS ACCESSIBLE NAME, not a restated
// coordinate: this replaced a `["524", "295"]` window-coordinate constant that
// had already rotted once (the row moved and the number did not follow)
// with an AT-SPI walk after the panel settles. A name that is not there
// refuses the capture with the names AT-SPI actually found, rather than
// clicking whatever now sits at the old point and calling that success.
import { readBookId } from "./book-id";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { BIN, assertAtspiBridgeEnabled, findWindowId, runShell } from "./shell";
import { menuDriver } from "./menu-drive";
import { locateNodes } from "./nodes";
import { nodeToPress, pressPoint } from "./press-selector";
import { parseGeometry } from "./window-size";

const DIST = "app/ui/dist";
const FIXTURE = "lab/fixtures/out/tiny";

/** How long to let the first boot's ten-second mirror schedule come round. */
const MIRROR_WAIT_MS = 16_000;

export type MirrorChangesCaptureOptions = {
  theme: "light" | "dark";
  out: string;
};

function xdo(display: string, args: string[]): string {
  const p = Bun.spawnSync(["xdotool", ...args], {
    env: { ...process.env, DISPLAY: display },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`xdotool ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// THE MIRROR IS ENABLED THROUGH `settings.json`, the way `shot-cli` seeds every
// other preference: the enable ACT is a panel click, and driving it would make
// this capture about the project panel rather than about the change set.
//
// `theme: scheme` FORCES THE APP'S OWN PALETTE, the way `shot-cli` does for
// every capture that also needs an AT-SPI walk: it writes the `data-theme`
// attribute directly (`theme.ts`), independently of `prefers-color-scheme` and
// of whether the session bus is reachable at all -- unlike `--scheme`, which
// works by cutting the bus so WebKitGTK falls back to GtkSettings, and AT-SPI
// lives on that same bus. This script takes the walk to find Compare, so it
// cannot afford to cut the bus its own probe needs.
function mirrorFiles(mirrorRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".md")) found.push(p);
    }
  };
  walk(mirrorRoot);
  return found.sort();
}

/** Whether any document's revision moved, so a failure to type is reported as
 *  itself rather than as an empty mirror. */
function typingLanded(project: string): boolean {
  const db = new Database(project, { readonly: true });
  try {
    const rows = db.query("SELECT rev FROM doc").all() as { rev: number }[];
    return rows.some((r) => r.rev > 1);
  } finally {
    db.close();
  }
}

/** `mirror-changes.ts` ~285-290's aria-label template and the two state
 *  sentences it can carry here, RESTATED rather than parsed out of `en.ts`:
 *  the harness's rule for a value another module owns, the same rule
 *  `menu-drive.ts` and `window-size.ts` follow for a threshold or an index. A
 *  drift is findable by these keys: "mirror.changes.row.name",
 *  "mirror.changes.state.prose", "mirror.changes.state.conflict" in
 *  `app/ui/src/i18n/en.ts`. */
const ROW_NAME_TEMPLATE = "{title}. {state}. Comparing what is in your book with what is in the file.";
const STATE_PROSE = "The words changed";
const STATE_CONFLICT = "The words changed here and in your book";

/** The directory `manifest.json` sits in, and the entries it names. Read
 *  rather than restated: `mirror.rs` writes one path, `id` and `doc_rev` per
 *  file it produced, and the row this script is about to press is named
 *  after the same `id` and classified by the same `doc_rev`.
 *
 *  MORE THAN ONE `manifest.json` under the root refuses rather than taking
 *  the last one the walk happens to visit: this mirror belongs to one slug
 *  directory, and a second file found here means the walk is reading
 *  something this script does not understand, not that the newer one wins. */
function readManifest(
  root: string,
): { dir: string; entries: { id: string; path: string; doc_rev: number }[] } {
  let found: string | null = null;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (entry === "manifest.json") {
        if (found !== null) throw new Error(`two manifest.json under ${root}: ${found} and ${p}`);
        found = p;
      }
    }
  };
  walk(root);
  if (found === null) throw new Error(`no manifest.json under ${root}`);
  const manifestDir = dirname(found);
  const parsed = JSON.parse(readFileSync(found, "utf8")) as {
    entries: { id: string; path: string; doc_rev: number }[];
  };
  return { dir: manifestDir, entries: parsed.entries };
}

/** The Compare control's accessible name for the row this script rewrote:
 *  the book's own title for that item, and the state word `mirror.rs` ~1142
 *  would pick -- CONFLICT when the store's own document revision has moved
 *  past what the manifest recorded at the mirror pass, PROSE otherwise.
 *  Decided from the data rather than assumed PROSE outright: the book side
 *  never moves here between the mirror pass and this boot's open, so this
 *  always resolves to PROSE at this fixture, but a script that later edits
 *  the book between boots gets the right name without anyone reading this
 *  comment again.
 *
 *  A FUNCTION REPLACEMENT, not `String.replace("{title}", title)`: the
 *  string form re-parses `$`-sequences in the REPLACEMENT argument, so a
 *  title that happened to contain `$&` would splice the whole match into
 *  itself. A callback's return value is inserted literally. */
function compareAccessibleName(target: string, mirrorRoot: string, project: string): string {
  const manifest = readManifest(mirrorRoot);
  const relPath = relative(manifest.dir, target).replaceAll("\\", "/");
  const entry = manifest.entries.find((e) => e.path === relPath);
  if (entry === undefined) {
    throw new Error(
      `no manifest entry for ${relPath}; entries: ${manifest.entries.map((e) => e.path).join(", ")}`,
    );
  }
  const db = new Database(project, { readonly: true });
  let title: string;
  let storeRev: number;
  try {
    const item = db.query("SELECT title FROM item WHERE id = ?").get(entry.id) as { title: string } | null;
    if (item === null) throw new Error(`manifest entry ${entry.id} names no item in the store`);
    title = item.title;
    const doc = db.query("SELECT rev FROM doc WHERE item_id = ?").get(entry.id) as { rev: number } | null;
    storeRev = doc?.rev ?? 0;
  } finally {
    db.close();
  }
  const state = storeRev !== entry.doc_rev ? STATE_CONFLICT : STATE_PROSE;
  return ROW_NAME_TEMPLATE.replace(/\{title\}|\{state\}/g, (token) =>
    token === "{title}" ? title : state,
  );
}

export async function captureMirrorChanges({ theme: scheme, out }: MirrorChangesCaptureOptions): Promise<void> {
  if (process.env.APP_GUI !== "1") {
    throw new Error("APP_GUI=1 is required; no capture was started");
  }
  assertAtspiBridgeEnabled(process.env);
  let work: string | null = null;
  try {
    work = mkdtempSync(join(tmpdir(), "mirror-shot-"));
    const project = join(work, "project.db");
    const dataHome = join(work, "data");
    const mirrorRoot = join(work, "mirror");
    const configHome = join(work, "config");
    mkdirSync(join(dataHome, "garret"), { recursive: true });
    mkdirSync(mirrorRoot, { recursive: true });
    mkdirSync(join(configHome, "gtk-3.0"), { recursive: true });
    const seeded = Bun.spawnSync([BIN, "--seed", FIXTURE, project], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (seeded.exitCode !== 0) throw new Error("seeding the project failed");
    writeFileSync(
      join(dataHome, "garret", "settings.json"),
      JSON.stringify({ theme: scheme, mirrored_book_ids: [readBookId(project)] }),
    );
    writeFileSync(
      join(configHome, "gtk-3.0", "settings.ini"),
      `[Settings]\ngtk-application-prefer-dark-theme=${scheme === "dark" ? 1 : 0}\n`,
    );
    const sharedEnv = {
      APP_RUN: "interactive",
      APP_PROJECT: project,
      APP_MIRROR_DIR: mirrorRoot,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      GDK_BACKEND: "x11",
      // The settings force the palette without cutting the session bus: the
      // second boot needs AT-SPI to find Compare.
    };

    console.log("[1/4] first boot: the application writes the mirror");
    await runShell({
      mode: "virtual",
      soakMs: 0,
      staged: DIST,
      env: sharedEnv,
      probeA11y: false,
      onReady: async ({ displayNum }) => {
        if (displayNum === null) throw new Error("mirror capture requires a fixed X display");
        const display = `:${displayNum}`;
        const wid = findWindowId(display);
        xdo(display, ["windowfocus", wid]);
        if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("shell window did not receive focus");
        await Bun.sleep(4000);
        xdo(display, ["mousemove", "--window", wid, "700", "500"]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(500);
        xdo(display, ["type", "--window", wid, "--delay", "40", "A first line from the writer. "]);
        await Bun.sleep(MIRROR_WAIT_MS);
        if (!typingLanded(project)) {
          throw new Error(
            "no document revision moved, so nothing marked the mirror dirty: the keystrokes did not " +
              "reach the editor. Check the windowfocus above before blaming the mirror.",
          );
        }
      },
    });

    const files = mirrorFiles(mirrorRoot);
    if (files.length === 0) throw new Error("the mirror wrote nothing on the first boot");
    console.log(`[2/4] the mirror holds ${files.length} file(s)`);

    const target = files.find((f) => readFileSync(f, "utf8").includes("\n\n")) ?? files[0]!;
    const current = readFileSync(target, "utf8");
    const lines = current.split("\n");
    const head = lines.slice(0, lines.findIndex((l) => l.startsWith("# ")) + 1);
    writeFileSync(
      target,
      `${head.join("\n")}\n\nShe had rewritten the whole scene in another editor, and the ending was different now.\n`,
    );
    console.log(`[3/4] rewrote ${target.replace(mirrorRoot, "<mirror>")} from outside`);

    await runShell({
      mode: "virtual",
      soakMs: 0,
      staged: DIST,
      env: sharedEnv,
      probeA11y: false,
      onReady: async ({ displayNum, rootPid }) => {
        if (displayNum === null) throw new Error("mirror capture requires a fixed X display");
        const display = `:${displayNum}`;
        const wid = findWindowId(display);
        xdo(display, ["windowfocus", wid]);
        if (xdo(display, ["getwindowfocus"]) !== wid) throw new Error("shell window did not receive focus");
        await Bun.sleep(6000);
        await menuDriver(display, wid, xdo).activate("menu-mirror-changes");
        await Bun.sleep(1500);

        // ONE WALK, after the panel is open and settled: several AT-SPI walks in
        // one window kill the application outright, and the menu drive above
        // needed none of its own.
        const compareName = compareAccessibleName(target, mirrorRoot, project);
        console.log(`  pressing by name: "${compareName}"`);
        const geometry = parseGeometry(xdo(display, ["getwindowgeometry", "--shell", wid]));
        const node = nodeToPress(locateNodes(rootPid), { by: "name", value: compareName }, "mirror-shot");
        const at = pressPoint(node, geometry);
        xdo(display, ["mousemove", "--window", wid, String(at.x), String(at.y)]);
        xdo(display, ["click", "1"]);
        await Bun.sleep(1200);

        mkdirSync(dirname(out), { recursive: true });
        const screenshot = Bun.spawnSync(["import", "-window", wid, out], {
          env: { ...process.env, DISPLAY: display },
          stdout: "pipe",
          stderr: "pipe",
        });
        if (screenshot.exitCode !== 0) {
          throw new Error(`could not capture the change set: ${screenshot.stderr.toString().trim()}`);
        }
      },
    });
    console.log(`[4/4] wrote ${out}`);
  } finally {
    if (work !== null) rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const requestedScheme = process.argv[2] ?? "light";
  if (requestedScheme !== "light" && requestedScheme !== "dark") {
    throw new Error("usage: APP_GUI=1 bun app/harness/src/mirror-shot.ts [light|dark] [out.png]");
  }
  if (process.env.APP_GUI !== "1") {
    throw new Error("APP_GUI=1 is required; no capture was started");
  }
  await captureMirrorChanges({
    theme: requestedScheme,
    out: process.argv[3] ?? `app/results/screenshots/change-set-${requestedScheme}-tiny.png`,
  });
}
