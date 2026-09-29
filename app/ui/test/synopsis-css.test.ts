// app/ui/test/synopsis-css.test.ts
// THE SYNOPSIS PANEL'S TWO MODES MUST ACTUALLY HIDE THE OTHER BLOCK (097, W4).
// `panel.dataset.mode` is the only thing that decides which of #synopsis-read
// / #synopsis-form is on screen -- see synopsis-panel.ts's own header -- and
// `synopsis-panel.test.ts` already asserts the JS SETS the attribute, which
// is not the same claim as the stylesheet actually hiding the other block.
// `cast-sheet-css.test.ts` is the precedent: the cast panel's own equivalent
// pair shipped once without this and a stray control stood where it should
// not have. `#synopsis-read` and `#synopsis-form` are never `[hidden]`
// themselves -- neither carries the "nothing selected" state the cast panel's
// blocks do -- so this checks the plain `display: none` rule directly rather
// than the `[hidden]` override those do.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Whether `#synopsis-panel[data-mode="${mode}"] ${selector} { ... display:
 *  none ... }` appears in the stylesheet, tolerant of the block's own
 *  whitespace. Comments are already stripped, the recorded reason every guard
 *  in this repo strips them first. */
function hasModeHide(mode: "read" | "edit", selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `#synopsis-panel\\[data-mode="${mode}"\\]\\s+${escaped}\\s*\\{[^}]*display\\s*:\\s*none`,
  );
  return re.test(stripped);
}

describe("the synopsis panel's two modes each hide the other block", () => {
  test("data-mode=edit hides #synopsis-read", () => {
    expect(hasModeHide("edit", "#synopsis-read")).toBe(true);
  });

  test("data-mode=read hides #synopsis-form", () => {
    expect(hasModeHide("read", "#synopsis-form")).toBe(true);
  });
});
