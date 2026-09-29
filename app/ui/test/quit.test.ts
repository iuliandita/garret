import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createQuit, isQuitChord } from "../src/quit";

/** A cancelable keydown, because `preventDefault` on a NON-cancelable event is a
 *  no-op and every assertion about it would pass against an implementation that
 *  never calls it. */
function chord(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
}

describe("isQuitChord", () => {
  test("Ctrl+Q is the chord", () => {
    expect(isQuitChord(chord({ key: "q", ctrlKey: true }))).toBe(true);
  });

  test("a capsed or shifted Q is the same chord", () => {
    expect(isQuitChord(chord({ key: "Q", ctrlKey: true }))).toBe(true);
  });

  test("Meta+Q is the chord too", () => {
    expect(isQuitChord(chord({ key: "q", metaKey: true }))).toBe(true);
  });

  // Each of the four refusals below has its own fixture, because a predicate
  // tested only on the positive case passes for `() => true` -- and `() => true`
  // on a document keydown quits the application on the next keypress.
  test("a bare q is not the chord", () => {
    expect(isQuitChord(chord({ key: "q" }))).toBe(false);
  });

  test("Ctrl with another letter is not the chord", () => {
    expect(isQuitChord(chord({ key: "f", ctrlKey: true }))).toBe(false);
  });

  test("Ctrl+Alt+Q is not the chord", () => {
    expect(isQuitChord(chord({ key: "q", ctrlKey: true, altKey: true }))).toBe(false);
  });

  test("Alt+Q alone is not the chord", () => {
    expect(isQuitChord(chord({ key: "q", altKey: true }))).toBe(false);
  });
});

describe("createQuit", () => {
  test("the chord asks the host to quit", () => {
    let asked = 0;
    const quit = createQuit({ requestQuit: () => void asked++ });
    document.dispatchEvent(chord({ key: "q", ctrlKey: true }));
    expect(asked).toBe(1);
    quit.destroy();
  });

  test("the chord is prevented, because the engine has its own binding", () => {
    const quit = createQuit({ requestQuit: () => undefined });
    const event = chord({ key: "q", ctrlKey: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    quit.destroy();
  });

  test("a key that is not the chord is left alone", () => {
    let asked = 0;
    const quit = createQuit({ requestQuit: () => void asked++ });
    const event = chord({ key: "q" });
    document.dispatchEvent(event);
    expect(asked).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    quit.destroy();
  });

  test("run() asks without a keyboard, which is what the menu item calls", () => {
    let asked = 0;
    const quit = createQuit({ requestQuit: () => void asked++ });
    quit.run();
    expect(asked).toBe(1);
    quit.destroy();
  });

  test("a destroyed unit hears nothing", () => {
    let asked = 0;
    const quit = createQuit({ requestQuit: () => void asked++ });
    quit.destroy();
    document.dispatchEvent(chord({ key: "q", ctrlKey: true }));
    expect(asked).toBe(0);
  });

  // A leaked document listener here is invisible to every behavioural test --
  // the recorded menu-bar case -- so what catches it is COUNTING.
  test("destroy removes exactly what it added", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      createQuit({ requestQuit: () => undefined }).destroy();
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
    expect(added.length).toBeGreaterThan(0);
    expect([...removed].sort()).toEqual([...added].sort());
  });
});
