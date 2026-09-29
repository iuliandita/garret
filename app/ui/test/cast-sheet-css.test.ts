// app/ui/test/cast-sheet-css.test.ts
// EVERY BLOCK THE CAST PANEL HIDES NEEDS ITS OWN `[hidden]` OVERRIDE (096
// review). An element whose own rule sets `display` -- flex, grid, whatever
// -- keeps that display even while `hidden`, because an author rule beats
// the UA stylesheet's `[hidden] { display: none }` regardless of
// specificity. `#cast-new-row`'s `display: flex` shipped first without the
// override and the row could not be hidden at all; `#cast-sheet-record`'s
// `display: grid` shipped the same way one commit later, leaving a stray
// #cast-edit under "No one yet." and a deleted member's sheet still
// standing. This file is the guard so a third one does not ship quietly:
// `cast-panel.test.ts` already asserts the JS SETS `.hidden`, which is not
// the same claim as the stylesheet actually HIDING the element, and nothing
// in that file loads style.css to tell the two apart.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Whether `${selector}[hidden] { ... display: none ... }` appears in the
 *  stylesheet, tolerant of the block's own whitespace. Comments are already
 *  stripped, the recorded reason every guard in this repo strips them first:
 *  a comment EXPLAINING an override reads as one to a check that is not
 *  reading for meaning. */
function hasHiddenOverride(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`);
  return re.test(stripped);
}

// EVERY ID THIS PANEL EVER ASSIGNS `.hidden = true/false` TO, read straight
// off cast-panel.ts rather than guessed: #cast-panel, #cast-detail,
// #cast-sheet, #cast-sheet-record, #cast-sheet-summary, #cast-sheet-fields
// and #cast-new-row. THE PICTURE BLOCKS ARE NOT HERE, deliberately: neither
// `#cast-picture-block` nor `#cast-sheet-picture` is ever hidden -- their
// CONTENTS are replaced per state (`paintPicture`, `paintSheetPicture`), so
// there is no `[hidden]` toggle for a stylesheet rule to defeat.
const TOGGLED_IDS = [
  "#cast-panel",
  "#cast-sheet",
  "#cast-sheet-record",
  "#cast-sheet-summary",
  "#cast-sheet-fields",
  "#cast-detail",
  "#cast-new-row",
];

describe("every block the cast panel hides carries its own [hidden] override", () => {
  for (const selector of TOGGLED_IDS) {
    test(`${selector}[hidden] sets display: none`, () => {
      expect(hasHiddenOverride(selector)).toBe(true);
    });
  }
});
