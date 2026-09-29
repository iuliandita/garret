// app/ui/test/prefs-panel-overflow.test.ts
// an eleventh group (Cast names) pushed #prefs-panel's own content past
// the bottom of a 640x480 window with nothing to stop it -- the same defect
// `#menu-panel` and `#help-panel` shipped and were fixed for.
// happy-dom does no layout, so this guards the rule at the source rather
// than through a rendered height, `prefs-legend-css.test.ts`'s own reason.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) throw new Error(`no ${selector} rule found`);
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("#prefs-panel scrolls inside the window instead of leaving it", () => {
  test("carries a max-height and scrolls its own overflow", () => {
    const rule = block("#prefs-panel");
    expect(rule).toMatch(/(?:^|;)\s*max-height\s*:\s*\S+/);
    expect(rule).toMatch(/(?:^|;)\s*overflow-y\s*:\s*auto/);
  });
});
