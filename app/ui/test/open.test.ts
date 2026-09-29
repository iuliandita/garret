import { describe, expect, test } from "bun:test";
import { createDocumentOpener, type OpenerDeps } from "../src/open";
import type { SwitchOutcome } from "../src/session";

interface Rig {
  log: string[];
  deps: OpenerDeps;
  outcome: { value: SwitchOutcome };
}

const TYPES: Record<string, string> = {
  "scene-a": "scene",
  "chap-1": "chapter",
  "part-1": "part",
  "loose-1": "doc",
  "note-1": "note",
  "matter-1": "matter",
  "timeline-1": "timeline",
};

function rig(): Rig {
  const log: string[] = [];
  const outcome: Rig["outcome"] = { value: "switched" };
  const deps: OpenerDeps = {
    session: {
      switchTo: async (itemId: string) => {
        log.push(`switchTo:${itemId}`);
        return outcome.value;
      },
    },
    typeOf: (itemId: string) => TYPES[itemId],
    markOpen: (itemId: string) => log.push(`markOpen:${itemId}`),
    focusEditor: () => log.push("focusEditor"),
    onFailure: (message: string) => log.push(`onFailure:${message}`),
  };
  return { log, deps, outcome };
}

describe("createDocumentOpener", () => {
  test("opens a scene, marks it and moves the caret into the prose", async () => {
    const r = rig();
    await createDocumentOpener(r.deps)("scene-a");
    expect(r.log).toEqual(["switchTo:scene-a", "markOpen:scene-a", "focusEditor"]);
  });

  for (const [id, kind] of [
    ["chap-1", "chapter"],
    ["part-1", "part"],
    ["loose-1", "doc"],
  ]) {
    test(`a ${kind} is selectable but not openable`, async () => {
      // Only scenes carry a doc row (the store's item_create writes one for
      // scenes and nothing else), so opening a chapter would ask the store for
      // a document that does not exist.
      const r = rig();
      await createDocumentOpener(r.deps)(id!);
      expect(r.log).toEqual([]);
    });
  }

  test("a bible document opens exactly as a scene does", async () => {
    // A note carries a `doc` row -- the store writes one for a scene and for a
    // note and for nothing else -- so it is prose in every way except what it
    // counts toward. A page that kept "only a scene is openable" would ship a
    // section a writer can see, select and rename and cannot write in.
    const r = rig();
    await createDocumentOpener(r.deps)("note-1");
    expect(r.log).toEqual(["switchTo:note-1", "markOpen:note-1", "focusEditor"]);
  });

  test("a matter document opens exactly as a scene does", async () => {
    // A dedication carries a `doc` row and IS part of the book. A page that
    // kept the list at two types would ship four menu items that make a page a
    // writer can see, select and rename and cannot write in -- which is the
    // defect this list's shape was widened for once already.
    const r = rig();
    await createDocumentOpener(r.deps)("matter-1");
    expect(r.log).toEqual(["switchTo:matter-1", "markOpen:matter-1", "focusEditor"]);
  });

  test("a timeline opens exactly as a scene does", async () => {
    // This type was special-cased here, before session.ts had anywhere to
    // send one; session.ts later learned a second document kind
    // (isTimelineDoc/onTimelineDoc) and this unit no longer treats a
    // timeline as different from any other openable type at all.
    const r = rig();
    await createDocumentOpener(r.deps)("timeline-1");
    expect(r.log).toEqual(["switchTo:timeline-1", "markOpen:timeline-1", "focusEditor"]);
  });

  test("an id in no walk at all is reported, not swallowed", async () => {
    // A miss and "this is not a scene" are different things. A part returning
    // silently is the design; an id nothing knows about is a page bug, and a
    // page bug that presents as "nothing happened" is invisible for the life of
    // the window.
    const r = rig();
    await createDocumentOpener(r.deps)("nope");
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toStartWith("onFailure:");
    expect(r.log[0]).toContain("nope");
  });

  test("clicking the already-open scene still returns the caret to the prose", async () => {
    const r = rig();
    r.outcome.value = "same";
    await createDocumentOpener(r.deps)("scene-a");
    expect(r.log).toEqual(["switchTo:scene-a", "focusEditor"]);
  });

  test("a busy switch is silent", async () => {
    const r = rig();
    r.outcome.value = "busy";
    await createDocumentOpener(r.deps)("scene-a");
    expect(r.log).toEqual(["switchTo:scene-a"]);
  });

  test("a failed switch names the item AND carries the reason", async () => {
    const r = rig();
    r.outcome.value = { kind: "failed", reason: "the store rejected the load" };
    await createDocumentOpener(r.deps)("scene-a");
    expect(r.log[1]).toStartWith("onFailure:");
    expect(r.log[1]).toContain("scene-a");
    // The cause, not just which item failed - a switch that fails for two
    // different reasons must not look identical to a reader of the banner.
    expect(r.log[1]).toContain("the store rejected the load");
  });
});
