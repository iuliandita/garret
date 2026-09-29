// The dropdown extracted out of menu-bar.ts and shared with the navigator's
// context menu.
//
// menu-bar.test.ts already drives every one of these behaviours THROUGH the
// application menu, and that is deliberately not enough: the extraction exists
// so a second surface gets them, and a property only asserted through one caller
// is a property the other caller can lose. These tests hold the module itself.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { clampToViewport, createMenuPanel, type MenuItemSpec } from "../src/menu-panel";

function mount() {
  const panel = createMenuPanel({ id: "test-menu-panel" });
  document.body.append(panel.element);
  return panel;
}

describe("clampToViewport", () => {
  test("leaves a menu that fits where the pointer put it", () => {
    expect(clampToViewport(100, 200, 220, 180, 1200, 800)).toEqual({ x: 100, y: 200 });
  });

  test("pulls a menu opened near the right edge back inside", () => {
    // The whole menu, not its origin: a writer right-clicking a row 40px from
    // the edge must still be able to read "New chapter".
    expect(clampToViewport(1150, 100, 220, 180, 1200, 800).x).toBe(980);
  });

  test("pulls a menu opened near the bottom edge back inside", () => {
    // The ordinary case in a long manuscript: the row a writer wants is at the
    // foot of the pane, and the menu is taller than the space below it.
    expect(clampToViewport(100, 780, 220, 180, 1200, 800).y).toBe(620);
  });

  test("a menu larger than the window starts at the origin, never off it", () => {
    // The one failure worse than overflowing the bottom edge is overflowing the
    // TOP one, where the first item - the item focus lands on - is the part that
    // cannot be seen at all.
    const at = clampToViewport(500, 500, 2000, 2000, 1200, 800);
    expect(at).toEqual({ x: 0, y: 0 });
  });
});

describe("painting", () => {
  test("radio items announce the current view at paint time", () => {
    const panel = mount();
    let current = "table";
    panel.paint([
      { id: "table-view", label: () => "Table", checked: () => current === "table", run: () => undefined },
      { id: "cards-view", label: () => "Cards", checked: () => current === "cards", run: () => undefined },
    ], "Outline");
    expect(document.getElementById("table-view")?.getAttribute("role")).toBe("menuitemradio");
    expect(document.getElementById("table-view")?.getAttribute("aria-checked")).toBe("true");
    current = "cards";
    panel.paint([
      { id: "table-view", label: () => "Table", checked: () => current === "table", run: () => undefined },
      { id: "cards-view", label: () => "Cards", checked: () => current === "cards", run: () => undefined },
    ], "Outline");
    expect(document.getElementById("cards-view")?.getAttribute("aria-checked")).toBe("true");
    panel.destroy();
  });
  test("resolves each label once, at paint time", () => {
    const panel = mount();
    let asked = 0;
    panel.paint([{ id: "a", label: () => `call ${(asked += 1)}`, run: () => undefined }], "Menu");
    expect(document.getElementById("a")?.textContent).toBe("call 1");
    // Held, not re-derived: this is the property that stops a selection change
    // between paint and click turning a Restore into a Delete.
    document.getElementById("a")?.click();
    expect(asked).toBe(1);
    panel.destroy();
  });

  test("an item that opens a dialog says so and one that does not stays silent", () => {
    const panel = mount();
    panel.paint(
      [
        { id: "plain", label: () => "Plain", run: () => undefined },
        { id: "dialog", opensDialog: true, label: () => "Panel…", run: () => undefined },
      ],
      "Menu",
    );
    expect(document.getElementById("plain")?.getAttribute("aria-haspopup")).toBeNull();
    expect(document.getElementById("dialog")?.getAttribute("aria-haspopup")).toBe("dialog");
    panel.destroy();
  });

  test("a shortcut hint is hidden from the name and given as aria-keyshortcuts", () => {
    const panel = mount();
    panel.paint([{ id: "a", label: () => "Undo", shortcut: "Ctrl+Z", run: () => undefined }], "M");
    const item = document.getElementById("a");
    expect(item?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Z");
    expect(item?.querySelector(".menu-item-shortcut")?.getAttribute("aria-hidden")).toBe("true");
    panel.destroy();
  });

  test("painting again replaces what was there", () => {
    const panel = mount();
    panel.paint([{ id: "first", label: () => "First", run: () => undefined }], "One");
    panel.paint([{ id: "second", label: () => "Second", run: () => undefined }], "Two");
    expect(document.getElementById("first")).toBe(null);
    expect(document.getElementById("second")).not.toBe(null);
    expect(panel.element.getAttribute("aria-label")).toBe("Two");
    panel.destroy();
  });
});

describe("the menu closes BEFORE the item runs", () => {
  test("observed from inside the dep, not through a second listener", () => {
    // A second `click` listener on the item cannot see this: listeners fire in
    // registration order, so an observer added after the unit's own handler runs
    // after `close()` either way and passes against the reversed implementation.
    // The only vantage point that can tell them apart is inside `run`.
    const panel = mount();
    // A RECORD, not a `let`. A local assigned only inside a closure is narrowed
    // to its initializer for the rest of the file, so `expect(x).toBe(false)`
    // would not even type-check - and the recorded shape of that trap is a
    // vacuity guard that compiles while asserting nothing. Property narrowing
    // resets.
    const seen: { openWhenRun: boolean | null } = { openWhenRun: null };
    const spec: MenuItemSpec = {
      id: "a",
      label: () => "Act",
      run: () => {
        seen.openWhenRun = panel.isOpen();
      },
    };
    panel.paint([spec], "Menu");
    expect(panel.isOpen()).toBe(true);
    document.getElementById("a")?.click();
    expect(seen.openWhenRun).toBe(false);
    panel.destroy();
  });

  test("onClose fires for the close an item performs, not only for close()", () => {
    // This is what keeps a surface's own state in step with a panel that closes
    // itself. Without it the menu bar leaves aria-expanded true on the title it
    // opened from and treats the next request to open that menu as a re-open,
    // which closes nothing twice and opens nothing at all.
    const closes: string[] = [];
    const panel = createMenuPanel({ id: "test-menu-panel", onClose: () => closes.push("closed") });
    document.body.append(panel.element);
    panel.paint([{ id: "a", label: () => "Act", run: () => undefined }], "Menu");
    document.getElementById("a")?.click();
    expect(closes).toEqual(["closed"]);
    panel.destroy();
  });

  test("closing an already-closed panel announces nothing", () => {
    // The recursion guard: a surface whose onClose closes again must find
    // nothing to do. Without it the notification is unbounded.
    const closes: string[] = [];
    const panel = createMenuPanel({ id: "test-menu-panel", onClose: () => closes.push("x") });
    document.body.append(panel.element);
    panel.paint([{ id: "a", label: () => "Act", run: () => undefined }], "Menu");
    panel.close();
    panel.close();
    expect(closes.length).toBe(1);
    panel.destroy();
  });
});

describe("arrow keys", () => {
  function keydown(key: string): KeyboardEvent {
    return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  }

  function threeItems() {
    const panel = mount();
    panel.paint(
      ["a", "b", "c"].map((id) => ({ id, label: () => id, run: () => undefined })),
      "Menu",
    );
    return panel;
  }

  test("Down walks forward and wraps at the end", () => {
    const panel = threeItems();
    panel.focusItem(0);
    // ids, never elements: a failing `toBe` on a happy-dom node prints the whole
    // node - megabytes of getters - and can kill the runner by timeout, which a
    // mutation harness then reads as a survivor.
    expect(document.activeElement?.id).toBe("a");
    panel.handleArrowKey(keydown("ArrowDown"));
    expect(document.activeElement?.id).toBe("b");
    panel.handleArrowKey(keydown("ArrowDown"));
    panel.handleArrowKey(keydown("ArrowDown"));
    expect(document.activeElement?.id).toBe("a");
    panel.destroy();
  });

  test("Up from the first item wraps to the last", () => {
    const panel = threeItems();
    panel.focusItem(0);
    panel.handleArrowKey(keydown("ArrowUp"));
    expect(document.activeElement?.id).toBe("c");
    panel.destroy();
  });

  test("it reports whether it consumed the key, and prevents the default", () => {
    const panel = threeItems();
    panel.focusItem(0);
    const down = keydown("ArrowDown");
    expect(panel.handleArrowKey(down)).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    const escape = keydown("Escape");
    expect(panel.handleArrowKey(escape)).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    panel.destroy();
  });

  test("a closed panel consumes nothing", () => {
    // A caller registers this on the document, so a closed menu that swallowed
    // ArrowDown would take the navigator's own selection key away from it.
    const panel = threeItems();
    panel.close();
    const down = keydown("ArrowDown");
    expect(panel.handleArrowKey(down)).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    panel.destroy();
  });
});

describe("destroy", () => {
  test("takes the element and its items out of the document", () => {
    const panel = mount();
    panel.paint([{ id: "a", label: () => "Act", run: () => undefined }], "Menu");
    panel.destroy();
    expect(document.getElementById("a")).toBe(null);
    expect(document.getElementById("test-menu-panel")).toBe(null);
  });

  test("registers nothing on the document", async () => {
    // COUNTED, not asserted about behaviour: a leaked document listener changes
    // no DOM state a test can reach while accumulating one live closure per
    // surface that uses this module. The module deliberately owns none - the
    // surfaces above it register their own Escape and outside-click handlers,
    // because what those do differs per surface.
    const source = await Bun.file("app/ui/src/menu-panel.ts").text();
    expect(source).not.toContain("document.addEventListener");
  });
});

describe("separators", () => {
  test("a separator is drawn between groups and is never an item", () => {
    const panel = mount();
    const specs: MenuItemSpec[] = [
      { id: "sep-a", label: () => "A", run: () => undefined },
      { id: "sep-b", label: () => "B", separatorBefore: true, run: () => undefined },
      { id: "sep-c", label: () => "C", run: () => undefined },
    ];
    panel.paint(specs, "Grouped");
    const children = [...panel.element.children];
    expect(children.map((c) => c.id || c.getAttribute("role"))).toEqual(["sep-a", "separator", "sep-b", "sep-c"]);
    // The arrows walk items only: Down from A lands on B, not on the rule.
    panel.focusItem(0);
    panel.handleArrowKey(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    expect(document.activeElement?.id).toBe("sep-b");
    expect(panel.focusedIndex()).toBe(1);
    panel.destroy();
  });

  test("a separator before the first item is not drawn", () => {
    const panel = mount();
    panel.paint([{ id: "sep-first", label: () => "A", separatorBefore: true, run: () => undefined }], "One");
    expect(panel.element.querySelector('[role="separator"]')).toBeNull();
    panel.destroy();
  });
});
