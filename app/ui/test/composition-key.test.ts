import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";
import { isCompositionKey } from "../src/composition-key";
import { isQuitChord } from "../src/quit";
import { isAddCommentChord } from "../src/comments";
import { isShowCastCardChord } from "../src/cast-card";
import { isContextMenuChord } from "../src/nav-context-menu";
import { historyChordOf } from "../src/nav-history";
import { zoomActionFor } from "../src/zoom";
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

test("composition keys do not become application commands", () => {
  const cases: Array<[KeyboardEventInit, (event: KeyboardEvent) => unknown, unknown]> = [
    [{ key: "q", ctrlKey: true }, isQuitChord, false],
    [{ key: "m", ctrlKey: true, altKey: true }, isAddCommentChord, false],
    [{ key: "i", ctrlKey: true, shiftKey: true }, isShowCastCardChord, false],
    [{ key: "F10", shiftKey: true }, isContextMenuChord, false],
    [{ key: "ArrowLeft", altKey: true }, historyChordOf, null],
    [{ key: "+", ctrlKey: true }, zoomActionFor, null],
  ];
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const [chord, action, ignored] of cases) {
      const event = new KeyboardEvent("keydown", { ...chord, ...composition });
      expect(isCompositionKey(event)).toBe(true);
      expect(action(event)).toBe(ignored);
      expect(action(new KeyboardEvent("keydown", chord))).not.toBe(ignored);
    }
  }
  expect(isCompositionKey({})).toBe(false);
});
