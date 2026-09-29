// app/ui/test/prefs-legend-css.test.ts
// `.prefs-legend` used to be a FIXED 76px flex-basis, sized for the English
// word "Typewriter". German's longer legends (Schreibmaschinenmodus,
// Erscheinungsbild, Rechtschreibung) do not fit in 76px, and a fixed basis
// forces the TEXT ITSELF to wrap inside that column rather than letting the
// row grow. This guards the fix at the source rather than at a rendered
// layout: happy-dom does no layout, so a `getComputedStyle` assertion here
// would report the browser's initial value for every rule including a
// deleted one and pass regardless.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The same convention `chrome-heights.test.ts` and its neighbours use: a
 *  block that starts its own selector list, found by the blank line before it
 *  so a substring match inside an unrelated rule cannot be mistaken for one. */
function block(selector: string): string {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) throw new Error(`no ${selector} rule found`);
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("the preferences legend column", () => {
  test("the panel shares one content-sized label column across ordinary groups", () => {
    const panel = block("#prefs-panel .panel-body");
    expect(panel).toMatch(/display\s*:\s*grid/);
    expect(panel).toMatch(/grid-template-columns\s*:\s*max-content\s+minmax\(0,\s*1fr\)/);

    const baseGroup = block('#prefs-panel [role="group"]');
    expect(baseGroup).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);

    const group = block("#prefs-panel .prefs-choice-group");
    expect(group).toMatch(/display\s*:\s*grid/);
    expect(group).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
    expect(group).toMatch(/grid-template-columns\s*:\s*subgrid/);

    const choices = block("#prefs-panel .prefs-choices");
    expect(choices).toMatch(/grid-column\s*:\s*2/);
    expect(choices).toMatch(/display\s*:\s*flex/);
    expect(choices).toMatch(/flex-wrap\s*:\s*wrap/);
    expect(choices).toMatch(/min-width\s*:\s*0/);
  });

  test("selects cannot grow past the choices column", () => {
    const rule = block("#prefs-panel .prefs-choices > select");
    expect(rule).toMatch(/max-width\s*:\s*100%/);
    expect(rule).toMatch(/min-width\s*:\s*0/);
  });

  test(".prefs-legend has no fixed pixel flex-basis", () => {
    const rule = block(".prefs-legend");
    // Any `flex` or `flex-basis` naming a pixel figure is the defect: a
    // legend whose column cannot grow past that figure wraps its own text
    // instead of letting the row widen.
    expect(rule).not.toMatch(/flex(-basis)?\s*:\s*(?:0\s+0\s+)?\d+px/);
  });

  test(".prefs-legend keeps English at the same minimum column it always drew", () => {
    const rule = block(".prefs-legend");
    expect(rule).toMatch(/min-width\s*:\s*76px/);
  });
});
