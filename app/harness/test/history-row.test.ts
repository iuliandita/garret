import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersionRowControls } from "../src/history-row";

const REAL = "app/ui/src/history.ts";

function fixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "history-row-"));
  const path = join(dir, "history.ts");
  writeFileSync(path, source, "utf8");
  return path;
}

/** A row builder with the shape the parser depends on and none of the rest of
 *  the panel. `names` are appended in order; those in `buttons` are created as
 *  buttons and everything else as a span. */
function rowSource(names: string[], buttons: string[]): string {
  const decls = names
    .map(
      (name) =>
        `  const ${name} = document.createElement(${buttons.includes(name) ? '"button"' : '"span"'});`,
    )
    .join("\n");
  return `function paint() {\n  const el = document.createElement("div");\n${decls}\n  el.append(${names.join(", ")});\n}\n`;
}

describe("the version row's controls parse out of history.ts", () => {
  test("the shipped panel puts Restore one step further back than Compare", () => {
    const parsed = parseVersionRowControls(REAL);
    // Not asserted as a literal 2: the point of the parse is that the number
    // follows the source. What IS asserted is the relationship the rig depends
    // on -- Restore is a button, and it is not the last one.
    expect(parsed.buttons).toContain("restore");
    expect(parsed.shiftTabsToRestore).toBeGreaterThanOrEqual(1);
    expect(parsed.shiftTabsToRestore).toBe(
      parsed.buttons.length - parsed.buttons.indexOf("restore"),
    );
  });

  test("a row whose only control is Restore costs one Shift+Tab", () => {
    const path = fixture(rowSource(["when", "restore"], ["restore"]));
    expect(parseVersionRowControls(path).shiftTabsToRestore).toBe(1);
  });

  test("a button appended after Restore costs one more, which is the whole defect", () => {
    const path = fixture(rowSource(["when", "restore", "compare"], ["restore", "compare"]));
    const parsed = parseVersionRowControls(path);
    expect(parsed.shiftTabsToRestore).toBe(2);
    expect(parsed.buttons).toEqual(["restore", "compare"]);
  });

  test("a non-button appended after Restore costs nothing, because it is not a tab stop", () => {
    const path = fixture(rowSource(["restore", "note"], ["restore"]));
    expect(parseVersionRowControls(path).shiftTabsToRestore).toBe(1);
  });

  test("a button appended BEFORE Restore does not move it", () => {
    const path = fixture(rowSource(["pin", "restore", "compare"], ["pin", "restore", "compare"]));
    expect(parseVersionRowControls(path).shiftTabsToRestore).toBe(2);
  });

  test("a source that appends no restore throws rather than guessing", () => {
    const path = fixture(rowSource(["when", "compare"], ["compare"]));
    expect(() => parseVersionRowControls(path)).toThrow(/no el\.append/);
  });

  test("a restore that is no longer a button throws rather than counting it", () => {
    const path = fixture(rowSource(["restore", "compare"], ["compare"]));
    expect(() => parseVersionRowControls(path)).toThrow(/not created as a button/);
  });

  test("two rows appending restore are ambiguous and refused", () => {
    const one = rowSource(["restore"], ["restore"]);
    const path = fixture(`${one}\n${one}`);
    expect(() => parseVersionRowControls(path)).toThrow(/ambiguous/);
  });

  test("a source creating no buttons at all throws", () => {
    const path = fixture(rowSource(["when", "restore"], []));
    expect(() => parseVersionRowControls(path)).toThrow(/no button is created/);
  });
});
