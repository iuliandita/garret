import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every embedded desktop walk this repo carries, spliced with the pid selector
// (073), checked for: python SYNTAX; that the splice actually landed
// (`get_process_id()` and `matched` present); and that no script still names
// what the splice replaced (`target.lower()`, `app.name`). Syntax alone would
// pass a script that lost its `${PY_SELECT_APPS}` splice entirely or one that
// still names the deleted `target` variable in a dead branch -- this also
// checks the four things a review round found missing.
//
// No *-cli.ts module is EXECUTED to get there: every one of them is a graded
// rig whose own top level calls `process.exit(0)` when APP_GUI is unset (its
// normal, harmless "skipped" exit) -- `import`ing it for its export would run
// that exit inside THIS test process and take the whole suite down with it.
// Each script's raw text is read off the source file instead, and
// `${PY_SELECT_APPS}` is substituted the same way the `String.raw` template
// substitutes it at runtime, so the string checked here is exactly the string
// python receives.
const SRC = join(import.meta.dir, "..", "src");

/** Every `(export )?const NAME = String.raw\`...\`;` template in `source`,
 *  as `{ name, body }` pairs. Non-greedy up to the first `` `; `` closer: none
 *  of these templates embed a literal backtick, so the first closer is always
 *  the real one. */
function templatesIn(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*String\.raw`([\s\S]*?)`;/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) out.push({ name: m[1]!, body: m[2]! });
  return out;
}

const atspiSource = readFileSync(join(SRC, "atspi.ts"), "utf8");
const selectApps = templatesIn(atspiSource).find((t) => t.name === "PY_SELECT_APPS");
if (selectApps === undefined) throw new Error("PY_SELECT_APPS not found in atspi.ts");
const PY_SELECT_APPS = selectApps.body;

const SPLICE_MARKER = "${PY_SELECT_APPS}";

/** Every spliced script in `app/harness/src`, found by SCANNING every file for
 *  the literal splice marker rather than by naming files or exports: a new
 *  walk that splices the prelude is covered the moment it is written, with no
 *  second place to remember to update. A file with two spliced templates
 *  (words-cli's PY_PROBE and PY_WATCH) contributes both. */
function findSplicedScripts(): { key: string; text: string }[] {
  const found: { key: string; text: string }[] = [];
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(SRC, file), "utf8");
    if (!source.includes(SPLICE_MARKER)) continue;
    for (const { name, body } of templatesIn(source)) {
      if (!body.includes(SPLICE_MARKER)) continue;
      const text = body.replaceAll(SPLICE_MARKER, PY_SELECT_APPS);
      found.push({ key: `${file}.${name}`, text });
    }
  }
  return found;
}

const SCRIPTS = findSplicedScripts();

/** Occurrences of the splice marker across every source file, counted by a
 *  plain substring split -- independent of `templatesIn`'s regex. The two
 *  counts must agree: if the regex ever failed to capture a template that
 *  contains the marker (a multiline edge case, a second template in one
 *  file), this count would stay high while `SCRIPTS.length` silently dropped,
 *  which is exactly the failure an earlier version of this test could not
 *  see. */
function markerOccurrences(): number {
  let total = 0;
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(SRC, file), "utf8");
    total += source.split(SPLICE_MARKER).length - 1;
  }
  return total;
}

// words-cli's PY_WATCH is the only script that also needs GLib; harmless to
// prefix on every script, since an unused import is not a syntax error.
const PRELUDE = "import sys\nimport pyatspi\nfrom gi.repository import GLib\n";

const MOCKED_ATSPI_RUNNER = String.raw`
import sys
import types

pyatspi = types.SimpleNamespace(WINDOW_COORDS=1)
sys.modules["pyatspi"] = pyatspi

class Extents:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.width, self.height = x, y, width, height

class Component:
    def __init__(self, extents):
        self.extents = extents
    def getExtents(self, coords):
        return self.extents

class Text:
    def __init__(self, text, selection):
        self.text, self.selection = text, selection
    def getText(self, start, end):
        return self.text
    def getSelection(self, index):
        return self.selection

class Node:
    def __init__(self, role, ident, name, extents, children=(), text="", selection=(0, 0)):
        self.role, self.ident, self.name = role, ident, name
        self.extents, self.children = extents, list(children)
        self.text, self.selection = text, selection
    @property
    def childCount(self):
        return len(self.children)
    def getRoleName(self):
        return self.role
    def getAttributes(self):
        return ["id:" + self.ident] if self.ident else []
    def queryComponent(self):
        return Component(self.extents)
    def queryText(self):
        return Text(self.text, self.selection)
    def getChildAtIndex(self, index):
        return self.children[index]

class BrokenNode(Node):
    def queryComponent(self):
        raise RuntimeError("anonymous node has no component")

root = Node("application", "", "", Extents(0, 0, 0, 0), [
    Node("push button", "save", "Save", Extents(10, 20, 30, 40)),
    Node("toggle button", "focus-toggle", "Focus mode", Extents(50, 60, 70, 80)),
    Node("menu item", "menu-export-as", "Export as", Extents(120, 130, 140, 30)),
    Node("menu item", "menu-export", "Export manuscript", Extents(120, 170, 140, 30)),
    Node("label", "excluded", "Excluded", Extents(90, 100, 110, 120)),
])
if "--mock-duplicate" in sys.argv:
    root.children.append(Node("menu item", "menu-export", "Duplicate export", Extents(120, 210, 140, 30)))
if "--mock-anonymous" in sys.argv:
    root.children.append(BrokenNode("panel", "", "", Extents(0, 0, 0, 0), [
        Node("label", "count", "Count", Extents(0, 0, 0, 0)),
        Node("label", "notice", "Notice", Extents(0, 0, 0, 0)),
        Node("text", "", "", Extents(0, 0, 1, 1), text="selected", selection=(0, 8)),
    ]))
namespace = globals()
namespace["__name__"] = "__main__"
exec(compile(sys.stdin.read(), "<probe>", "exec"), namespace)
`;

function splicedTemplate(file: string, name: string): string {
  const source = readFileSync(join(SRC, file), "utf8");
  const template = templatesIn(source).find((candidate) => candidate.name === name);
  if (template === undefined) throw new Error(`${file}.${name} not found`);
  return template.body.replace(SPLICE_MARKER, "matched = [root]");
}

function runMockedProbe(script: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(["python3", "-c", MOCKED_ATSPI_RUNNER, ...args], {
    stdin: Buffer.from(script),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`mocked probe failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

const TOGGLE_NODE = {
  role: "toggle button",
  id: "focus-toggle",
  name: "Focus mode",
  x: 50,
  y: 60,
  w: 70,
  h: 80,
};

describe("geometry probes", () => {
  test("export and words probes emit ordinary push and toggle controls with geometry", () => {
    for (const [file, args] of [
      ["export-cli.ts", ["0", "count", "notice", "menu-export"]],
      ["words-cli.ts", ["0", "count"]],
    ] as const) {
      const output = runMockedProbe(splicedTemplate(file, "PY_PROBE"), args);
      const nodes = (JSON.parse(output) as { nodes: typeof TOGGLE_NODE[] }).nodes;
      expect(nodes).toContainEqual({
        role: "push button",
        id: "save",
        name: "Save",
        x: 10,
        y: 20,
        w: 30,
        h: 40,
      });
      expect(nodes).toContainEqual(TOGGLE_NODE);
      expect(nodes.some((node) => node.id === "excluded")).toBe(false);
      expect(nodes.some((node) => node.id === "menu-export")).toBe(false);
    }
  });

  test("export probe locates only the exact menu-export id, independent of menu position", () => {
    const output = runMockedProbe(splicedTemplate("export-cli.ts", "PY_PROBE"), [
      "0",
      "count",
      "notice",
      "menu-export",
    ]);
    const probe = JSON.parse(output) as {
      exports: { id: string; role: string; name: string; x: number; y: number; w: number; h: number }[];
    };
    expect(probe.exports).toEqual([
      {
        role: "menu item",
        id: "menu-export",
        name: "Export manuscript",
        x: 120,
        y: 170,
        w: 140,
        h: 30,
      },
    ]);
  });

  test("export probe reports missing and duplicate exact ids", () => {
    const script = splicedTemplate("export-cli.ts", "PY_PROBE");
    const missing = JSON.parse(runMockedProbe(script, ["0", "count", "notice", "menu-missing"])) as {
      exports: unknown[];
    };
    const duplicate = JSON.parse(
      runMockedProbe(script, ["0", "count", "notice", "menu-export", "--mock-duplicate"]),
    ) as { exports: { id: string }[] };
    expect(missing.exports).toEqual([]);
    expect(duplicate.exports.map((node) => node.id)).toEqual(["menu-export", "menu-export"]);
  });

  test("export probe reaches named children when no target id was requested", () => {
    const output = runMockedProbe(splicedTemplate("export-cli.ts", "PY_PROBE"), [
      "0",
      "count",
      "notice",
      "",
      "--mock-anonymous",
    ]);
    const probe = JSON.parse(output) as {
      count: { role: string; name: string } | null;
      notice: string | null;
      selection: string;
      exports: unknown[];
    };
    expect(probe).toMatchObject({
      count: { role: "label", name: "Count" },
      notice: "Notice",
      selection: "selected",
      exports: [],
    });
  });

  test("outline probe emits ordinary push and toggle controls with geometry", () => {
    const rows = runMockedProbe(splicedTemplate("outline-cli.ts", "PY_NODES"), ["0"])
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    expect(rows).toContainEqual(["push button", "save", "Save", "10", "20", "30", "40"]);
    expect(rows).toContainEqual([
      "toggle button",
      "focus-toggle",
      "Focus mode",
      "50",
      "60",
      "70",
      "80",
    ]);
    expect(rows.some((row) => row[1] === "excluded")).toBe(false);
  });
});

describe("every spliced desktop walk", () => {
  // Exact count, not a floor with slack: the plan named nine sites, the review
  // that followed this one found the guard's own `>= 9` would let four of the
  // thirteen actual scripts vanish silently, and atspi.ts's PY_DUMP is a
  // fourteenth the earlier version of this test could not even see (it was
  // `const`, not `export const`). 14 is 13 rig walks plus PY_DUMP.
  test("finds exactly as many scripts as the marker appears, and at least 14", () => {
    expect(SCRIPTS.length).toBe(markerOccurrences());
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(14);
  });

  for (const { key, text } of SCRIPTS) {
    test(`${key} is valid python and actually selects by pid`, () => {
      const proc = Bun.spawnSync(
        ["python3", "-c", "import ast, sys; ast.parse(sys.stdin.read())"],
        { stdin: Buffer.from(PRELUDE + text), stdout: "pipe", stderr: "pipe" },
      );
      if (proc.exitCode !== 0) {
        throw new Error(`${key} failed to parse: ${proc.stderr.toString().trim()}`);
      }
      expect(proc.exitCode).toBe(0);
      // Syntax alone would pass a script that lost its splice, or a stale
      // fallback that still names what the splice replaced.
      expect(text).toContain("get_process_id()");
      expect(text).toContain("matched");
      expect(text).not.toContain("target.lower()");
      expect(text).not.toContain("app.name");
    });
  }
});
