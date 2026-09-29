// app/ui/test/primary-menu-css.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

// A block that starts its own selector list: `html,\nbody {` shares a line box
// with html and is not the grid, and a bare `\nbody {` would find it first.
function block(selector: string): string | null {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) return null;
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("the primary menu's stylesheet", () => {
  test("#menu-controls follows #focus-controls in the header", async () => {
    const html = await Bun.file(join(import.meta.dir, "..", "index.html")).text();
    expect(html.indexOf('id="focus-controls"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="focus-controls"')).toBeLessThan(html.indexOf('id="menu-controls"'));
  });

  test("the two right-most header controls' tips stay inside the window", () => {
    expect(block("#focus-controls .tip,\n#menu-controls .tip")).toMatch(/(?:^|;)\s*right\s*:\s*0/);
  });

  test("the list hangs off the bar's right edge and the dropdown opens beside it", () => {
    expect(block("#app-menu-list")).toMatch(/(?:^|;)\s*right\s*:\s*12px/);
    expect(block("#app-menu-list")).toMatch(/(?:^|;)\s*top\s*:\s*100%/);
    expect(block("#menu-panel")).toMatch(/(?:^|;)\s*right\s*:\s*calc\(100% \+ 4px\)/);
    expect(block("#menu-panel")).not.toMatch(/(?:^|;)\s*left\s*:/);
  });

  test("the Menu button's glyph rebuilds the 18px line box", () => {
    const svg = block("#app-menu svg") ?? "";
    expect(svg).toMatch(/(?:^|;)\s*display\s*:\s*block/);
    const h = Number(/height\s*:\s*(\d+)px/.exec(svg)?.[1]);
    const m = Number(/margin\s*:\s*(\d+)px/.exec(svg)?.[1]);
    expect(h + 2 * m).toBe(18);
  });

  test("the dropdown scrolls inside the window instead of leaving it", () => {
    // The Outline menu is 22 rows and ends 38px above the bottom of
    // a 1200x800 window; at the 640x480 floor its last rows were outside the
    // window and unreachable by pointer. The height is set per open in
    // menu-bar.ts; the stylesheet only has to let it scroll.
    const panel = block("#menu-panel") ?? "";
    expect(panel).toMatch(/(?:^|;)\s*overflow-y\s*:\s*auto/);
  });
});
