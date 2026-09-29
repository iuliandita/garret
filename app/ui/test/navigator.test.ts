import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

// The index arithmetic needs no DOM; the tree rendering, the ARIA contract and
// the collapse behaviour do.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, nextIndex, typeAheadIndex } from "../src/navigator/index";

const COUNT = 15_200;
const PAGE = 10;

function treeSource() {
  const items = [
    { id: "p-1", parent_id: null, type: "part", title: "Part One", position: "0000", rev: 1, state: null, depth: 0 },
    { id: "c-1", parent_id: "p-1", type: "chapter", title: "Ch A", position: "0000", rev: 1, state: null, depth: 1 },
    { id: "s-1", parent_id: "c-1", type: "scene", title: "Sc 1", position: "0000", rev: 1, state: null, depth: 2 },
    { id: "c-2", parent_id: "p-1", type: "chapter", title: "Ch B", position: "0010", rev: 1, state: null, depth: 1 },
  ];
  return {
    items,
    count: items.length,
    seed: "nested-v1",
    titleAt: (i: number) => items[i]!.title,
    idAt: (i: number) => items[i]!.id,
    depthAt: (i: number) => items[i]!.depth,
  };
}

// Four levels under one root plus a second root, so a collapse slides a DEPTH-0
// row into a visible index that a DEPTH-2 row occupied. That is the virtual
// list's element-recycling case: the same DOM node is repainted for a row three
// levels shallower than the one it last held.
function deepSource() {
  const items = [
    { id: "p-1", parent_id: null, title: "Part One", depth: 0 },
    { id: "c-1", parent_id: "p-1", title: "Ch A", depth: 1 },
    { id: "s-1", parent_id: "c-1", title: "Sc 1", depth: 2 },
    { id: "b-1", parent_id: "s-1", title: "Beat 1", depth: 3 },
    { id: "p-2", parent_id: null, title: "Part Two", depth: 0 },
  ];
  return {
    items,
    count: items.length,
    seed: "deep-v1",
    titleAt: (i: number) => items[i]!.title,
    idAt: (i: number) => items[i]!.id,
    depthAt: (i: number) => items[i]!.depth,
  };
}

// A chain 20 deep, to exercise the cap. Nothing in the product forbids it: the
// hierarchy is arbitrary by product-spec decision, so a depth the pane cannot
// express is reachable and has to render as something.
function chainSource(length = 21) {
  const items = Array.from({ length }, (_, i) => ({
    id: `n-${i}`,
    parent_id: i === 0 ? null : `n-${i - 1}`,
    title: `Node ${i}`,
    depth: i,
  }));
  return {
    items,
    count: items.length,
    seed: "chain-v1",
    titleAt: (i: number) => items[i]!.title,
    idAt: (i: number) => items[i]!.id,
    depthAt: (i: number) => items[i]!.depth,
  };
}

// Two branches under one part, so a collapse can leave a leaf standing at an
// index that previously held a branch -- the repaint case that would otherwise
// keep a stale aria-expanded.
function twoBranchSource() {
  const items = [
    { id: "p-1", parent_id: null, title: "Part One", depth: 0 },
    { id: "c-1", parent_id: "p-1", title: "Ch A", depth: 1 },
    { id: "s-1", parent_id: "c-1", title: "Sc 1", depth: 2 },
    { id: "c-2", parent_id: "p-1", title: "Ch B", depth: 1 },
    { id: "s-2", parent_id: "c-2", title: "Sc 2", depth: 2 },
  ];
  return {
    items,
    count: items.length,
    seed: "two-branch-v1",
    titleAt: (i: number) => items[i]!.title,
    idAt: (i: number) => items[i]!.id,
    depthAt: (i: number) => items[i]!.depth,
  };
}

// The corpus path: no depths, no parentage. Every prior graded run is
// reproduced through this shape, so it has to keep working unchanged.
function corpusSource(count = 4) {
  return {
    count,
    seed: "corpus-v1",
    titleAt: (i: number) => `Scene ${i}`,
    idAt: (i: number) => `sc-${i}`,
  };
}

function makeContainer(clientHeight = 400): HTMLElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  document.body.append(container);
  return container;
}

const titlesIn = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll("[role='treeitem']")].map((r) => r.textContent);

describe("nextIndex", () => {
  test("ArrowDown advances by one", () => {
    expect(nextIndex("ArrowDown", 5, COUNT, PAGE)).toBe(6);
  });

  test("ArrowUp retreats by one", () => {
    expect(nextIndex("ArrowUp", 5, COUNT, PAGE)).toBe(4);
  });

  test("ArrowUp at the first row stays put rather than wrapping", () => {
    expect(nextIndex("ArrowUp", 0, COUNT, PAGE)).toBe(0);
  });

  test("ArrowDown at the last row stays put rather than wrapping", () => {
    expect(nextIndex("ArrowDown", COUNT - 1, COUNT, PAGE)).toBe(COUNT - 1);
  });

  test("PageDown advances by a page and clamps at the end", () => {
    expect(nextIndex("PageDown", 0, COUNT, PAGE)).toBe(PAGE);
    expect(nextIndex("PageDown", COUNT - 3, COUNT, PAGE)).toBe(COUNT - 1);
  });

  test("PageUp retreats by a page and clamps at the start", () => {
    expect(nextIndex("PageUp", 3, COUNT, PAGE)).toBe(0);
  });

  test("Home and End reach the true first and last row", () => {
    expect(nextIndex("Home", 900, COUNT, PAGE)).toBe(0);
    expect(nextIndex("End", 900, COUNT, PAGE)).toBe(COUNT - 1);
  });

  test("an unhandled key returns the current index unchanged", () => {
    expect(nextIndex("F5", 42, COUNT, PAGE)).toBe(42);
  });
});

describe("typeAheadIndex", () => {
  const titles = ["Alpha", "Bravo", "Bravado", "Charlie"];
  const titleAt = (i: number): string => titles[i]!;

  test("matches the first row with the prefix, searching from the top", () => {
    expect(typeAheadIndex("br", 0, titles.length, titleAt)).toBe(1);
  });

  test("is case-insensitive", () => {
    expect(typeAheadIndex("BR", 0, titles.length, titleAt)).toBe(1);
  });

  test("wraps past the current position to find a later match first", () => {
    expect(typeAheadIndex("b", 1, titles.length, titleAt)).toBe(2);
  });

  test("wraps around the end back to the start", () => {
    expect(typeAheadIndex("a", 3, titles.length, titleAt)).toBe(0);
  });

  test("no match leaves the index where it was", () => {
    expect(typeAheadIndex("zz", 2, titles.length, titleAt)).toBe(2);
  });
});

describe("createNavigator as a tree", () => {
  test("rows are treeitems with per-group ARIA and level", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.append(container);

    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    expect(container.getAttribute("role")).toBe("tree");
    const rows = [...container.querySelectorAll("[role='treeitem']")];
    expect(rows.length).toBeGreaterThan(0);

    const byText = (t: string) => rows.find((r) => r.textContent === t)!;
    expect(byText("Ch A").getAttribute("aria-level")).toBe("2");
    expect(byText("Sc 1").getAttribute("aria-level")).toBe("3");
    expect(byText("Ch A").getAttribute("aria-setsize")).toBe("2");
    expect(byText("Sc 1").hasAttribute("aria-expanded")).toBe(false);
    expect(byText("Ch A").getAttribute("aria-expanded")).toBe("true");

    nav.destroy();
    container.remove();
  });

  test("ArrowLeft collapses a branch and removes its descendants from the tree", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.append(container);
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    nav.handleKey("ArrowDown"); // p-1 -> c-1
    nav.handleKey("ArrowLeft"); // collapse c-1
    const titles = [...container.querySelectorAll("[role='treeitem']")].map((r) => r.textContent);
    expect(titles).not.toContain("Sc 1");
    expect(titles).toContain("Ch B");

    nav.handleKey("ArrowRight"); // expand again
    const after = [...container.querySelectorAll("[role='treeitem']")].map((r) => r.textContent);
    expect(after).toContain("Sc 1");

    nav.destroy();
    container.remove();
  });

  test("ArrowDown skips rows hidden by a collapsed ancestor", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.append(container);
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    nav.handleKey("ArrowDown"); // c-1
    nav.handleKey("ArrowLeft"); // collapse c-1
    nav.handleKey("ArrowDown"); // must land on Ch B, not the hidden Sc 1
    expect(nav.activeTitle()).toBe("Ch B");

    nav.destroy();
    container.remove();
  });

  test("aria-activedescendant names a row that is in the DOM, before and after a collapse", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    const active = (): HTMLElement | null =>
      container.querySelector(`#${container.getAttribute("aria-activedescendant")}`);
    expect(active()?.textContent).toBe("Part One");

    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowLeft");
    expect(active()?.textContent).toBe("Ch A");

    nav.destroy();
    container.remove();
  });

  test("a row's element id names the item, not its position, so a collapse does not reassign it", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });
    const idOf = (t: string): string =>
      [...container.querySelectorAll("[role='treeitem']")].find((r) => r.textContent === t)!.id;

    const before = idOf("Ch B"); // visible index 3
    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowLeft"); // collapse c-1: Ch B shifts to visible index 2
    expect(idOf("Ch B")).toBe(before);

    nav.destroy();
    container.remove();
  });

  test("a repaint clears aria-expanded when an index stops being a branch", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: twoBranchSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });
    const rowAt = (i: number): Element => [...container.querySelectorAll("[role='treeitem']")][i]!;

    expect(rowAt(3).textContent).toBe("Ch B");
    expect(rowAt(3).getAttribute("aria-expanded")).toBe("true");

    nav.handleKey("ArrowDown"); // Ch A
    nav.handleKey("ArrowLeft"); // collapse Ch A: Sc 2 slides into index 3
    expect(rowAt(3).textContent).toBe("Sc 2");
    expect(rowAt(3).hasAttribute("aria-expanded")).toBe(false);

    nav.destroy();
    container.remove();
  });

  test("ArrowRight on an expanded branch moves to its first child; a leaf is inert", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    nav.handleKey("ArrowRight"); // p-1 is expanded -> first child
    expect(nav.activeTitle()).toBe("Ch A");
    nav.handleKey("ArrowRight"); // c-1 expanded -> Sc 1
    expect(nav.activeTitle()).toBe("Sc 1");
    nav.handleKey("ArrowRight"); // leaf: nothing to open, nothing to enter
    expect(nav.activeTitle()).toBe("Sc 1");

    nav.destroy();
    container.remove();
  });

  test("ArrowLeft on a leaf moves to its parent", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    nav.handleKey("End");
    nav.handleKey("ArrowUp"); // Sc 1 is not last; walk to it explicitly
    while (nav.activeTitle() !== "Sc 1") nav.handleKey("ArrowUp");
    nav.handleKey("ArrowLeft");
    expect(nav.activeTitle()).toBe("Ch A");
    nav.handleKey("ArrowLeft"); // Ch A is an expanded branch: collapses
    expect(nav.activeTitle()).toBe("Ch A");
    expect(titlesIn(container)).not.toContain("Sc 1");
    nav.handleKey("ArrowLeft"); // collapsed branch: up to the part
    expect(nav.activeTitle()).toBe("Part One");

    nav.destroy();
    container.remove();
  });

  test("a corpus source with no tree renders one flat level with the full set size", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: corpusSource(4), rowHeight: 20, overscan: 2, mode: "virtual",
    });

    const rows = [...container.querySelectorAll("[role='treeitem']")];
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.textContent)).toEqual(["Scene 0", "Scene 1", "Scene 2", "Scene 3"]);
    for (const [i, r] of rows.entries()) {
      expect(r.getAttribute("aria-level")).toBe("1");
      expect(r.getAttribute("aria-setsize")).toBe("4");
      expect(r.getAttribute("aria-posinset")).toBe(String(i + 1));
      expect(r.hasAttribute("aria-expanded")).toBe(false);
    }
    expect(nav.rows().length).toBe(4);

    nav.destroy();
    container.remove();
  });

  // Indentation. These assert the data-indent ATTRIBUTE, which is the exact
  // thing style.css keys its padding-left rules on, and NOT computed geometry:
  // happy-dom does no layout and loads no stylesheet, so every getComputedStyle
  // assertion here would report the initial value and pass for any
  // implementation, including none. The geometric claims -- unchanged row
  // height, no wrapping at any depth -- are measured in a real browser and
  // recorded in the slice write-up; they are deliberately not faked here.
  test("a row's indent comes from the walk's depth", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: deepSource(), rowHeight: 20, overscan: 4, mode: "virtual",
    });
    const indentOf = (t: string): string | undefined =>
      ([...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement).dataset.indent;

    expect(indentOf("Part One")).toBe("0");
    expect(indentOf("Ch A")).toBe("1");
    expect(indentOf("Sc 1")).toBe("2");
    expect(indentOf("Beat 1")).toBe("3");
    expect(indentOf("Part Two")).toBe("0");

    nav.destroy();
    container.remove();
  });

  test("the indent is capped at 6 while aria-level keeps telling the truth", () => {
    const container = makeContainer(2000);
    const nav = createNavigator({
      container, source: chainSource(21), rowHeight: 20, overscan: 4, mode: "virtual",
    });
    const rowOf = (t: string): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;

    expect(rowOf("Node 6").dataset.indent).toBe("6");
    expect(rowOf("Node 7").dataset.indent).toBe("6");
    expect(rowOf("Node 20").dataset.indent).toBe("6");
    // The cap is a rendering limit and must not reach the semantics: a screen
    // reader still hears depth 21.
    expect(rowOf("Node 20").getAttribute("aria-level")).toBe("21");

    nav.destroy();
    container.remove();
  });

  // The classic virtual-list defect: an element painted once at creation keeps
  // its first row's indent forever. Every mounted row here is reused across the
  // collapse, so an indent written only on mount survives onto a row three
  // levels shallower.
  test("a recycled row element loses the indent of the row it used to hold", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: deepSource(), rowHeight: 20, overscan: 4, mode: "virtual",
    });
    const elementAt = (i: number): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")][i] as HTMLElement;

    const recycled = elementAt(2);
    expect(recycled.textContent).toBe("Sc 1");
    expect(recycled.dataset.indent).toBe("2");

    nav.handleKey("ArrowDown"); // Ch A
    nav.handleKey("ArrowLeft"); // collapse Ch A: Part Two slides into index 2

    const after = elementAt(2);
    // Element identity is the whole point: if the list unmounted and remounted
    // instead of repainting, this test would pass without touching the defect.
    expect(after).toBe(recycled);
    expect(after.textContent).toBe("Part Two");
    expect(after.dataset.indent).toBe("0");

    nav.destroy();
    container.remove();
  });

  // Item type. Asserted as the data-type ATTRIBUTE for exactly the reason the
  // indent block above gives: happy-dom loads no stylesheet, so an assertion on
  // computed weight or letter-spacing would pass for any implementation.
  //
  // "Deep Part" is a PART AT DEPTH 3, nested inside a scene, and it is the whole
  // reason this fixture is not just deepSource with types bolted on.
  //
  // The obvious tree - part at 0, chapter at 1, scene at 2 - cannot distinguish
  // a type-driven implementation from a depth-driven one, because every type
  // agrees with its level. A first version of this fixture was exactly that, and
  // a mutation replacing the store's type with `depth === 0 ? "part" : ...`
  // survived the test that claims to catch it. One row whose type disagrees with
  // its depth kills it.
  //
  // It is also legal rather than contrived: the product spec makes the hierarchy
  // arbitrary and forbids type-based parent constraints, so a part inside a
  // scene is something a writer can actually make, and the outline has to render
  // it honestly.
  function typedSource() {
    const items = [
      { id: "p-1", parent_id: null, title: "Part One", depth: 0, type: "part" },
      { id: "c-1", parent_id: "p-1", title: "Ch A", depth: 1, type: "chapter" },
      { id: "s-1", parent_id: "c-1", title: "Sc 1", depth: 2, type: "scene" },
      { id: "b-1", parent_id: "s-1", title: "Deep Part", depth: 3, type: "part" },
      { id: "p-2", parent_id: null, title: "Part Two", depth: 0, type: "part" },
    ];
    return {
      items,
      count: items.length,
      seed: "typed-v1",
      titleAt: (i: number) => items[i]!.title,
      idAt: (i: number) => items[i]!.id,
      depthAt: (i: number) => items[i]!.depth,
      typeAt: (i: number) => items[i]!.type,
    };
  }

  test("a row's type comes from the source, not from its depth", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: typedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });
    const typeOf = (t: string): string | undefined =>
      ([...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement).dataset.type;

    expect(typeOf("Part One")).toBe("part");
    expect(typeOf("Ch A")).toBe("chapter");
    expect(typeOf("Sc 1")).toBe("scene");
    // The load-bearing one: depth 3, inside a scene, and still a part. An
    // implementation reading depth instead of the store answers "scene" here.
    expect(typeOf("Deep Part")).toBe("part");
    expect(typeOf("Part Two")).toBe("part");

    nav.destroy();
    container.remove();
  });

  test("a recycled row element loses the type of the row it used to hold", () => {
    // The same defect the indent recycling test covers, on the attribute added
    // by the visual redesign. A type written only on mount leaves a row that
    // once held a scene set in a part's spaced capitals for the rest of the
    // session - and every ARIA assertion in this file would still pass.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: typedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });
    const elementAt = (i: number): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")][i] as HTMLElement;

    const recycled = elementAt(2);
    expect(recycled.textContent).toBe("Sc 1");
    expect(recycled.dataset.type).toBe("scene");

    nav.handleKey("ArrowDown"); // Ch A
    nav.handleKey("ArrowLeft"); // collapse Ch A: Part Two slides into index 2

    const after = elementAt(2);
    // Element identity, exactly as in the indent test: a list that unmounted and
    // remounted would pass this without ever touching the defect.
    expect(after).toBe(recycled);
    expect(after.textContent).toBe("Part Two");
    expect(after.dataset.type).toBe("part");

    nav.destroy();
    container.remove();
  });

  test("a reload to a source with no types clears the attribute", () => {
    // What makes the delete branch in `paint` reachable rather than decorative.
    // `typeAt` is optional on TreeSource because a corpus source has no tree and
    // no types, and `reload` accepts ANY TreeSource - so a navigator mounted on
    // the store can be handed a typeless source. Leaving the old attribute
    // standing would set rows in capitals on the strength of a walk that no
    // longer exists.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: typedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });
    const rows = (): HTMLElement[] =>
      [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];

    expect(rows()[0]!.dataset.type).toBe("part");

    const typed = typedSource();
    nav.reload({
      count: typed.count,
      seed: typed.seed,
      titleAt: typed.titleAt,
      idAt: typed.idAt,
      depthAt: typed.depthAt,
      items: typed.items,
    });

    for (const row of rows()) expect(row.dataset.type).toBeUndefined();

    nav.destroy();
    container.remove();
  });

  // 095, W1: the world's glyphs and the separator. A fixture with every kind
  // this table treats differently -- a manuscript row, a note, and all four
  // reserved roots -- in an order where the first RESERVED root ("front") is
  // NOT the first of the four in title order, so a naive implementation that
  // reached for "the first bible/trash/front/back node" rather than "the
  // first one this table calls reserved" cannot pass by accident.
  function worldSource() {
    const items = [
      { id: "p-1", parent_id: null, title: "Part One", depth: 0, type: "part" },
      { id: "c-1", parent_id: "p-1", title: "Ch A", depth: 1, type: "chapter" },
      { id: "s-1", parent_id: "c-1", title: "Sc 1", depth: 2, type: "scene" },
      { id: "front-1", parent_id: null, title: "Front Matter", depth: 0, type: "front" },
      { id: "matter-1", parent_id: "front-1", title: "Dedication", depth: 1, type: "matter" },
      { id: "bible-1", parent_id: null, title: "The Bible", depth: 0, type: "bible" },
      { id: "note-1", parent_id: "bible-1", title: "A Note", depth: 1, type: "note" },
      { id: "back-1", parent_id: null, title: "Back Matter", depth: 0, type: "back" },
      { id: "trash-1", parent_id: null, title: "Trash", depth: 0, type: "trash" },
    ];
    return {
      items,
      count: items.length,
      seed: "world-v1",
      titleAt: (i: number) => items[i]!.title,
      idAt: (i: number) => items[i]!.id,
      depthAt: (i: number) => items[i]!.depth,
      typeAt: (i: number) => items[i]!.type,
    };
  }

  test("a reserved root and a note paint a glyph; a manuscript row paints none", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rowNamed = (t: string): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;
    const iconOf = (t: string): SVGElement | null => rowNamed(t).querySelector(".nav-icon svg");

    expect(iconOf("Part One")).toBeNull();
    expect(iconOf("Ch A")).toBeNull();
    expect(iconOf("Sc 1")).toBeNull();
    // A matter document keeps the paper's ink and gets no glyph either -- only
    // its section header does.
    expect(iconOf("Dedication")).toBeNull();
    expect(iconOf("Front Matter")).not.toBeNull();
    expect(iconOf("The Bible")).not.toBeNull();
    expect(iconOf("A Note")).not.toBeNull();
    expect(iconOf("Back Matter")).not.toBeNull();
    expect(iconOf("Trash")).not.toBeNull();

    nav.destroy();
    container.remove();
  });

  // ITS OWN FIXTURE, not `worldSource()` widened by one row: half a dozen
  // other tests in this describe block assert exact row counts and pixel
  // offsets against that fixture's nine rows, and a tenth row shifts every
  // one of them (found by running this against the shared fixture first).
  test("a timeline paints a glyph too (101)", () => {
    const items = [
      { id: "bible-1", parent_id: null, title: "The Bible", depth: 0, type: "bible" },
      { id: "timeline-1", parent_id: "bible-1", title: "A Timeline", depth: 1, type: "timeline" },
    ];
    const source = {
      items,
      count: items.length,
      seed: "timeline-glyph-v1",
      titleAt: (i: number) => items[i]!.title,
      idAt: (i: number) => items[i]!.id,
      depthAt: (i: number) => items[i]!.depth,
      typeAt: (i: number) => items[i]!.type,
    };
    const container = makeContainer();
    const nav = createNavigator({ container, source, rowHeight: 24, overscan: 20, mode: "virtual" });
    const row = [...container.querySelectorAll("[role='treeitem']")].find(
      (r) => r.textContent === "A Timeline",
    ) as HTMLElement;
    expect(row.querySelector(".nav-icon svg")).not.toBeNull();

    nav.destroy();
    container.remove();
  });

  test("the icon span is aria-hidden, so the row's accessible name is only its title", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rowNamed = (t: string): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;

    // textContent already proves the name carries nothing but the title (the
    // lookup above matches on it), and this pins the mechanism: the span the
    // glyph lives in is hidden from the accessibility tree, not merely empty
    // of visible text.
    expect(rowNamed("The Bible").querySelector(".nav-icon")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(rowNamed("A Note").querySelector(".nav-icon")?.getAttribute("aria-hidden")).toBe(
      "true",
    );

    nav.destroy();
    container.remove();
  });

  test("the FIRST reserved root in walk order carries data-first-reserved, and nothing else does", () => {
    // "Front Matter" precedes "The Bible" and both matter roots in the walk,
    // even though it is not first among the four reserved TYPES alphabetically
    // or by when each was designed - the attribute follows the WALK.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rows = [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];
    const marked = rows.filter((r) => r.dataset.firstReserved === "true").map((r) => r.textContent);

    expect(marked).toEqual(["Front Matter"]);

    nav.destroy();
    container.remove();
  });

  test("a recycled row element loses both the icon and the separator mark it used to hold", () => {
    // The same recycling hazard `data-type` and `data-indent` are already
    // guarded against: a row element that last painted "Front Matter" is
    // reused for an ordinary chapter on the next reproject, and an icon or a
    // mark set only when present would leave the glyph, or the separator,
    // drawn under a row nobody meant to single out.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rows = (): HTMLElement[] =>
      [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];

    const before = rows().find((r) => r.textContent === "Front Matter");
    expect(before).toBeDefined();
    expect(before?.dataset.firstReserved).toBe("true");
    expect(before?.querySelector(".nav-icon svg")).not.toBeNull();

    // Reload onto a source with no reserved roots at all: the same element
    // slots must lose both marks rather than keep showing them on whatever
    // manuscript row landed there.
    nav.reload(typedSource());

    for (const row of rows()) {
      expect(row.dataset.firstReserved).toBeUndefined();
      expect(row.querySelector(".nav-icon svg")).toBeNull();
    }

    nav.destroy();
    container.remove();
  });

  test("collapsing a branch above a gap shrinks the tree cleanly, painting no blank row", () => {
    // Regression for reproject calling setGapIndex before setCount: that order
    // let setGapIndex's own render() mount an index past the just-shrunk
    // `visible` array's end (using the list's stale, pre-shrink count), and
    // paint() then blanked a row instead of describing one. worldSource's
    // "Part One" (active by default) has children, and the reserved section
    // right after it is exactly the gap this would have to survive.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rows = (): HTMLElement[] =>
      [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];
    expect(rows().length).toBe(9);

    nav.handleKey("ArrowLeft"); // collapse Part One: drops Ch A and Sc 1

    const after = rows();
    expect(after.length).toBe(7);
    // Every mounted row describes a real item: none carries the blank branch's
    // signature of an id with no title.
    for (const row of after) {
      expect(row.dataset.itemId).toBeTruthy();
      expect(row.textContent).not.toBe("");
    }
    expect(after.map((r) => r.textContent)).toEqual([
      "Part One",
      "Front Matter",
      "Dedication",
      "The Bible",
      "A Note",
      "Back Matter",
      "Trash",
    ]);
    expect(after.find((r) => r.textContent === "Front Matter")?.dataset.firstReserved).toBe("true");

    nav.destroy();
    container.remove();
  });

  test("the glyph sits INSIDE .nav-title, after the chevron and before the title text", () => {
    // The chevron is `.nav-title::before` in style.css, which the browser
    // always paints before an element's real children - so a glyph nested as
    // `.nav-title`'s own first child renders chevron, glyph, title without any
    // extra ordering rule. The initial 095 ship painted the glyph as a
    // SIBLING before `.nav-title` instead, which put it before the chevron
    // too; this pins the fix at the DOM level rather than trusting a visual
    // read.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rowNamed = (t: string): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;

    const title = rowNamed("The Bible").querySelector(".nav-title");
    expect(title).not.toBeNull();
    expect(title?.firstElementChild?.classList.contains("nav-icon")).toBe(true);
    // The text node comes right after the glyph span, inside .nav-title -
    // not before it, and not as a sibling of .nav-title.
    expect(title?.firstElementChild?.nextSibling?.textContent).toBe("The Bible");

    nav.destroy();
    container.remove();
  });

  test("a scene row's title is a bare text node, with no icon-sized slot reserved", () => {
    // Before 095's first ship a scene's `.nav-title` held nothing but a text
    // node; the fix restores exactly that shape for every row the icon table
    // does not cover, rather than an empty `.nav-icon` wrapper that would
    // nudge the title 8px to the right the way the captures showed.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rowNamed = (t: string): HTMLElement =>
      [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;

    const title = rowNamed("Sc 1").querySelector(".nav-title");
    expect(title).not.toBeNull();
    expect(title?.querySelector(".nav-icon")).toBeNull();
    expect(title?.childNodes.length).toBe(1);
    expect(title?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(title?.textContent).toBe("Sc 1");

    nav.destroy();
    container.remove();
  });

  test("the virtual list's gap sits above the first reserved root, shifting every row from there on 16px lower", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: worldSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const topOf = (t: string): number => {
      const row = [...container.querySelectorAll("[role='treeitem']")].find(
        (r) => r.textContent === t,
      ) as HTMLElement;
      return parseFloat(row.style.top);
    };

    expect(topOf("Part One")).toBe(0 * 24);
    expect(topOf("Ch A")).toBe(1 * 24);
    expect(topOf("Sc 1")).toBe(2 * 24);
    // "Front Matter" is the first reserved root (index 3 in the walk): every
    // row from here on carries the 16px gap, and rows before it do not.
    expect(topOf("Front Matter")).toBe(3 * 24 + 16);
    expect(topOf("Dedication")).toBe(4 * 24 + 16);
    expect(topOf("The Bible")).toBe(5 * 24 + 16);
    expect(topOf("A Note")).toBe(6 * 24 + 16);
    expect(topOf("Back Matter")).toBe(7 * 24 + 16);
    expect(topOf("Trash")).toBe(8 * 24 + 16);

    nav.destroy();
    container.remove();
  });

  test("a walk with no reserved roots has no gap at all", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: typedSource(), rowHeight: 24, overscan: 20, mode: "virtual",
    });
    const rows = [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];
    for (let i = 0; i < rows.length; i++) {
      expect(parseFloat(rows[i]!.style.top)).toBe(i * 24);
    }

    nav.destroy();
    container.remove();
  });

  // Not a recycling test: mountNaive replaces every child, so it cannot carry a
  // stale indent. It is here because naive mode is the negative control the
  // whole ARIA story rests on, and a control that renders differently from the
  // thing it controls for is not a control.
  test("naive mode indents every row, and re-indents after a collapse", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: deepSource(), rowHeight: 20, overscan: 4, mode: "naive",
    });
    const indents = (): (string | undefined)[] =>
      [...container.querySelectorAll("[role='treeitem']")].map(
        (r) => (r as HTMLElement).dataset.indent,
      );

    expect(indents()).toEqual(["0", "1", "2", "3", "0"]);

    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowLeft"); // collapse Ch A
    expect(indents()).toEqual(["0", "1", "0"]);

    nav.destroy();
    container.remove();
  });

  test("the indent does not touch the row's inline height", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: deepSource(), rowHeight: 20, overscan: 4, mode: "virtual",
    });
    // ROW_HEIGHT is restated as a click-geometry constant in three rigs. This
    // cannot prove the LAID-OUT height (happy-dom does not lay out); it proves
    // the indent was not implemented by writing a taller box.
    for (const r of container.querySelectorAll("[role='treeitem']")) {
      expect((r as HTMLElement).style.height).toBe("20px");
    }

    nav.destroy();
    container.remove();
  });

  test("naive mode collapses and expands without leaking elements", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: treeSource(), rowHeight: 20, overscan: 2, mode: "naive",
    });
    expect(container.children.length).toBe(4);

    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowLeft");
    expect(titlesIn(container)).toEqual(["Part One", "Ch A", "Ch B"]);
    expect(container.children.length).toBe(3);

    nav.handleKey("ArrowRight");
    expect(titlesIn(container)).toEqual(["Part One", "Ch A", "Sc 1", "Ch B"]);
    expect(container.children.length).toBe(4);

    nav.destroy();
    expect(container.children.length).toBe(0);
    container.remove();
  });
});
