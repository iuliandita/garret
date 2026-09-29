// The map panel: who appears where, across the whole book.
//
// THE CAST PANEL'S SHAPE, not the synopsis panel's: it reads no navigator
// selection at all, because it is about the BOOK. The rollup is derived here,
// on read, from the walk the page hands in.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test, afterEach } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createAppearancesMap, type AppearancesMap } from "../src/appearances-map";
import type { ItemAppearances } from "../src/appearances";
import type { CastMemberRow } from "../src/cast-panel";
import { TRASH_TYPE } from "../src/item-types";
import type { ProjectItem } from "../src/store/source";

const CAST: CastMemberRow[] = [
  { id: "m-ada", kind: "character", name: "Ada", summary: "", fields: [], aliases: [] },
  { id: "m-bo", kind: "character", name: "Bo", summary: "", fields: [], aliases: [] },
  { id: "m-harbour", kind: "place", name: "The harbour", summary: "", fields: [], aliases: [] },
];

function row(
  id: string,
  parent: string | null,
  depth: number,
  type = "scene",
  title = id,
): ProjectItem {
  return {
    id,
    parent_id: parent,
    type,
    title,
    position: "0000",
    rev: 1,
    state: null,
    depth,
  };
}

/** A part holding a chapter holding two scenes, plus the bin holding a third
 *  scene the writer deleted. */
const BOOK: ProjectItem[] = [
  row("p1", null, 0, "part", "Part One"),
  row("c1", "p1", 1, "chapter", "Chapter One"),
  row("s1", "c1", 2, "scene", "The quay"),
  row("s2", "c1", 2, "scene", "The letter"),
  row("bin", null, 0, TRASH_TYPE, "Trash"),
  row("gone", "bin", 1, "scene", "A cut scene"),
];

interface Rig {
  panel: AppearancesMap;
  container: HTMLElement;
  cast: CastMemberRow[];
  items: ProjectItem[];
  stored: ItemAppearances;
  notices: string[];
  dismissals: number;
  fail: boolean;
}

const rigs: Rig[] = [];

function rig(): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const r: Rig = {
    panel: undefined as unknown as AppearancesMap,
    container,
    cast: [...CAST],
    items: [...BOOK],
    stored: {},
    notices: [],
    dismissals: 0,
    fail: false,
  };
  r.panel = createAppearancesMap({
    container,
    items: () => r.items,
    cast: async () => {
      if (r.fail) throw new Error("could not read");
      return r.cast;
    },
    read: async () => {
      if (r.fail) throw new Error("could not read");
      return r.stored;
    },
    onNotice: (message) => r.notices.push(message),
    onDismiss: () => {
      r.dismissals += 1;
    },
  });
  rigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of rigs) {
    r.panel.destroy();
    r.container.remove();
  }
  rigs.length = 0;
});

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id}`);
  return found as T;
}

const panelEl = (): HTMLElement => el("appears-map-panel");
const rowsEl = (): HTMLElement => el("appears-map-rows");
const painted = (): HTMLElement[] => [
  ...rowsEl().querySelectorAll<HTMLElement>(".appears-map-row"),
];
const rowFor = (id: string): HTMLElement => {
  const found = painted().find((r) => r.dataset.id === id);
  if (found === undefined) throw new Error(`no row for ${id}`);
  return found;
};
const here = (id: string): string =>
  rowFor(id).querySelector(".appears-map-here")?.textContent ?? "";
const below = (id: string): string =>
  rowFor(id).querySelector(".appears-map-below")?.textContent ?? "";
const hereLines = (id: string): string[] =>
  [...rowFor(id).querySelectorAll<HTMLElement>(".appears-map-here")].map((p) => p.textContent ?? "");
const belowLines = (id: string): string[] =>
  [...rowFor(id).querySelectorAll<HTMLElement>(".appears-map-below")].map((p) => p.textContent ?? "");

describe("the rolled-up view", () => {
  test("a scene shows who is tagged on it and a chapter shows the union below", async () => {
    const r = rig();
    r.stored = { s1: ["m-ada"], s2: ["m-bo", "m-ada"] };

    await r.panel.open();

    expect(here("s1")).toBe("Here: Ada");
    expect(below("s1")).toBe("");
    // THE UNION, NOT THE SUM: Ada is in both scenes and appears once.
    expect(below("c1")).toBe("Further down: Ada, Bo");
    expect(here("c1")).toBe("");
    expect(below("p1")).toBe("Further down: Ada, Bo");
  });

  test("a row tagged DIRECTLY is told apart from what came from below", async () => {
    // The decision this panel exists to make legible. A direct tag stays when
    // the scenes move; a derived one does not, and a writer who could not tell
    // them apart would have no way to explain why a name is on a chapter.
    const r = rig();
    r.stored = { c1: ["m-harbour"], s1: ["m-ada"] };

    await r.panel.open();

    expect(here("c1")).toBe("Here: The harbour");
    expect(below("c1")).toBe("Further down: Ada");
  });

  test("a name that is BOTH direct and from below is said once, as direct", async () => {
    // The two lists are disjoint by construction. Saying Ada twice would read
    // as two different claims about one name.
    const r = rig();
    r.stored = { c1: ["m-ada"], s1: ["m-ada"] };

    await r.panel.open();

    expect(here("c1")).toBe("Here: Ada");
    expect(below("c1")).toBe("");
  });

  test("THE BIN IS NOT THE BOOK", async () => {
    // The defect the design record predicted. `refreshCounts` rolls up the RAW
    // walk because the navigator paints the bin's rows too; this panel is the
    // other kind and must not.
    const r = rig();
    r.stored = { gone: ["m-ada"], s1: ["m-bo"] };

    await r.panel.open();

    expect(painted().map((row) => row.dataset.id)).toEqual(["p1", "c1", "s1"]);
    expect(below("c1")).toBe("Further down: Bo");
  });

  test("a `trash`-typed row a writer nested in a live chapter is a ROW, not the bin", async () => {
    // Keying on the TYPE rather than on the ROOT drops the writer's own work
    // out of their book on the strength of one hand-moved item.
    const r = rig();
    r.items = [
      row("c1", null, 0, "chapter", "Chapter One"),
      row("decoy", "c1", 1, TRASH_TYPE, "Trash"),
    ];
    r.stored = { decoy: ["m-ada"] };

    await r.panel.open();

    expect(painted().map((row) => row.dataset.id)).toEqual(["c1", "decoy"]);
    expect(here("decoy")).toBe("Here: Ada");
  });

  test("only rows somebody appears in are listed", async () => {
    // The panel answers "who appears where", and a scene nobody has been placed
    // in has no answer to give. Printing every row of a manuscript would bury
    // the ones that do.
    const r = rig();
    r.stored = { s2: ["m-ada"] };

    await r.panel.open();

    expect(painted().map((row) => row.dataset.id)).toEqual(["p1", "c1", "s2"]);
  });

  test("a row carries the walk's own depth as an indent, capped", async () => {
    const r = rig();
    r.stored = { s1: ["m-ada"] };

    await r.panel.open();

    expect(rowFor("p1").dataset.indent).toBe("0");
    expect(rowFor("c1").dataset.indent).toBe("1");
    expect(rowFor("s1").dataset.indent).toBe("2");
  });

  test("the indent is CAPPED at six, because the stylesheet stops there", async () => {
    // FOUND BY MUTATION. `style.css` defines `.appears-map-row[data-indent]`
    // for 1..6 and nothing past it, so an uncapped depth of nine paints a row
    // at NO indent at all -- flat, in the middle of a nested list, which reads
    // as the row belonging to the wrong parent. The navigator caps at the same
    // number for the same reason.
    const r = rig();
    r.items = [
      row("d0", null, 0, "part", "Part"),
      row("d1", "d0", 1, "chapter", "Chapter"),
      row("d2", "d1", 2, "part", "Part"),
      row("d3", "d2", 3, "chapter", "Chapter"),
      row("d4", "d3", 4, "part", "Part"),
      row("d5", "d4", 5, "chapter", "Chapter"),
      row("d6", "d5", 6, "part", "Part"),
      row("deep", "d6", 7, "scene", "Deep"),
    ];
    r.stored = { deep: ["m-ada"] };

    await r.panel.open();

    expect(rowFor("d6").dataset.indent).toBe("6");
    expect(rowFor("deep").dataset.indent).toBe("6");
  });

  test("a row with two kinds in ONE bucket gets ONE LINE PER KIND, not one dump", async () => {
    // Ada (a character) and The harbour (a place) tagged
    // directly on the same row used to read as one undifferentiated line.
    const r = rig();
    r.stored = { c1: ["m-ada", "m-harbour"] };

    await r.panel.open();

    // THE VISIBLE LABEL IS SAID ONCE, on the first line only --
    // a second "Here:" naming the harbour alone would read as a
    // separate claim about the row rather than a continuation of the first.
    const lines = hereLines("c1");
    expect(lines).toEqual(["Here: Ada", "The harbour"]);
    // CHARACTER BEFORE PLACE, `CAST_KINDS`'s own order -- the same order the
    // cast panel and the tagging panel already group by.
    const els = [...rowFor("c1").querySelectorAll<HTMLElement>(".appears-map-here")];
    expect(els.map((p) => p.dataset.kind)).toEqual(["character", "place"]);
    expect(els[0]?.dataset.continued).toBeUndefined();
    expect(els[1]?.dataset.continued).toBe("true");
    // THE FULL SET OF NAMES ACROSS BOTH LINES is the property this panel
    // actually promises -- which line carries the visible label is paint,
    // not the claim.
    const names = new Set(lines.flatMap((line) => line.replace(/^Here: /, "").split(", ")));
    expect(names).toEqual(new Set(["Ada", "The harbour"]));
    // EVERY LINE'S OWN ACCESSIBLE NAME says its own kind and bucket
    // regardless of which one carries the visible label -- a screen reader
    // has no indentation to infer the omitted label from.
    expect(els.map((p) => p.getAttribute("aria-label"))).toEqual([
      "Characters here: Ada",
      "Places here: The harbour",
    ]);
  });

  test("each kind line carries its own glyph, hidden from the accessible text", async () => {
    const r = rig();
    r.stored = { s1: ["m-ada"] };

    await r.panel.open();

    const line = rowFor("s1").querySelector<HTMLElement>(".appears-map-here");
    expect(line).not.toBeNull();
    const icon = line?.querySelector(".appears-map-line-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.querySelector("svg")).not.toBeNull();
    // The glyph contributes no text of its own: the visible sentence is
    // unchanged, and the kind is still said once, in the aria-label.
    expect(line?.textContent).toBe("Here: Ada");
    expect(line?.getAttribute("aria-label")).toBe("Characters here: Ada");
  });

  test("Further down splits by kind exactly like Here", async () => {
    const r = rig();
    r.stored = { c1: ["m-ada", "m-harbour"], s1: ["m-ada", "m-harbour"] };

    await r.panel.open();

    const lines = belowLines("p1");
    expect(lines).toEqual(["Further down: Ada", "The harbour"]);
    const els = [...rowFor("p1").querySelectorAll<HTMLElement>(".appears-map-below")];
    expect(els.map((p) => p.getAttribute("aria-label"))).toEqual([
      "Characters further down: Ada",
      "Places further down: The harbour",
    ]);
  });

  test("names within one kind sort by the writer's locale, not by code unit", async () => {
    // a plain `.sort()` orders by UTF-16 code unit,
    // which puts every capital before every lowercase letter -- "Zoe, ana"
    // rather than the alphabetical "ana, Zoe" a writer actually reads.
    const r = rig();
    r.cast = [
      ...CAST,
      { id: "m-ana", kind: "character", name: "ana", summary: "", fields: [], aliases: [] },
      { id: "m-zoe", kind: "character", name: "Zoe", summary: "", fields: [], aliases: [] },
    ];
    r.stored = { c1: ["m-ana", "m-zoe"] };

    await r.panel.open();

    expect(here("c1")).toBe("Here: ana, Zoe");
  });

  test("a member the cast list does not name is DROPPED, never printed as an id", async () => {
    // Reachable when the two reads disagree -- a member deleted between them.
    // An id is not a description of anybody, and a row naming one would send a
    // writer looking for a character called `01a046f9-...`.
    const r = rig();
    r.stored = { s1: ["m-ada", "m-vanished"] };

    await r.panel.open();

    expect(here("s1")).toBe("Here: Ada");
    expect(rowsEl().textContent).not.toContain("m-vanished");
  });
});

describe("the two empty states are two different sentences", () => {
  test("a book with NO cast is sent to the cast panel", async () => {
    const r = rig();
    r.cast = [];
    r.stored = {};

    await r.panel.open();

    expect(painted()).toHaveLength(0);
    const said = rowsEl().textContent ?? "";
    expect(said).toContain("Cast");
    expect(said).not.toContain("Who appears here");
    // AND THE READING LINE IS GONE. It used to be cleared after the row loop,
    // which this branch returns before reaching, so the panel said "Reading the
    // book..." above a sentence saying the book has nobody in it. Found by
    // capture.
    expect(document.getElementById("appears-map-status")?.textContent).toBe("");
  });

  test("a book WITH a cast and nobody placed is sent to the tagging panel", async () => {
    // A DIFFERENT ANSWER, not a fallback: the route out of this state is the
    // other panel, and one sentence for both states sends a writer to the wrong
    // surface in one case out of two.
    const r = rig();
    r.stored = {};

    await r.panel.open();

    expect(painted()).toHaveLength(0);
    expect(rowsEl().textContent).toContain("Who appears here");
    expect(document.getElementById("appears-map-status")?.textContent).toBe("");
  });

  test("a read that fails is NEITHER empty state", async () => {
    // The recorded `renderImports([])` defect: a store this panel could not
    // read must not be reported as a book nobody has been placed in.
    const r = rig();
    r.fail = true;

    await r.panel.open();

    expect(r.notices).toHaveLength(1);
    expect(rowsEl().textContent).toBe("");
  });
});

describe("the walk is read at OPEN, never held", () => {
  test("an outline edited while the panel was closed is the one it shows next", async () => {
    const r = rig();
    r.stored = { s1: ["m-ada"] };
    await r.panel.open();
    expect(painted().map((row) => row.dataset.id)).toEqual(["p1", "c1", "s1"]);
    r.panel.close();

    // The writer binned the chapter.
    r.items = [
      row("p1", null, 0, "part", "Part One"),
      row("bin", null, 0, TRASH_TYPE, "Trash"),
      row("c1", "bin", 1, "chapter", "Chapter One"),
      row("s1", "c1", 2, "scene", "The quay"),
    ];
    await r.panel.open();

    expect(painted()).toHaveLength(0);
    // And nothing was written to say so: the rollup is DERIVED, so a binned
    // scene leaves the book by the walk alone.
    expect(r.stored).toEqual({ s1: ["m-ada"] });
  });
});

describe("dismissal", () => {
  test("Escape closes and hands focus back", async () => {
    const r = rig();
    await r.panel.open();

    panelEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(r.panel.isOpen()).toBe(false);
    expect(r.dismissals).toBe(1);
  });

  test("a click outside leaves it open and does NOT move focus", async () => {
    // the inspector. Clicking the prose beside it is the point, so an
    // outside click leaves it open, exactly as it leaves the preview rail.
    const r = rig();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await r.panel.open();

      outside.click();

      expect(r.panel.isOpen()).toBe(true);
      expect(r.dismissals).toBe(0);
    } finally {
      outside.remove();
    }
  });

  test("an answer arriving after a close does not repaint a dismissed panel", async () => {
    const r = rig();
    r.stored = { s1: ["m-ada"] };
    const opening = r.panel.open();
    r.panel.close();
    await opening;

    expect(r.panel.isOpen()).toBe(false);
    expect(painted()).toHaveLength(0);
  });

  test("destroy takes the panel out of the document", async () => {
    const r = rig();
    await r.panel.open();

    r.panel.destroy();

    expect(document.getElementById("appears-map-panel")).toBe(null);
  });
});

describe("by member", () => {
  test("each cast member lists the rows they are tagged on directly, in walk order", async () => {
    const r = rig();
    r.stored = { s2: ["m-ada"], c1: ["m-ada"], s1: ["m-harbour"] };
    await r.panel.open();
    const lines = [...document.querySelectorAll<HTMLElement>(".appears-map-member")];
    expect(lines.map((p) => p.dataset.memberId)).toEqual(
      [...CAST].sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.id),
    );
    const ada = lines.find((p) => p.dataset.memberId === "m-ada")!;
    // Direct tags only, in the walk's order: the chapter before its scene, and
    // no derived presence on Part One.
    expect(ada.textContent).toBe("Ada: Chapter One, The letter");
  });

  test("a member placed nowhere says so instead of being left off", async () => {
    const r = rig();
    r.stored = { s1: ["m-harbour"] };
    await r.panel.open();
    const ada = document.querySelector<HTMLElement>('.appears-map-member[data-member-id="m-ada"]');
    expect(ada?.textContent).toContain("no appearances in this map");
  });

  test("a tag on a binned scene does not place anybody", async () => {
    const r = rig();
    r.stored = { gone: ["m-ada"], s1: ["m-harbour"] };
    await r.panel.open();
    const ada = document.querySelector<HTMLElement>('.appears-map-member[data-member-id="m-ada"]');
    expect(ada?.textContent).toContain("no appearances in this map");
  });

  test("no by-member list under the nobody-placed state", async () => {
    const r = rig();
    r.stored = {};
    await r.panel.open();
    expect(document.querySelector(".appears-map-member")).toBeNull();
    expect(document.querySelector(".appears-map-empty")).not.toBeNull();
  });
});
