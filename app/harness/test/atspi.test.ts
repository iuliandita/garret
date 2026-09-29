import { describe, expect, test } from "bun:test";
import { PY_SELECT_APPS, parseAtspiDump, pidListArg } from "../src/atspi";

// role<TAB>name<TAB>states<TAB>childCount<TAB>attrs   (attrs: k:v;k:v — colon,
// confirmed live against pyatspi's getAttributes() on a real WebKitGTK tree)
const line = (role: string, name: string, kids = 0, attrs = ""): string =>
  [role, name, "showing,visible", String(kids), attrs].join("\t");

// Header line the dump script emits: how many AT-SPI applications matched the
// pid set, before any app's tree is walked.
const header = (n: number): string => ["#apps", String(n)].join("\t");

describe("parseAtspiDump", () => {
  test("an empty dump is unavailable, not an empty pass", () => {
    const p = parseAtspiDump("");
    expect(p.available).toBe(false);
    expect(p.hasNavigator).toBe(false);
    expect(p.exposedRows).toBe(0);
  });

  test("reports the setsize the rows advertise, not the number mounted", () => {
    const dump = [
      header(1),
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
      line("list item", "Scene B", 0, "posinset:2;setsize:15200"),
      line("list item", "Scene C", 0, "posinset:3;setsize:15200"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(true);
    expect(p.hasNavigator).toBe(true);
    expect(p.exposedRows).toBe(15_200);
    expect(p.mountedRows).toBe(3);
  });

  test("roleCounts counts roles instead of listing one entry per node", () => {
    const dump = [
      header(1),
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
      line("list item", "Scene B", 0, "posinset:2;setsize:15200"),
      line("list item", "Scene C", 0, "posinset:3;setsize:15200"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.roleCounts).toEqual({
      application: 1,
      "list box": 1,
      "list item": 3,
    });
  });

  test("rows disagreeing about setsize is a defect, reported as 0", () => {
    const dump = [
      header(1),
      line("list box", "scene navigator", 2),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
      line("list item", "Scene B", 0, "posinset:2;setsize:1500"),
    ].join("\n");
    expect(parseAtspiDump(dump).exposedRows).toBe(0);
  });

  test("rows with no setsize attribute expose nothing, rather than their mounted count", () => {
    const dump = [
      header(1),
      line("list box", "scene navigator", 2),
      line("list item", "Scene A"),
      line("list item", "Scene B"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.hasNavigator).toBe(true);
    expect(p.exposedRows).toBe(0);
    expect(p.mountedRows).toBe(2);
  });

  test("a tree with no navigator is available but exposes nothing", () => {
    const dump = [header(1), line("application", "garret")].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(true);
    expect(p.hasNavigator).toBe(false);
    expect(p.exposedRows).toBe(0);
  });

  test("two matching applications cannot be attributed to one window, so the probe refuses", () => {
    const dump = [
      header(2),
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(false);
  });

  test("zero matching applications is unavailable, not an empty pass", () => {
    const dump = header(0);
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(false);
  });

  test("parses level, setsize and expanded from treeitem attributes", () => {
    const dump = [
      "#apps\t1",
      "application\tgarret\t\t1\t",
      "tree\tmanuscript navigator\tfocusable\t2\t",
      "tree item\tPart One\tfocusable,expanded\t0\tid:nav-row-0;level:1;setsize:2;posinset:1",
      "tree item\tCh A\tfocusable,expanded\t0\tid:nav-row-1;level:2;setsize:2;posinset:1",
    ].join("\n");

    const probe = parseAtspiDump(dump);
    expect(probe.available).toBe(true);
    expect(probe.exposedRows).toBe(2);
    expect(probe.treeRows).toEqual([
      { id: "nav-row-0", name: "Part One", level: 1, setsize: 2, posinset: 1, expanded: true },
      { id: "nav-row-1", name: "Ch A", level: 2, setsize: 2, posinset: 1, expanded: true },
    ]);
  });

  // Titles are not unique in the fixtures (2,292 of 20,000 stress items collide),
  // so the harness joins on the DOM id. Two rows with the same name must still
  // be distinguishable.
  test("the DOM id is surfaced per row and separates same-named rows", () => {
    const dump = [
      header(1),
      line("tree", "outline", 2),
      line("tree item", "Scene", 0, "id:nav-row-7;level:1;setsize:2;posinset:1"),
      line("tree item", "Scene", 0, "id:nav-row-9;level:1;setsize:2;posinset:2"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.treeRows.map((r) => r.id)).toEqual(["nav-row-7", "nav-row-9"]);
  });

  test("a tree role alone is a navigator, and collapsed rows report expanded:false", () => {
    const dump = [
      header(1),
      line("tree", "outline", 2),
      line("tree item", "Part One", 0, "level:1;setsize:2;posinset:1"),
      line("tree item", "Part Two", 0, "level:1;setsize:2;posinset:2"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.hasNavigator).toBe(true);
    expect(p.mountedRows).toBe(2);
    expect(p.treeRows.map((r) => r.expanded)).toEqual([false, false]);
  });

  // Prior-slice dumps are committed evidence and must stay readable.
  test("a flat list dump still parses, with no tree rows", () => {
    const dump = [
      header(1),
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
      line("list item", "Scene B", 0, "posinset:2;setsize:15200"),
      line("list item", "Scene C", 0, "posinset:3;setsize:15200"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(true);
    expect(p.hasNavigator).toBe(true);
    expect(p.exposedRows).toBe(15_200);
    expect(p.mountedRows).toBe(3);
    expect(p.treeRows).toEqual([]);
  });

  test("an unavailable probe carries no tree rows", () => {
    expect(parseAtspiDump("").treeRows).toEqual([]);
  });

  // A tree item with no level attribute is a defect, not a level-0 row; record
  // it as 0 so the structural comparison counts a mismatch rather than skipping.
  test("a tree item missing its attributes reports zeroes, not a skipped row", () => {
    const dump = [header(1), line("tree", "outline", 1), line("tree item", "Orphan")].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.mountedRows).toBe(1);
    expect(p.treeRows).toEqual([
      { id: "", name: "Orphan", level: 0, setsize: 0, posinset: 0, expanded: false },
    ]);
  });

  test("a dump with no header is not parsed optimistically", () => {
    const dump = [
      line("application", "garret"),
      line("list box", "scene navigator", 3),
      line("list item", "Scene A", 0, "posinset:1;setsize:15200"),
    ].join("\n");
    const p = parseAtspiDump(dump);
    expect(p.available).toBe(false);
  });
});

describe("pidListArg", () => {
  test("starts with the root pid and is a comma-separated list of integers", () => {
    const arg = pidListArg(process.pid);
    expect(arg.startsWith(String(process.pid))).toBe(true);
    expect(arg.split(",").every((p) => /^\d+$/.test(p))).toBe(true);
  });

  test("carries every pid under the root, not the root alone", async () => {
    // The registrant is a DESCENDANT of the spawn (xvfb-run under Xvfb);
    // a list of the root alone would match nothing and read as exit 4.
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const start = Date.now();
      while (Date.now() - start < 5000 && !pidListArg(process.pid).split(",").includes(String(child.pid))) {
        await Bun.sleep(50);
      }
      expect(pidListArg(process.pid).split(",")).toContain(String(child.pid));
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("throws naming the pid when the tree is empty", () => {
    expect(() => pidListArg(0x7ffffff0)).toThrow(/0x7ffffff0|2147483632/);
  });
});

describe("PY_SELECT_APPS", () => {
  test("selects by process id, never by name", () => {
    expect(PY_SELECT_APPS).toContain("get_process_id()");
    expect(PY_SELECT_APPS).not.toContain(".name");
  });

  test("is syntactically valid python once sys and pyatspi are imported", () => {
    const proc = Bun.spawnSync(
      ["python3", "-c", "import ast, sys; ast.parse(sys.stdin.read())"],
      { stdin: Buffer.from(`import sys\nimport pyatspi\n${PY_SELECT_APPS}`), stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
  });
});
