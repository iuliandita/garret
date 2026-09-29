import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createNavigator, type TreeSource } from "../src/navigator/index";

interface Row {
  id: string;
  parent_id: string | null;
  depth: number;
  title: string;
}

/** The store's depth-first walk. Every fixture below is a slice or an
 *  extension of it, so a reload is always a walk the recursive CTE could
 *  actually have produced - `project()` panics on anything else, and a test
 *  that fed it a bad walk would be measuring the panic. */
const BASE: Row[] = [
  { id: "part-0", parent_id: null, depth: 0, title: "Part One" },
  { id: "scene-0", parent_id: "part-0", depth: 1, title: "Arrival" },
  { id: "scene-1", parent_id: "part-0", depth: 1, title: "Departure" },
  { id: "part-1", parent_id: null, depth: 0, title: "Part Two" },
  { id: "scene-2", parent_id: "part-1", depth: 1, title: "Return" },
];

/** BASE with a third child under part-0: the shape a create lands in. */
const PLUS_SCENE_3: Row[] = [
  BASE[0]!, BASE[1]!, BASE[2]!,
  { id: "scene-3", parent_id: "part-0", depth: 1, title: "Reprise" },
  BASE[3]!, BASE[4]!,
];

/** A new sibling ahead of scene-2, so every id after it shifts by one. */
const BEFORE_SCENE_2: Row[] = [
  BASE[0]!, BASE[1]!, BASE[2]!, BASE[3]!,
  { id: "scene-2b", parent_id: "part-1", depth: 1, title: "Detour" },
  BASE[4]!,
];

/** part-1 indented under part-0, carrying scene-2 with it: the walk an Alt+Right
 *  on part-1 produces. */
const PART_1_INDENTED: Row[] = [
  BASE[0]!, BASE[1]!, BASE[2]!,
  { id: "part-1", parent_id: "part-0", depth: 1, title: "Part Two" },
  { id: "scene-2", parent_id: "part-1", depth: 2, title: "Return" },
];

const WITHOUT_PART_0: Row[] = [BASE[3]!, BASE[4]!];
const WITHOUT_PART_1: Row[] = [BASE[0]!, BASE[1]!, BASE[2]!];

function sourceOf(rows: readonly Row[]): TreeSource {
  return {
    count: rows.length,
    seed: "test",
    titleAt: (i) => rows[i]!.title,
    idAt: (i) => rows[i]!.id,
    depthAt: (i) => rows[i]!.depth,
    items: rows.map((r) => ({ id: r.id, parent_id: r.parent_id })),
  };
}

type Mode = "virtual" | "naive";

function mount(mode: Mode = "virtual", onActivate?: (id: string) => void) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(container);
  const nav = createNavigator({
    container,
    source: sourceOf(BASE),
    rowHeight: 20,
    overscan: 4,
    mode,
    onActivate,
  });
  return {
    container,
    nav,
    teardown: () => {
      nav.destroy();
      container.remove();
    },
  };
}

const rowOf = (container: HTMLElement, itemId: string): HTMLElement => {
  const el = container.querySelector(`[data-item-id="${itemId}"]`);
  if (el === null) throw new Error(`row ${itemId} is not mounted`);
  return el as HTMLElement;
};

const idsOf = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("[data-item-id]")].map(
    (el) => (el as HTMLElement).dataset.itemId!,
  );

for (const mode of ["virtual", "naive"] as const) {
  describe(`navigator reload (${mode})`, () => {
    test("a new row appears", () => {
      const { container, nav, teardown } = mount(mode);
      expect(nav.rows().length).toBe(5);
      nav.reload(sourceOf(PLUS_SCENE_3));
      expect(nav.rows().length).toBe(6);
      expect(nav.rows().map((r) => r.title)).toContain("Reprise");
      expect(rowOf(container, "scene-3").textContent).toBe("Reprise");
      teardown();
    });

    test("the selection is preserved by id, not by index", () => {
      const { nav, teardown } = mount(mode);
      nav.selectById("scene-2");
      expect(nav.activeIndex()).toBe(4);
      nav.reload(sourceOf(BEFORE_SCENE_2));
      // The same item, one row further down. An index-preserving reload would
      // leave the selection on scene-2b and the reader's place would move
      // under them on every create.
      expect(nav.activeIndex()).toBe(5);
      expect(nav.rows()[nav.activeIndex()]!.id).toBe("scene-2");
      teardown();
    });

    test("an item that changed depth is re-indented, in both directions", () => {
      // Alt+Right on part-1 indents it under part-0 and carries scene-2 with
      // it. Both rows keep their element (reload repaints in place, it does not
      // remount), so an indent written anywhere but the per-row paint stays at
      // the pre-move depth - and the pane would then show a move that did not
      // happen.
      const { container, nav, teardown } = mount(mode);
      expect(rowOf(container, "part-1").dataset.indent).toBe("0");
      expect(rowOf(container, "scene-2").dataset.indent).toBe("1");

      nav.reload(sourceOf(PART_1_INDENTED));
      expect(rowOf(container, "part-1").dataset.indent).toBe("1");
      expect(rowOf(container, "scene-2").dataset.indent).toBe("2");

      // And back out again: an outdent must shrink the indent, not only grow
      // it. A max()-flavoured bug passes the first half alone.
      nav.reload(sourceOf(BASE));
      expect(rowOf(container, "part-1").dataset.indent).toBe("0");
      expect(rowOf(container, "scene-2").dataset.indent).toBe("1");
      teardown();
    });

    test("aria-activedescendant names an element that is actually in the document", () => {
      // The assertion that catches a stale walkIndex: element ids are built
      // from the row's position in the FULL walk, so a reload that does not
      // rebuild the index either points the pointer at a row that no longer
      // exists or throws on an id it has never seen.
      const { container, nav, teardown } = mount(mode);
      nav.selectById("scene-2");
      nav.reload(sourceOf(PLUS_SCENE_3));
      const pointer = container.getAttribute("aria-activedescendant");
      expect(pointer).not.toBeNull();
      const el = document.getElementById(pointer!);
      expect(el).not.toBeNull();
      expect(el!.dataset.itemId).toBe(nav.rows()[nav.activeIndex()]!.id);
      teardown();
    });
  });
}

describe("navigator reload", () => {
  test("the collapsed set survives a reload", () => {
    const { container, nav, teardown } = mount();
    nav.handleKey("ArrowLeft"); // part-0 is selected at mount
    expect(nav.rows().map((r) => r.id)).toEqual(["part-0", "part-1", "scene-2"]);
    nav.reload(sourceOf(PLUS_SCENE_3));
    expect(nav.rows().map((r) => r.id)).toEqual(["part-0", "part-1", "scene-2"]);
    expect(idsOf(container)).not.toContain("scene-3");
    // The falsifying half: everything above is equally true of `reload() {}`.
    // Only expanding the branch afterwards can tell "the collapsed set survived
    // a real reload" from "no reload happened" - scene-3 arrived in the new
    // walk and nowhere else.
    nav.handleKey("ArrowRight");
    expect(nav.rows().map((r) => r.id)).toEqual([
      "part-0", "scene-0", "scene-1", "scene-3", "part-1", "scene-2",
    ]);
    expect(idsOf(container)).toContain("scene-3");
    teardown();
  });

  test("indenting into a COLLAPSED sibling reveals the moved row instead of jumping to row 0", () => {
    // Alt+Right on part-1 makes it a child of part-0, which the writer had
    // collapsed. Preserving the selection by id is not enough: the id is not in
    // `visible` at all, findIndex returns -1, and setActive(0) puts the reader
    // at the top of the manuscript with the row they just moved nowhere on
    // screen and nothing saying the move worked. At the stress fixture that is
    // a jump to row 0 of 20,060.
    const { container, nav, teardown } = mount();
    nav.handleKey("ArrowLeft"); // part-0 is selected at mount; collapse it
    nav.selectById("part-1");
    expect(nav.rows()[nav.activeIndex()]!.id).toBe("part-1");

    nav.reload(sourceOf(PART_1_INDENTED));

    expect(nav.rows().map((r) => r.id)).toContain("part-1");
    expect(nav.rows()[nav.activeIndex()]!.id).toBe("part-1");
    expect(rowOf(container, "part-1").getAttribute("aria-selected")).toBe("true");
    teardown();
  });

  test("revealing the moved row does not expand branches it is not inside", () => {
    // The auto-expand is the writer's own move being shown to them, not a
    // general "expand everything". A collapsed branch elsewhere in the
    // manuscript stays collapsed.
    const { nav, teardown } = mount();
    nav.selectById("part-1");
    nav.handleKey("ArrowLeft"); // collapse part-1, which holds scene-2
    nav.selectById("part-0");
    nav.handleKey("ArrowLeft"); // and collapse part-0
    nav.selectById("part-1");

    nav.reload(sourceOf(PART_1_INDENTED));

    // part-0 was reopened to reveal part-1; part-1 itself stays as the writer
    // left it, so scene-2 is still hidden.
    expect(nav.rows().map((r) => r.id)).toEqual(["part-0", "scene-0", "scene-1", "part-1"]);
    teardown();
  });

  test("a collapsed id that left the walk is dropped", () => {
    const { nav, teardown } = mount();
    nav.handleKey("ArrowLeft");
    nav.reload(sourceOf(WITHOUT_PART_0));
    expect(nav.rows().map((r) => r.id)).toEqual(["part-1", "scene-2"]);
    teardown();
  });

  test("an id that leaves the walk and comes back is expanded, not collapsed", () => {
    // The falsifying half of the test above: `collapsed` is keyed by id, and a
    // stale entry does nothing at all while its id is absent. Only the id's
    // RETURN can distinguish a pruned set from an unpruned one - a writer who
    // deletes a part, undoes, and finds it collapsed is the defect.
    const { nav, teardown } = mount();
    nav.handleKey("ArrowLeft");
    nav.reload(sourceOf(WITHOUT_PART_0));
    nav.reload(sourceOf(BASE));
    expect(nav.rows().map((r) => r.id)).toEqual([
      "part-0", "scene-0", "scene-1", "part-1", "scene-2",
    ]);
    teardown();
  });

  test("aria-current survives a reload", () => {
    const { container, nav, teardown } = mount();
    nav.setOpen("scene-1");
    nav.reload(sourceOf(PLUS_SCENE_3));
    const current = container.querySelectorAll("[aria-current]");
    expect(current.length).toBe(1);
    expect((current[0] as HTMLElement).dataset.itemId).toBe("scene-1");
    teardown();
  });

  test("aria-current is cleared when its item leaves the walk", () => {
    const { container, nav, teardown } = mount();
    nav.setOpen("scene-2");
    nav.reload(sourceOf(WITHOUT_PART_1));
    expect(container.querySelectorAll("[aria-current]").length).toBe(0);
    teardown();
  });

  test("a selected id that left the walk falls back to the first row", () => {
    const { container, nav, teardown } = mount();
    nav.selectById("scene-2");
    nav.reload(sourceOf(WITHOUT_PART_1));
    expect(nav.activeIndex()).toBe(0);
    expect(nav.rows()[0]!.id).toBe("part-0");
    expect(rowOf(container, "part-0").getAttribute("aria-selected")).toBe("true");
    teardown();
  });

  test("ARIA is recomputed, not carried over", () => {
    const { container, nav, teardown } = mount();
    expect(rowOf(container, "scene-0").getAttribute("aria-setsize")).toBe("2");
    nav.reload(sourceOf(PLUS_SCENE_3));
    // scene-0 gained a sibling: the group is 3 now, and a row still claiming 2
    // tells a screen reader "2 of 2" about a set of three.
    expect(rowOf(container, "scene-0").getAttribute("aria-setsize")).toBe("3");
    expect(rowOf(container, "scene-3").getAttribute("aria-posinset")).toBe("3");
    expect(rowOf(container, "scene-3").getAttribute("aria-level")).toBe("2");
    teardown();
  });

  test("a reload activates nothing", () => {
    // A reload runs after every structural edit. One that activated would open
    // a document on every rename.
    const seen: string[] = [];
    const { nav, teardown } = mount("virtual", (id) => seen.push(id));
    nav.selectById("scene-2");
    nav.reload(sourceOf(PLUS_SCENE_3));
    expect(seen).toEqual([]);
    teardown();
  });

  test("an empty walk is tolerated", () => {
    // Built by hand: storeSourceFrom refuses an empty item array, and this
    // asserts the navigator does not explode on the walk a store could return
    // between a delete and a create.
    const empty: TreeSource = {
      count: 0,
      seed: "test",
      titleAt: () => "",
      idAt: () => "",
      depthAt: () => 0,
      items: [],
    };
    const { container, nav, teardown } = mount();
    nav.reload(empty);
    expect(nav.rows().length).toBe(0);
    expect(container.getAttribute("aria-activedescendant")).toBeNull();
    expect(idsOf(container)).toEqual([]);
    teardown();
  });
});
