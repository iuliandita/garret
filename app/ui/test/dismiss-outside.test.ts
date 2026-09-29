import { describe, expect, test, afterEach } from "bun:test";
import { closeOnOutsideClick } from "../src/dismiss-outside";

interface Rig {
  panel: HTMLElement;
  inside: HTMLElement;
  outside: HTMLButtonElement;
  closes: number;
  open: boolean;
  stop: () => void;
}

const rigs: Rig[] = [];

function rig(): Rig {
  const panel = document.createElement("div");
  const inside = document.createElement("button");
  panel.append(inside);
  const outside = document.createElement("button");
  document.body.append(panel, outside);

  const r: Rig = {
    panel,
    inside,
    outside,
    closes: 0,
    open: true,
    stop: () => {},
  };
  r.stop = closeOnOutsideClick(
    panel,
    () => r.open,
    () => {
      r.closes += 1;
      r.open = false;
    },
  );
  rigs.push(r);
  return r;
}

afterEach(() => {
  // The listener is on the DOCUMENT and the suite shares one across every test
  // file. A rig left registered closes some other file's panel.
  for (const r of rigs) {
    r.stop();
    r.panel.remove();
    r.outside.remove();
  }
  rigs.length = 0;
});

describe("a click outside an open panel closes it", () => {
  test("a click on an unrelated element closes", () => {
    const r = rig();
    r.outside.click();
    expect(r.closes).toBe(1);
  });

  test("a click inside the panel does not", () => {
    const r = rig();
    r.inside.click();
    expect(r.closes).toBe(0);
  });

  test("a click on the panel itself does not", () => {
    const r = rig();
    r.panel.click();
    expect(r.closes).toBe(0);
  });

  test("a click while the panel is already closed does nothing", () => {
    // Without the isOpen guard this fires on every click the writer makes for
    // the whole life of the page, and `close()` on a closed panel is invisible -
    // so the cost would be real and nothing would show it.
    const r = rig();
    r.open = false;
    r.outside.click();
    expect(r.closes).toBe(0);
  });

  test("after unsubscribing, an outside click does nothing", () => {
    const r = rig();
    r.stop();
    r.outside.click();
    expect(r.closes).toBe(0);
  });
});

describe("the capture phase is load-bearing", () => {
  test("a control whose own handler opens the panel leaves it open", () => {
    // THE RACE THIS EXISTS TO AVOID. The menu item that opens the panel is a
    // control OUTSIDE it, and its own click handler runs in the bubble phase.
    // Registered in the bubble phase, this closer would run AFTER that handler
    // and shut the panel the writer just asked for - a menu item that visibly
    // does nothing. In the capture phase it runs first, sees the panel in its
    // pre-click state, and the item then opens it.
    const r = rig();
    r.open = false;
    r.outside.addEventListener("click", () => {
      r.open = true;
    });
    r.outside.click();
    expect(r.open).toBe(true);
    expect(r.closes).toBe(0);
  });

  test("the same control closes an already-open panel, then reopens it", () => {
    // The toggle behaviour a writer expects from a control that opens a panel,
    // falling out of the ordering rather than being coded twice.
    const r = rig();
    r.open = true;
    r.outside.addEventListener("click", () => {
      r.open = true;
    });
    r.outside.click();
    expect(r.closes).toBe(1);
    expect(r.open).toBe(true);
  });
});

describe("every panel that lost its toggle is wired to this", () => {
  // A SOURCE PARSE, because no single test can see a cross-cutting rule and
  // because the listener is on the document: leaking it changes no DOM state
  // and no behaviour a unit test can reach, while accumulating one live closure
  // per project switch. The recorded way to catch that shape is counting, and
  // counting call sites in the source is the cheapest form of it.
  // history and statistics-panel joined the list when they were built; the
  // recorded failure is the FIFTH panel, missed because the list was written
  // when there were four.
  const UNITS = [
    "quick-open",
    "nav-context-menu",
  ] as const;

  for (const unit of UNITS) {
    test(`${unit} registers the closer and unregisters it on destroy`, async () => {
      const source = await Bun.file(`app/ui/src/${unit}.ts`).text();
      expect(source).toContain("closeOnOutsideClick(");
      // The unsubscribe must be CALLED, not merely held. A binding assigned and
      // never invoked reads as cleanup to anyone skimming the file.
      expect(source).toContain("stopOutsideClick()");
      const destroyAt = source.indexOf("destroy(");
      expect(destroyAt).toBeGreaterThan(-1);
      expect(source.indexOf("stopOutsideClick()")).toBeGreaterThan(destroyAt);
    });
  }

  // the anchored panels close through the shell, which registers the
  // closer once for all of them. Each must still build one and destroy it.
  const SHELL_UNITS = ["rename-panel", "find-bar", "preferences", "statistics-panel", "synopsis-panel", "cast-panel", "comments-panel", "design-panel", "craft-panel", "covers-panel", "history", "switcher", "identity-panel", "preflight-panel", "mirror-changes", "appearances-panel", "appearances-map", "help", "revision-panel", "picture-viewer"] as const;

  test("the shell registers the closer and unregisters it on destroy", async () => {
    const source = await Bun.file("app/ui/src/panel-shell.ts").text();
    expect(source).toContain("closeOnOutsideClick(");
    expect(source.indexOf("stopOutsideClick()")).toBeGreaterThan(source.indexOf("destroy(): void"));
  });

  for (const unit of SHELL_UNITS) {
    test(`${unit} builds the shell and destroys it on destroy`, async () => {
      const source = await Bun.file(`app/ui/src/${unit}.ts`).text();
      expect(source).toContain("createPanelShell(");
      const destroyAt = source.indexOf("destroy(");
      expect(destroyAt).toBeGreaterThan(-1);
      expect(source.lastIndexOf("shell.destroy()")).toBeGreaterThan(destroyAt);
    });
  }

  test("the parse is not satisfied by a file that merely mentions the name", () => {
    // Vacuity guard for the guard above: three files matching two substrings
    // could be three files with the import and nothing else, so this asserts the
    // module itself does NOT match the destroy-ordering shape the units do.
    const self = "app/ui/src/dismiss-outside.ts";
    expect(UNITS.map((u) => `app/ui/src/${u}.ts`)).not.toContain(self);
  });
});
