import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { menuRoute } from "../../harness/src/menu-drive";
import type { MatterKind } from "../src/outline";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createMenuBar, type MenuBar, type ProjectsFocus } from "../src/menu-bar";
import { createClosePrompt } from "../src/close-prompt";

interface Calls {
  projects: ProjectsFocus[];
  exported: number;
  exportedAs: number;
  exportedDocx: number;
  backedUp: number;
  quit: number;
  renamedProject: number;
  imported: number;
  preferences: number;
  find: number;
  undo: number;
  redo: number;
  created: string[];
  notes: number;
  folders: number;
  timelines: number;
  matter: MatterKind[];
  moved: string[];
  renamed: number;
  removedOrRestored: number;
  help: number;
  statistics: number;
  revisionState: number;
  reviewProposals: number;
  synopsis: number;
  cast: number;
  appears: number;
  appearsMap: number;
  navBack: number;
  navForward: number;
  outlineUndo: number;
  outlineRedo: number;
  library: number;
}

interface Rig {
  bar: MenuBar;
  container: HTMLElement;
  calls: Calls;
  /** What the selection reports. Mutable so a test can move the selection
   *  between painting a menu and clicking its item, which is the one case the
   *  paint-time label decision exists for. */
  selection: { trashed: boolean };
  /** What the trail reports it can do. Mutable for the same reason `selection`
   *  is: the label is decided at paint time and must say when it cannot act. */
  trail: { back: boolean; forward: boolean };
  /** What the outline unit's stack reports. Mutable for the same reason
   *  `trail` is: the labels are painted at paint time. */
  outlineHistory: { undoLabel: string | null; redoLabel: string | null };
  title(id: string): HTMLButtonElement;
  item(id: string): HTMLButtonElement | null;
  panel(): HTMLElement;
  /** The one Menu button, #app-menu. */
  button(): HTMLButtonElement;
  /** The popover the four titles are rows of, #app-menu-list. */
  list(): HTMLElement;
}

function mount(privacy?: { enabled: boolean; calls: number; shortcut?: "ctrl_alt_l" | "ctrl_alt_p" | "off" }, openCreation?: () => void): Rig {
  const container = document.createElement("span");
  document.body.append(container);

  const calls: Calls = {
    projects: [],
    exported: 0,
    exportedAs: 0,
    exportedDocx: 0,
    backedUp: 0,
    quit: 0,
    renamedProject: 0,
    imported: 0,
    preferences: 0,
    find: 0,
    undo: 0,
    redo: 0,
    created: [],
    notes: 0,
    folders: 0,
    timelines: 0,
    matter: [],
    moved: [],
    renamed: 0,
    removedOrRestored: 0,
    help: 0,
    statistics: 0,
    revisionState: 0,
    reviewProposals: 0,
    synopsis: 0,
    cast: 0,
    appears: 0,
    appearsMap: 0,
    navBack: 0,
    navForward: 0,
    outlineUndo: 0,
    outlineRedo: 0,
    library: 0,
  };
  const selection = { trashed: false };
  const trail = { back: true, forward: true };
  const outlineHistory: { undoLabel: string | null; redoLabel: string | null } = {
    undoLabel: null,
    redoLabel: null,
  };

  const bar = createMenuBar({
    container,
    openCreation,
    showManuscript: () => undefined,
    showOutlineTable: () => undefined,
    showOutlineCards: () => undefined,
    showReadThrough: () => undefined,
    showContinuousChapter: () => undefined,
    openReference: () => undefined,
    closeReference: () => undefined,
    outlineViewMode: () => "manuscript",
    openProjects: (focus) => calls.projects.push(focus),
    openLibrary: () => (calls.library += 1),
    exportProject: () => (calls.exported += 1),
    exportAs: () => (calls.exportedAs += 1),
    exportDocx: () => (calls.exportedDocx += 1),
    openEpubPreview: () => undefined,
    openPdfPreview: () => undefined,
    backupNow: () => (calls.backedUp += 1),
    quit: () => (calls.quit += 1),
    importProject: () => (calls.imported += 1),
    openPreferences: () => (calls.preferences += 1),
    canLockPrivacy: () => privacy?.enabled ?? false,
    privacyShortcut: () => privacy?.shortcut ?? "ctrl_alt_l",
    lockPrivacy: () => { if (privacy) privacy.calls += 1; },
    openFind: () => (calls.find += 1),
    openReplace: () => {},
    openHistory: () => {},
    openMirrorChanges: () => {},
    openComments: () => {},
    addComment: () => {},
    addToDictionary: () => {},
    navBack: () => (calls.navBack += 1),
    navForward: () => (calls.navForward += 1),
    canNavBack: () => trail.back,
    canNavForward: () => trail.forward,
    openQuickOpen: () => {},
    undo: () => (calls.undo += 1),
    redo: () => (calls.redo += 1),
    outlineUndo: () => (calls.outlineUndo += 1),
    outlineRedo: () => (calls.outlineRedo += 1),
    outlineUndoLabel: () => outlineHistory.undoLabel,
    outlineRedoLabel: () => outlineHistory.redoLabel,
    create: (itemType) => calls.created.push(itemType),
    createNote: () => (calls.notes += 1),
    createBibleFolder: () => (calls.folders += 1),
    createTimeline: () => (calls.timelines += 1),
    createMatter: (kind: MatterKind) => calls.matter.push(kind),
    renameProject: () => (calls.renamedProject += 1),
    move: (direction) => calls.moved.push(direction),
    beginRename: () => (calls.renamed += 1),
    removeOrRestore: () => (calls.removedOrRestored += 1),
    selectedTrashed: () => selection.trashed,
    openStatistics: () => (calls.statistics += 1),
    openAnalytics: () => undefined,
    openRevisionState: () => (calls.revisionState += 1),
    openReviewProposals: () => (calls.reviewProposals += 1),
    openSynopsis: () => (calls.synopsis += 1),
    openCast: () => (calls.cast += 1),
    openAppearances: () => (calls.appears += 1),
    openAppearancesMap: () => (calls.appearsMap += 1),
    openBookDesign: () => (calls.help += 1),
    openCovers: () => (calls.help += 1),
    openIdentities: () => (calls.help += 1),
    openHelp: () => (calls.help += 1),
  });

  const byId = <T extends HTMLElement>(id: string): T | null =>
    container.querySelector<T>(`#${id}`);

  return {
    bar,
    container,
    calls,
    selection,
    trail,
    outlineHistory,
    title(id) {
      const element = byId<HTMLButtonElement>(id);
      if (element === null) throw new Error(`no menu title #${id}`);
      return element;
    },
    item: (id) => {
      const existing = byId<HTMLButtonElement>(id);
      if (existing) return existing;
      let route;
      try { route = menuRoute(id); } catch { return null; }
      if (byId(route.menu)?.getAttribute("aria-expanded") !== "true") return null;
      while (byId<HTMLButtonElement>("menu-panel-back")) byId<HTMLButtonElement>("menu-panel-back")!.click();
      for (const step of route.path.slice(0, -1)) {
        byId("menu-panel")?.querySelectorAll<HTMLButtonElement>("button")[step.index]?.click();
      }
      return byId<HTMLButtonElement>(id);
    },
    panel() {
      const element = byId<HTMLElement>("menu-panel");
      if (element === null) throw new Error("no #menu-panel");
      return element;
    },
    button() {
      const element = byId<HTMLButtonElement>("app-menu");
      if (element === null) throw new Error("no #app-menu");
      return element;
    },
    list() {
      const element = byId<HTMLElement>("app-menu-list");
      if (element === null) throw new Error("no #app-menu-list");
      return element;
    },
  };
}

function teardown(rig: Rig): void {
  rig.bar.destroy();
  rig.container.remove();
}

// Focus assertions compare IDs, never elements. `expect(activeElement).toBe(el)`
// on a happy-dom node prints the WHOLE node on failure -- megabytes of getters,
// slow enough that a mutation run reads as hung rather than failed, which is
// exactly how two live mutations were first misread as survivors here.
function press(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

describe("the menu bar's shape", () => {
  test("it exposes four titles, closed, as a menubar", () => {
    const rig = mount();
    try {
      expect(rig.container.getAttribute("role")).toBe("menubar");
      // The one button a writer sees: an icon, named for a screen reader,
      // collapsed, and pointing at the list it opens.
      const button = rig.button();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe("app-menu-list");
      expect(button.getAttribute("aria-label")).toBe("Menu");
      expect(button.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      // The four titles are rows of the list, in menu order, and the list is
      // hidden until asked for.
      const list = rig.list();
      expect(list.hidden).toBe(true);
      const titleIds = ["menu-file", "menu-edit", "menu-outline", "menu-help"];
      expect([...list.querySelectorAll("button")].map((e) => e.id).slice(0, 4)).toEqual(titleIds);
      for (const id of titleIds) {
        expect(rig.title(id).getAttribute("aria-expanded")).toBe("false");
      }
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("no dropdown item exists until its menu is opened", () => {
    const rig = mount();
    try {
      // Not merely hidden: the items are BUILT on open, so a rig or a screen
      // reader cannot find a command that is not on screen.
      expect(rig.item("menu-export")).toBeNull();
      rig.title("menu-file").click();
      const item = rig.item("menu-export");
      expect(item).not.toBeNull();
      // The role a screen reader keys off. Dropping it leaves a plain button in
      // a role="menu", which announces as a list of nothing in particular --
      // and every visual and behavioural assertion in this file still passes,
      // which is how it survived the first mutation pass.
      expect(item?.getAttribute("role")).toBe("menuitem");
      expect(item?.tabIndex).toBe(-1);
    } finally {
      teardown(rig);
    }
  });

  test("the create items carry their VERBS and override no accessible name", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      // The toolbar's three buttons read "Part", "Chapter", "Scene" and carry
      // the verb only in an aria-label, so a screen-reader user is told what
      // the button does and a sighted user is not. A menu item has its own row,
      // so the visible text and the accessible name are one string again --
      // and this test fails if anyone reintroduces the override here.
      for (const [id, label] of [
        ["menu-new-part", "New part"],
        ["menu-new-chapter", "New chapter"],
        ["menu-new-scene", "New scene"],
        ["menu-new-note", "New bible document"],
        ["menu-new-bible-folder", "New bible folder"],
        ["menu-new-timeline", "New timeline"],
      ] as const) {
        const item = rig.item(id);
        expect(item?.textContent).toBe(label);
        expect(item?.hasAttribute("aria-label")).toBe(false);
      }
    } finally {
      teardown(rig);
    }
  });

  test("a shortcut hint is exposed once, as a name, not twice", () => {
    const rig = mount();
    try {
      rig.title("menu-edit").click();
      const undo = rig.item("menu-undo");
      expect(undo?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Z");
      // The visible hint is aria-hidden, or a screen reader reads the chord
      // twice: once from aria-keyshortcuts and once from the span's text.
      const hint = undo?.querySelector(".menu-item-shortcut");
      expect(hint?.textContent).toBe("Ctrl+Z");
      expect(hint?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      teardown(rig);
    }
  });
});

describe("opening and closing", () => {
  test("clicking a title opens it and marks it expanded", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      expect(rig.panel().hidden).toBe(false);
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("true");
    } finally {
      teardown(rig);
    }
  });

  test("clicking the OPEN title again closes it", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.title("menu-file").click();
      expect(rig.panel().hidden).toBe(true);
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown(rig);
    }
  });

  test("opening a second menu clears the first title's expanded state", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.title("menu-edit").click();
      // The attribute a screen reader is reading. Leaving it true on the menu
      // that closed announces two open menus, which is why open() closes
      // through close() rather than just repainting the panel.
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("false");
      expect(rig.title("menu-edit").getAttribute("aria-expanded")).toBe("true");
      expect(rig.item("menu-export")).toBeNull();
      expect(rig.item("menu-undo")).not.toBeNull();
    } finally {
      teardown(rig);
    }
  });

  test("a click outside closes the menu", () => {
    const rig = mount();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      rig.title("menu-file").click();
      outside.click();
      expect(rig.panel().hidden).toBe(true);
    } finally {
      outside.remove();
      teardown(rig);
    }
  });

  test("a click INSIDE the bar does not close the menu", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      // The help panel is appended into this container precisely so that
      // clicking inside it does not take it away.
      rig.panel().click();
      expect(rig.panel().hidden).toBe(false);
    } finally {
      teardown(rig);
    }
  });

  test("running an item closes the menu BEFORE the action runs", () => {
    // OBSERVED FROM INSIDE THE ACTION, not from a second click listener on the
    // item. A listener added by the test runs AFTER the unit's own handler has
    // returned, by which point close() has happened whichever order it happened
    // in -- so that version of this test passed against `spec.run(); close();`
    // too. It was caught by mutation, which is the only thing that catches it.
    const container = document.createElement("span");
    document.body.append(container);
    const observed: { hiddenWhenRun: boolean | null } = { hiddenWhenRun: null };
    const bar = createMenuBar({
      container,
      showManuscript: () => undefined,
      showOutlineTable: () => undefined,
      showOutlineCards: () => undefined,
      showReadThrough: () => undefined,
      showContinuousChapter: () => undefined,
      openReference: () => undefined,
      closeReference: () => undefined,
      outlineViewMode: () => "manuscript",
      openProjects: () => undefined,
      openLibrary: () => undefined,
      exportProject: () => {
        observed.hiddenWhenRun =
          container.querySelector<HTMLElement>("#menu-panel")?.hidden ?? null;
      },
      exportAs: () => undefined,
      exportDocx: () => undefined,
      openEpubPreview: () => undefined,
      openPdfPreview: () => undefined,
      backupNow: () => undefined,
      importProject: () => undefined,
      openPreferences: () => undefined,
      openFind: () => undefined,
      openReplace: () => {},
      openHistory: () => {},
      openMirrorChanges: () => {},
      openComments: () => {},
      addComment: () => {},
      addToDictionary: () => {},
      navBack: () => undefined,
      navForward: () => undefined,
      canNavBack: () => true,
      canNavForward: () => true,
      openQuickOpen: () => {},
      undo: () => undefined,
      redo: () => undefined,
      outlineUndo: () => undefined,
      outlineRedo: () => undefined,
      outlineUndoLabel: () => null,
      outlineRedoLabel: () => null,
      create: () => undefined,
    createNote: () => undefined,
    createBibleFolder: () => undefined,
    createTimeline: () => undefined,
    createMatter: () => undefined,
      beginRename: () => undefined,
      removeOrRestore: () => undefined,
      selectedTrashed: () => false,
      openStatistics: () => undefined,
      openAnalytics: () => undefined,
      openRevisionState: () => undefined,
      openReviewProposals: () => undefined,
      openSynopsis: () => undefined,
      openCast: () => undefined,
      openAppearances: () => undefined,
      openAppearancesMap: () => undefined,
      openBookDesign: () => undefined,
      openCovers: () => undefined,
      openIdentities: () => undefined,
      openHelp: () => undefined,
      quit: () => undefined,
      renameProject: () => undefined,
      move: () => undefined,
    });
    try {
      container.querySelector<HTMLButtonElement>("#menu-file")?.click();
      container.querySelector<HTMLButtonElement>("#menu-export")?.click();
      // The action may open a panel and move focus into it; a dropdown still
      // painted over that panel is the writer's next click landing on the wrong
      // surface.
      expect(observed.hiddenWhenRun).toBe(true);
    } finally {
      bar.destroy();
      container.remove();
    }
  });
});

describe("what the items do", () => {
  test("File reaches projects, export and preferences", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-project-new")?.click();
      rig.title("menu-file").click();
      rig.item("menu-project-open")?.click();
      rig.title("menu-file").click();
      rig.item("menu-preferences")?.click();

      // Two items, one panel, two different resting places for the caret. If
      // they passed the same focus they would be two names for one action,
      // which is what this asserts they are not.
      expect(rig.calls.projects).toEqual(["create", "list"]);
      expect(rig.calls.preferences).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Import and Export as reach the dialog routes, not the panel", () => {
    // The whole distinction the slice adds. Both used to be the project panel
    // with a caret placed somewhere; if either still reached `openProjects`
    // the menu would be advertising an OS dialog and opening a panel.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-import")?.click();
      rig.title("menu-file").click();
      rig.item("menu-export-as")?.click();

      expect(rig.calls.imported).toBe(1);
      expect(rig.calls.exportedAs).toBe(1);
      expect(rig.calls.projects).toEqual([]);
      // And neither is the fixed-directory export, which still has its own item
      // and its own button.
      expect(rig.calls.exported).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("Export for an editor (Word) runs its own dep", () => {
    // A format of its own, not a third argument folded into Export
    // as… -- the same reason Export statistics has a CSV item and a JSON
    // item rather than one item with a hidden choice inside it.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-export-docx")?.click();

      expect(rig.calls.exportedDocx).toBe(1);
      // And neither of the other two export routes fired.
      expect(rig.calls.exported).toBe(0);
      expect(rig.calls.exportedAs).toBe(0);
      // The less frequent export formats share the Publishing page.
      rig.title("menu-file").click();
      rig.item("menu-publishing")!.click();
      const ids = [...rig.panel().querySelectorAll("button")].map((b) => b.id);
      expect(ids.indexOf("menu-export-docx")).toBe(ids.indexOf("menu-export-as") + 1);
      expect(ids).not.toContain("menu-export");
    } finally {
      teardown(rig);
    }
  });

  test("menu-library sits below the exports, immediately above Preferences", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      const ids = [...rig.panel().querySelectorAll("button")].map((b) => b.id);
      expect(ids.indexOf("menu-library")).toBe(ids.indexOf("menu-preferences") - 1);
      // The ordinary manuscript export remains on the first page.
      expect(ids.indexOf("menu-export")).toBe(4);
      rig.item("menu-library")?.click();
      expect(rig.calls.library).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Ctrl+Shift+L opens the library, and is application chrome", () => {
    const rig = mount();
    try {
      press("l", { ctrlKey: true, shiftKey: true });
      expect(rig.calls.library).toBe(1);
      // Every menu is closed: the chord is a shortcut, not a route through
      // the File menu, and must not leave a dropdown standing.
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("Ctrl+Alt+Shift+L and Ctrl+Shift+Meta+L do not open it", () => {
    // A held Alt or a held Meta changes what a chord means on a real keyboard
    // (the input-method and window-manager combos both sit on Ctrl+Shift+*),
    // and this listener has no reason to steal either.
    const rig = mount();
    try {
      press("l", { ctrlKey: true, shiftKey: true, altKey: true });
      press("l", { ctrlKey: true, shiftKey: true, metaKey: true });
      expect(rig.calls.library).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("Rename project renames in the sidebar, and opens no panel", () => {
    // The project panel used to open with the caret in a rename field.
    // The book's name moved into the strip above the outline and became
    // the affordance, so this item must reach that and NOT the panel: two
    // fields for one act is what that earlier argument rejected.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-project-rename")?.click();
      expect(rig.calls.renamedProject).toBe(1);
      expect(rig.calls.projects).toEqual([]);
    } finally {
      teardown(rig);
    }
  });

  test("Quit asks to leave and does nothing else", () => {
    // The ONLY route out of this application from inside it. Everything else in
    // the File menu writes a file or opens a panel; this one hands the window to
    // the host, and a mutation pointing it at any neighbour would be a Quit item
    // that exports a manuscript.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-quit")?.click();

      expect(rig.calls.quit).toBe(1);
      expect(rig.calls.backedUp).toBe(0);
      expect(rig.calls.exported).toBe(0);
      expect(rig.calls.exportedAs).toBe(0);
      expect(rig.calls.preferences).toBe(0);
      expect(rig.calls.projects).toEqual([]);
    } finally {
      teardown(rig);
    }
  });

  test("Quit is the LAST item in the File menu", () => {
    // Position, not presence. Every reader of a File menu expects to leave from
    // the bottom of it, and `menu-cli` indexes items by position - so a Quit
    // inserted in the middle moves every graded coordinate below it.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      const ids = [...document.querySelectorAll("#menu-panel [role='menuitem']")].map(
        (element) => element.id,
      );
      expect(ids.length).toBeGreaterThan(4);
      expect(ids[ids.length - 1]).toBe("menu-quit");
    } finally {
      teardown(rig);
    }
  });

  test("Quit advertises its chord", () => {
    // The shortcut column is the only place the chord is discoverable from the
    // menu, and `help.ts` states it a second time. Both are asserted, in
    // different files, because the two drift silently.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      expect(rig.item("menu-quit")?.textContent).toContain("Ctrl+Q");
    } finally {
      teardown(rig);
    }
  });

  test("Encrypted backups opens the existing backup controls without creating a recovery point", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-encrypted-backups")?.click();
      expect(rig.calls.projects).toEqual(["backups"]);
      expect(rig.calls.backedUp).toBe(0);
    } finally { teardown(rig); }
  });

  test("Back up now takes a recovery point and does nothing else", () => {
    // It is beside the export items because it is the same kind of thing: a
    // command that writes a file. It must not be reachable from either export
    // route, and neither may reach it.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-backup-now")?.click();

      expect(rig.calls.backedUp).toBe(1);
      expect(rig.calls.exported).toBe(0);
      expect(rig.calls.exportedAs).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("Export manuscript and Export as are different items", () => {
    // Two routes, two destinations, and a writer who picks the wrong one loses
    // nothing - but they must not be the same call. A single mutation swapping
    // one for the other is invisible without this.
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.item("menu-export")?.click();

      expect(rig.calls.exported).toBe(1);
      expect(rig.calls.exportedAs).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("Edit reaches undo, redo and find", () => {
    const rig = mount();
    try {
      rig.title("menu-edit").click();
      rig.item("menu-undo")?.click();
      rig.title("menu-edit").click();
      rig.item("menu-redo")?.click();
      rig.title("menu-edit").click();
      rig.item("menu-find")?.click();
      expect(rig.calls.undo).toBe(1);
      expect(rig.calls.redo).toBe(1);
      expect(rig.calls.find).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Outline creates with the right type, and names nothing", () => {
    // NO TITLE. The title is the next free number for the
    // type, which is a property of the walk -- and the walk is read inside the
    // outline unit's serialized body, because a title computed out here would be
    // numbered against a tree that may already have changed.
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-new-chapter")?.click();
      expect(rig.calls.created).toEqual(["chapter"]);
    } finally {
      teardown(rig);
    }
  });

  test("the four Move items each send their own direction", () => {
    // The whole point of adding them: they existed as Alt+Arrow and nowhere a
    // writer could see. One test for all four, because a mutation swapping any
    // two of them would leave three still working and look fine.
    const rig = mount();
    try {
      for (const id of ["menu-move-up", "menu-move-down", "menu-move-out", "menu-move-in"]) {
        rig.title("menu-outline").click();
        rig.item(id)?.click();
      }
      expect(rig.calls.moved).toEqual(["up", "down", "outdent", "indent"]);
    } finally {
      teardown(rig);
    }
  });

  test("the Move items advertise their chords", () => {
    // The chord is the thing a writer takes away from seeing the item once.
    const rig = mount();
    try {
      const expected: Record<string, string> = {
        "menu-move-up": "Alt+Up",
        "menu-move-down": "Alt+Down",
        "menu-move-out": "Alt+Left",
        "menu-move-in": "Alt+Right",
      };
      for (const [id, chord] of Object.entries(expected)) {
        rig.title("menu-outline").click();
        expect(rig.item(id)?.textContent).toContain(chord);
        rig.bar.close();
      }
    } finally {
      teardown(rig);
    }
  });

  test("Help opens the shortcuts panel", () => {
    const rig = mount();
    try {
      rig.title("menu-help").click();
      rig.item("menu-shortcuts")?.click();
      expect(rig.calls.help).toBe(1);
    } finally {
      teardown(rig);
    }
  });
});

describe("Back and Forward", () => {
  /** The visible label only. `textContent` on these two also picks up the
   *  shortcut hint, so an assertion against it would pass a label that had lost
   *  its word entirely. */
  const labelOf = (rig: Rig, id: string): string | undefined =>
    rig.item(id)?.querySelector(".menu-item-label")?.textContent ?? undefined;

  test("they read plainly when the trail can move", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect(labelOf(rig, "menu-nav-back")).toBe("Back");
      expect(labelOf(rig, "menu-nav-forward")).toBe("Forward");
    } finally {
      teardown(rig);
    }
  });

  test("they SAY when they cannot act rather than looking live", () => {
    // The whole reason the label is a function here. An item that reads "Back"
    // and does nothing when pressed reads as a broken application; one that says
    // there is nothing earlier is an answer.
    const rig = mount();
    try {
      rig.trail.back = false;
      rig.trail.forward = false;
      rig.title("menu-outline").click();
      expect(labelOf(rig, "menu-nav-back")).toBe("Back (nothing earlier)");
      expect(labelOf(rig, "menu-nav-forward")).toBe("Forward (nothing further)");
    } finally {
      teardown(rig);
    }
  });

  test("each half is decided on its own", () => {
    // One flag driving both labels would be invisible while a test set them
    // together, and wrong for the ordinary case: after one Back there is
    // somewhere to go in both directions, and after the writer arrives somewhere
    // new there is one and not the other.
    const rig = mount();
    try {
      rig.trail.forward = false;
      rig.title("menu-outline").click();
      expect(labelOf(rig, "menu-nav-back")).toBe("Back");
      expect(labelOf(rig, "menu-nav-forward")).toBe("Forward (nothing further)");
    } finally {
      teardown(rig);
    }
  });

  test("they run the page's own navigations", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-nav-back")?.click();
      rig.title("menu-outline").click();
      rig.item("menu-nav-forward")?.click();
      expect(rig.calls.navBack).toBe(1);
      expect(rig.calls.navForward).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("they show their chords", () => {
    // The menu is where a writer finds out a chord exists at all. Both halves:
    // the visible hint and the accessible name, which are different channels and
    // have drifted apart elsewhere in this application.
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect(rig.item("menu-nav-back")?.getAttribute("aria-keyshortcuts")).toBe("Alt+Left");
      expect(rig.item("menu-nav-forward")?.getAttribute("aria-keyshortcuts")).toBe("Alt+Right");
      expect(rig.item("menu-nav-back")?.querySelector(".menu-item-shortcut")?.textContent).toBe("Alt+Left");
    } finally {
      teardown(rig);
    }
  });

  test("navigation stays together after the creation group", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      const ids = [...rig.panel().querySelectorAll("[role='menuitem']")].map((el) => el.id);
      expect(ids.slice(1, 4)).toEqual(["menu-go-to", "menu-nav-back", "menu-nav-forward"]);
    } finally {
      teardown(rig);
    }
  });
});

describe("the context item says which action it will take", () => {
  test("it reads Delete for a live row and Restore for a trashed one", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect(rig.item("menu-remove")?.textContent).toBe("Delete");
      rig.title("menu-outline").click();

      rig.selection.trashed = true;
      rig.title("menu-outline").click();
      expect(rig.item("menu-remove")?.textContent).toBe("Restore");
    } finally {
      teardown(rig);
    }
  });

  test("Synopsis opens the panel for the selection", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-synopsis")?.click();

      expect(rig.calls.synopsis).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Cast opens the panel", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-cast")?.click();

      expect(rig.calls.cast).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Who appears here opens the panel for the selection", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-appears")?.click();

      expect(rig.calls.appears).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("Who appears where opens the panel, with review actions grouped last", () => {
    // Review has its own replacement page.
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      const items = [...rig.panel().querySelectorAll("[role='menuitem']")];
      expect(items.at(-1)?.id).toBe("menu-review");
      rig.item("menu-review")!.click();
      expect([...rig.panel().querySelectorAll("button")].slice(1).map((item) => item.id)).toEqual([
        "menu-statistics", "menu-analytics", "menu-craft-reports", "menu-review-proposals",
      ]);

      rig.item("menu-appears-map")?.click();

      expect(rig.calls.appearsMap).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("THE LABEL IS DECIDED WHEN THE MENU IS PAINTED, not when it is clicked", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect(rig.item("menu-remove")?.textContent).toBe("Delete");

      // The selection moves while the menu is open -- a background reload, a
      // late mutation resolving. The item the writer is looking at still says
      // Delete, so clicking it must still mean Delete. A label re-derived at
      // click time would silently turn this into a Restore.
      rig.selection.trashed = true;
      expect(rig.item("menu-remove")?.textContent).toBe("Delete");
      rig.item("menu-remove")?.click();

      // The page decides which of the two to run from the same held state the
      // bar painted its own label from, so all this asserts is that the menu
      // asked once and did not re-read.
      expect(rig.calls.removedOrRestored).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("selectedTrashed is NOT consulted again when the item is clicked", () => {
    const container = document.createElement("span");
    document.body.append(container);
    let reads = 0;
    const bar = createMenuBar({
      container,
      showManuscript: () => undefined,
      showOutlineTable: () => undefined,
      showOutlineCards: () => undefined,
    showReadThrough: () => undefined,
    showContinuousChapter: () => undefined,
      openReference: () => undefined,
      closeReference: () => undefined,
      outlineViewMode: () => "manuscript",
      openProjects: () => undefined,
      openLibrary: () => undefined,
      exportProject: () => undefined,
      exportAs: () => undefined,
      exportDocx: () => undefined,
      openEpubPreview: () => undefined,
      openPdfPreview: () => undefined,
      backupNow: () => undefined,
      importProject: () => undefined,
      openPreferences: () => undefined,
      openFind: () => undefined,
      openReplace: () => {},
      openHistory: () => {},
      openMirrorChanges: () => {},
      openComments: () => {},
      addComment: () => {},
      addToDictionary: () => {},
      navBack: () => undefined,
      navForward: () => undefined,
      canNavBack: () => true,
      canNavForward: () => true,
      openQuickOpen: () => {},
      undo: () => undefined,
      redo: () => undefined,
      outlineUndo: () => undefined,
      outlineRedo: () => undefined,
      outlineUndoLabel: () => null,
      outlineRedoLabel: () => null,
      create: () => undefined,
    createNote: () => undefined,
    createBibleFolder: () => undefined,
    createTimeline: () => undefined,
    createMatter: () => undefined,
      beginRename: () => undefined,
      removeOrRestore: () => undefined,
      selectedTrashed: () => {
        reads += 1;
        return false;
      },
      openStatistics: () => undefined,
      openAnalytics: () => undefined,
      openRevisionState: () => undefined,
      openReviewProposals: () => undefined,
      openSynopsis: () => undefined,
      openCast: () => undefined,
      openAppearances: () => undefined,
      openAppearancesMap: () => undefined,
      openBookDesign: () => undefined,
      openCovers: () => undefined,
      openIdentities: () => undefined,
      openHelp: () => undefined,
      quit: () => undefined,
      renameProject: () => undefined,
      move: () => undefined,
    });
    try {
      container.querySelector<HTMLButtonElement>("#menu-outline")?.click();
      expect(reads).toBe(0);
      container.querySelector<HTMLButtonElement>("#menu-organize")?.click();
      expect(reads).toBe(1);
      container.querySelector<HTMLButtonElement>("#menu-remove")?.click();
      // THE CLAIM. One read, at paint. An item that consulted the selection
      // again on activation could take an action the writer did not read -- the
      // label says Delete, a background reload moves the row into the bin, and
      // the click becomes a Restore. Asserting the label is unchanged does not
      // catch that, because nothing repaints; counting the reads does.
      expect(reads).toBe(1);
    } finally {
      bar.destroy();
      container.remove();
    }
  });

  test("selectedTrashed is not consulted at all until a menu is painted", () => {
    const container = document.createElement("span");
    document.body.append(container);
    let reads = 0;
    const bar = createMenuBar({
      container,
      showManuscript: () => undefined,
      showOutlineTable: () => undefined,
      showOutlineCards: () => undefined,
    showReadThrough: () => undefined,
    showContinuousChapter: () => undefined,
      openReference: () => undefined,
      closeReference: () => undefined,
      outlineViewMode: () => "manuscript",
      openProjects: () => undefined,
      openLibrary: () => undefined,
      exportProject: () => undefined,
      exportAs: () => undefined,
      exportDocx: () => undefined,
      openEpubPreview: () => undefined,
      openPdfPreview: () => undefined,
      backupNow: () => undefined,
      importProject: () => undefined,
      openPreferences: () => undefined,
      openFind: () => undefined,
      openReplace: () => {},
      openHistory: () => {},
      openMirrorChanges: () => {},
      openComments: () => {},
      addComment: () => {},
      addToDictionary: () => {},
      navBack: () => undefined,
      navForward: () => undefined,
      canNavBack: () => true,
      canNavForward: () => true,
      openQuickOpen: () => {},
      undo: () => undefined,
      redo: () => undefined,
      outlineUndo: () => undefined,
      outlineRedo: () => undefined,
      outlineUndoLabel: () => null,
      outlineRedoLabel: () => null,
      create: () => undefined,
    createNote: () => undefined,
    createBibleFolder: () => undefined,
    createTimeline: () => undefined,
    createMatter: () => undefined,
      beginRename: () => undefined,
      removeOrRestore: () => undefined,
      selectedTrashed: () => {
        reads += 1;
        return false;
      },
      openStatistics: () => undefined,
      openAnalytics: () => undefined,
      openRevisionState: () => undefined,
      openReviewProposals: () => undefined,
      openSynopsis: () => undefined,
      openCast: () => undefined,
      openAppearances: () => undefined,
      openAppearancesMap: () => undefined,
      openBookDesign: () => undefined,
      openCovers: () => undefined,
      openIdentities: () => undefined,
      openHelp: () => undefined,
      quit: () => undefined,
      renameProject: () => undefined,
      move: () => undefined,
    });
    try {
      // Building the bar must not walk the outline. A label function called at
      // construction would run an ancestor walk over a 20,060-row array before
      // the writer had asked for anything.
      expect(reads).toBe(0);
      container.querySelector<HTMLButtonElement>("#menu-outline")?.click();
      expect(reads).toBe(0);
      container.querySelector<HTMLButtonElement>("#menu-organize")?.click();
      expect(reads).toBe(1);
    } finally {
      bar.destroy();
      container.remove();
    }
  });
});

describe("the keyboard", () => {
  test("Alt+F opens File and lands on its first item", () => {
    const rig = mount();
    try {
      press("f", { altKey: true });
      expect(rig.panel().hidden).toBe(false);
      expect(document.activeElement?.id).toBe("menu-project-new");
    } finally {
      teardown(rig);
    }
  });

  test("the Alt key is matched case-insensitively", () => {
    const rig = mount();
    try {
      // A writer holding Shift, or with caps on, still means the File menu.
      press("F", { altKey: true });
      expect(rig.panel().hidden).toBe(false);
    } finally {
      teardown(rig);
    }
  });

  test("Alt+<key> does not fire when Ctrl is also held", () => {
    const rig = mount();
    try {
      press("f", { altKey: true, ctrlKey: true });
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("a bare letter never opens a menu", () => {
    const rig = mount();
    try {
      // Otherwise typing "f" in the manuscript opens File.
      press("f");
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  /** The Edit menu's item ids, read from what it painted.
   *
   *  The two wrap tests below used to restate them. That made them fail when an
   *  item was added to Edit - correctly reporting a different id, but about the
   *  menu's contents rather than about wrapping, which is what they are for.
   *  The first and last item are what wrapping is defined in terms of, so those
   *  are what the tests take. */
  function editItemIds(rig: Rig): string[] {
    return [...rig.panel().querySelectorAll("[role='menuitem']")].map((e) => e.id);
  }

  test("ArrowDown walks the items and wraps at the end", () => {
    const rig = mount();
    try {
      press("e", { altKey: true });
      const ids = editItemIds(rig);
      // A menu of fewer than three items cannot tell walking from wrapping.
      expect(ids.length).toBeGreaterThanOrEqual(3);
      expect(document.activeElement?.id).toBe(ids[0]);
      for (let i = 1; i < ids.length; i++) {
        press("ArrowDown");
        expect(document.activeElement?.id).toBe(ids[i]);
      }
      press("ArrowDown");
      expect(document.activeElement?.id).toBe(ids[0]);
    } finally {
      teardown(rig);
    }
  });

  test("ArrowUp from the first item wraps to the last", () => {
    const rig = mount();
    try {
      press("e", { altKey: true });
      const ids = editItemIds(rig);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      press("ArrowUp");
      expect(document.activeElement?.id).toBe(ids[ids.length - 1]);
    } finally {
      teardown(rig);
    }
  });

  test("arrows do nothing while no menu is open", () => {
    const rig = mount();
    try {
      // Otherwise the menu would swallow the navigator's own arrow keys, which
      // are how a writer moves the outline selection.
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("arrows in the editor keep their default and focus while a submenu is open", () => {
    const rig = mount();
    const editor = document.createElement("textarea");
    editor.id = "outside-the-open-menu";
    document.body.append(editor);
    try {
      press("e", { altKey: true });
      editor.focus();
      for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        editor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement?.id).toBe(editor.id);
        expect(rig.panel().hidden).toBe(false);
      }
      press("Escape");
      expect(rig.panel().hidden).toBe(true);
      expect(document.activeElement?.id).toBe(editor.id);
      press("f", { altKey: true });
      expect(document.activeElement?.id).toBe("menu-project-new");
    } finally {
      editor.remove();
      teardown(rig);
    }
  });
});

describe("the Menu button and its list", () => {
  test("a click opens the list with no dropdown and focuses File", () => {
    const rig = mount();
    try {
      rig.button().click();
      expect(rig.list().hidden).toBe(false);
      expect(rig.button().getAttribute("aria-expanded")).toBe("true");
      expect(rig.panel().hidden).toBe(true);
      expect(document.activeElement?.id).toBe("menu-file");
      rig.button().click();
      expect(rig.list().hidden).toBe(true);
      expect(rig.button().getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown(rig);
    }
  });

  test("a title click from the list opens its dropdown beside the row", () => {
    const rig = mount();
    try {
      rig.button().click();
      rig.title("menu-edit").click();
      expect(rig.panel().hidden).toBe(false);
      expect(rig.title("menu-edit").getAttribute("aria-expanded")).toBe("true");
      expect(rig.panel().style.top).toBe(`${rig.title("menu-edit").offsetTop}px`);
    } finally {
      teardown(rig);
    }
  });

  test("the dropdown is sized to the room below its row, so it scrolls instead of leaving the window", () => {
    const rig = mount();
    try {
      rig.button().click();
      rig.title("menu-outline").click();
      const title = rig.title("menu-outline");
      const listTop = (title.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0;
      const room = window.innerHeight - listTop - title.offsetTop - 12;
      expect(rig.panel().style.maxHeight).toBe(`${Math.max(room, 120)}px`);
    } finally {
      teardown(rig);
    }
  });

  test("Alt+F shows the list AND the File dropdown, focused on its first item", () => {
    const rig = mount();
    try {
      press("f", { altKey: true });
      expect(rig.list().hidden).toBe(false);
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement?.id).toBe("menu-project-new");
      // A second chord switches: the list stays up, the other row expands.
      press("e", { altKey: true });
      expect(rig.list().hidden).toBe(false);
      expect(rig.title("menu-edit").getAttribute("aria-expanded")).toBe("true");
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement?.id).toBe("menu-undo");
    } finally {
      teardown(rig);
    }
  });

  test("the chord for the menu already open closes everything and focuses the button", () => {
    // Not a half-state. open() alone would collapse the dropdown and leave the
    // bare list up with focus on the body, where Down and Up do nothing.
    const rig = mount();
    try {
      press("f", { altKey: true });
      press("f", { altKey: true });
      expect(rig.list().hidden).toBe(true);
      expect(rig.panel().hidden).toBe(true);
      expect(document.activeElement?.id).toBe("app-menu");
    } finally {
      teardown(rig);
    }
  });

  test("an item that ran takes the list with the dropdown", () => {
    const rig = mount();
    try {
      press("e", { altKey: true });
      rig.item("menu-undo")?.click();
      expect(rig.panel().hidden).toBe(true);
      expect(rig.list().hidden).toBe(true);
      expect(rig.button().getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown(rig);
    }
  });

  test("Escape closes the dropdown and the list and focuses the button", () => {
    const rig = mount();
    try {
      press("o", { altKey: true });
      press("Escape");
      expect(rig.panel().hidden).toBe(true);
      expect(rig.list().hidden).toBe(true);
      expect(document.activeElement?.id).toBe("app-menu");
    } finally {
      teardown(rig);
    }
  });

  test("Escape with focus OUTSIDE the bar closes the list and takes nothing else", () => {
    // A writer can Tab out of the open list into the editor. Escape there
    // still tidies the list away, but the caret stays where it is and the
    // event is not swallowed: it was the editor's Escape, not the menu's.
    const rig = mount();
    const input = document.createElement("input");
    input.id = "outside-the-bar";
    document.body.append(input);
    try {
      rig.button().click();
      input.focus();
      expect(document.activeElement?.id).not.toBe("menu-file");
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      expect(rig.list().hidden).toBe(true);
      expect(document.activeElement?.id).toBe("outside-the-bar");
      expect(event.defaultPrevented).toBe(false);
    } finally {
      input.remove();
      teardown(rig);
    }
  });

  test("a click outside closes both", () => {
    const rig = mount();
    try {
      press("f", { altKey: true });
      document.body.click();
      expect(rig.list().hidden).toBe(true);
      expect(rig.panel().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("hover switches menus only while a dropdown is open", () => {
    const rig = mount();
    try {
      rig.button().click();
      rig.title("menu-outline").dispatchEvent(new Event("mouseenter"));
      expect(rig.panel().hidden).toBe(true);
      rig.title("menu-file").click();
      rig.title("menu-outline").dispatchEvent(new Event("mouseenter"));
      expect(rig.title("menu-outline").getAttribute("aria-expanded")).toBe("true");
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown(rig);
    }
  });

  test("close() and destroy() leave neither the list nor the dropdown open", () => {
    const rig = mount();
    try {
      press("e", { altKey: true });
      rig.bar.close();
      expect(rig.list().hidden).toBe(true);
      expect(rig.button().getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown(rig);
    }
    expect(document.getElementById("app-menu")).toBeNull();
  });
});

describe("the keyboard model", () => {
  test("on a title, Down and Up walk the list and wrap; Right opens and enters", () => {
    const rig = mount();
    try {
      rig.button().click();
      press("ArrowDown");
      expect(document.activeElement?.id).toBe("menu-edit");
      press("ArrowUp");
      press("ArrowUp");
      expect(document.activeElement?.id).toBe("menu-help");
      press("ArrowRight");
      expect(rig.title("menu-help").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement?.id).toBe("menu-shortcuts");
    } finally {
      teardown(rig);
    }
  });

  test("in a dropdown, Left closes it and focuses its title; the list stays", () => {
    const rig = mount();
    try {
      press("e", { altKey: true });
      press("ArrowLeft");
      expect(rig.panel().hidden).toBe(true);
      expect(rig.list().hidden).toBe(false);
      expect(document.activeElement?.id).toBe("menu-edit");
    } finally {
      teardown(rig);
    }
  });

  test("in a dropdown, Down and Up walk the items, not the titles", () => {
    const rig = mount();
    try {
      press("f", { altKey: true });
      press("ArrowDown");
      expect(document.activeElement?.id).not.toBe("menu-edit");
      expect(rig.panel().contains(document.activeElement)).toBe(true);
    } finally {
      teardown(rig);
    }
  });
});

describe("teardown", () => {
  test("destroy removes the DOCUMENT listeners", () => {
    const rig = mount();
    rig.bar.destroy();
    // THE ONES THAT MATTER. Every other listener dies with the elements this
    // unit owns; these two are on the document and outlive them. A leaked copy
    // would answer Alt+F after the bar was gone, painting a dropdown into a
    // detached container -- and would accumulate one handler per project
    // switch. Same defect find-bar's teardown comment is written for.
    press("f", { altKey: true });
    expect(rig.container.querySelector("#menu-panel")).toBeNull();
    rig.container.remove();
  });

  test("destroy removes EVERY document listener it added", () => {
    // Counting, not symptom-hunting. The keydown leak is observable (Alt+F
    // still paints), but the capture-phase CLICK leak is not: after destroy
    // `painted` is null, so the leaked handler returns immediately and nothing
    // in the DOM differs. It still accumulates one live closure per project
    // switch. A mutation deleting its cleanup survived every other test here.
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
      const rig = mount();
      expect(added.length).toBeGreaterThan(0);
      rig.bar.destroy();
      rig.container.remove();
      expect(removed.slice().sort()).toEqual(added.slice().sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });

  test("destroy is idempotent and clears the container's role", () => {
    const rig = mount();
    rig.bar.destroy();
    rig.bar.destroy();
    expect(rig.container.hasAttribute("role")).toBe(false);
    expect(rig.container.children.length).toBe(0);
    rig.container.remove();
  });

  test("close() hides an open menu without tearing the bar down", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      rig.bar.close();
      expect(rig.panel().hidden).toBe(true);
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("false");
      // Still usable afterwards: the page calls close() on a project switch,
      // and the menu outlives the project.
      rig.title("menu-file").click();
      expect(rig.panel().hidden).toBe(false);
    } finally {
      teardown(rig);
    }
  });
});

describe("the items that open a page dialog say so", () => {
  // RESTORING WHAT RETIREMENT REMOVED. Each of these panels used to be opened by
  // a button in the project bar carrying aria-expanded + aria-controls, which is
  // how a screen-reader user learned that the control opens a thing. The buttons
  // are gone and the menu item is the only route in.
  const OPENS_DIALOG: Record<string, string> = {
    "menu-project-new": "menu-file",
    "menu-project-open": "menu-file",
    "menu-mirror-changes": "menu-file",
    "menu-encrypted-backups": "menu-file",
    "menu-library": "menu-file",
    "menu-preferences": "menu-file",
    "menu-book-design": "menu-file",
    "menu-covers": "menu-file",
    "menu-identities": "menu-file",
    "menu-find": "menu-edit",
    "menu-replace": "menu-edit",
    "menu-history": "menu-edit",
    "menu-add-comment": "menu-edit",
    "menu-comments": "menu-edit",
    "menu-shortcuts": "menu-help",
    "menu-go-to": "menu-outline",
    "menu-statistics": "menu-outline",
    "menu-analytics": "menu-outline",
    "menu-revision-state": "menu-outline",
    "menu-synopsis": "menu-outline",
    "menu-cast": "menu-outline",
    "menu-knowledge": "menu-outline",
    "menu-craft-reports": "menu-outline",
    "menu-appears": "menu-outline",
    "menu-appears-map": "menu-outline",
    "menu-review-proposals": "menu-outline",
  };
  // Items that reach an OS dialog, write a file, or act on the manuscript in
  // place. Without these the attribute could be set on every item and the test
  // above would still pass.
  const OPENS_NOTHING: Record<string, string> = {
    "menu-import": "menu-file",
    // acts on the caret and reports through the notice surface.
    "menu-add-to-dictionary": "menu-edit",
    "menu-export": "menu-file",
    "menu-export-as": "menu-file",
    "menu-export-docx": "menu-file",
    // A RAIL IS NOT A DIALOG. `aria-haspopup="dialog"` promises a surface that
    // takes over; the EPUB rail sits beside the prose, stays open while the
    // writer types, and has a Close instead of dismissing itself.
    "menu-epub-preview": "menu-file",
    // and it is in the SAME list for the same reason: it opens the same rail
    // in the other format, and a rail is not a dialog.
    "menu-pdf-preview": "menu-file",
    "menu-backup-now": "menu-file",
    "menu-quit": "menu-file",
    "menu-privacy-lock": "menu-file",
    "menu-project-rename": "menu-file",
    "menu-undo": "menu-edit",
    "menu-redo": "menu-edit",
    "menu-new-part": "menu-outline",
    "menu-new-chapter": "menu-outline",
    "menu-new-scene": "menu-outline",
    "menu-new-note": "menu-outline",
    "menu-new-bible-folder": "menu-outline",
    "menu-new-timeline": "menu-outline",
    "menu-new-dedication": "menu-outline",
    "menu-new-foreword": "menu-outline",
    "menu-new-acknowledgements": "menu-outline",
    "menu-new-afterword": "menu-outline",
    "menu-rename": "menu-outline",
    "menu-remove": "menu-outline",
    "menu-nav-back": "menu-outline",
    "menu-nav-forward": "menu-outline",
    "menu-move-up": "menu-outline",
    "menu-move-down": "menu-outline",
    "menu-move-out": "menu-outline",
    "menu-move-in": "menu-outline",
    "menu-outline-undo": "menu-outline",
    "menu-outline-redo": "menu-outline",
    "menu-open-reference": "menu-outline",
    "menu-close-reference": "menu-outline",
  };

  test("each panel-opening item carries aria-haspopup=dialog", () => {
    const rig = mount();
    try {
      for (const [item, menu] of Object.entries(OPENS_DIALOG)) {
        rig.title(menu).click();
        const element = rig.item(item);
        expect(element).not.toBeNull();
        expect(element?.getAttribute("aria-haspopup")).toBe("dialog");
        rig.bar.close();
      }
    } finally {
      teardown(rig);
    }
  });

  test("no other item carries it", () => {
    const rig = mount();
    try {
      for (const [item, menu] of Object.entries(OPENS_NOTHING)) {
        rig.title(menu).click();
        const element = rig.item(item);
        expect(element).not.toBeNull();
        expect(element?.getAttribute("aria-haspopup")).toBeNull();
        rig.bar.close();
      }
    } finally {
      teardown(rig);
    }
  });

  test("the two lists between them name every item in the menu", () => {
    // A vacuity guard on both tests above: an item added without a decision
    // about whether it opens a dialog is an item neither list covers, and this
    // is what says so rather than letting it pass unexamined.
    const named = new Set([...Object.keys(OPENS_DIALOG), ...Object.keys(OPENS_NOTHING)]);
    const rig = mount();
    try {
      const all = new Set<string>();
      function inspectPage(): void {
        const entries = [...rig.panel().querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
        for (const entry of entries) {
          if (entry.id === "menu-panel-back") continue;
          if (entry.getAttribute("aria-haspopup") === "menu") {
            entry.click();
            inspectPage();
            rig.panel().querySelector<HTMLButtonElement>("#menu-panel-back")!.click();
          } else all.add(entry.id);
        }
      }
      for (const menu of ["menu-file", "menu-edit", "menu-outline", "menu-help"]) {
        rig.title(menu).click();
        inspectPage();
        rig.bar.close();
      }
      const unnamed = [...all].filter((id) => !named.has(id));
      if (unnamed.length > 0) throw new Error(`unclassified menu items: ${unnamed.join(", ")}`);
      expect(all.size).toBe(named.size);
    } finally {
      teardown(rig);
    }
  });
});

describe("the four pages that are not chapters", () => {
  /** EACH ITEM CARRIES ITS OWN KIND, and a test over one of them cannot tell
   *  four bound arguments from four calls that all pass the same word. */
  test("each item runs createMatter with its own kind and creates no item type", () => {
    const rig = mount();
    try {
      for (const [item, kind] of [
        ["menu-new-dedication", "dedication"],
        ["menu-new-foreword", "foreword"],
        ["menu-new-acknowledgements", "acknowledgements"],
        ["menu-new-afterword", "afterword"],
      ] as const) {
        rig.title("menu-outline").click();
        rig.item(item)?.click();
      }
      expect(rig.calls.matter).toEqual([
        "dedication",
        "foreword",
        "acknowledgements",
        "afterword",
      ]);
      // Never `create(...)`: these are placed in one section, always, and
      // routing them through `planPlacement` would land a dedication in the
      // manuscript whenever the writer happened to be reading a scene.
      expect(rig.calls.created).toEqual([]);
      expect(rig.calls.notes).toBe(0);
    } finally {
      teardown(rig);
    }
  });
});

describe("New bible document", () => {
  test("runs its OWN action, never a create keyed on a type string", () => {
    // A bible document is placed in one section, always. Routing it through
    // `create("note")` would send it through `planPlacement`, which is computed
    // from the SELECTION -- so the same press would land in the manuscript
    // whenever the writer happened to be looking at a scene.
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-new-note")?.click();
      expect(rig.calls.notes).toBe(1);
      expect(rig.calls.created).toEqual([]);
    } finally {
      teardown(rig);
    }
  });
});

test("New bible folder uses its own bible action", () => {
  const rig = mount();
  try {
    rig.title("menu-outline").click();
    rig.item("menu-new-bible-folder")?.click();
    expect(rig.calls.folders).toBe(1);
    expect(rig.calls.created).toEqual([]);
  } finally {
    teardown(rig);
  }
});

test("Review proposals opens its captured workspace from the Outline menu", () => {
  const rig = mount();
  try {
    rig.title("menu-outline").click();
    rig.item("menu-review-proposals")?.click();
    expect(rig.calls.reviewProposals).toBe(1);
  } finally { teardown(rig); }
});

describe("Outline Undo and Redo", () => {
  const labelOf = (rig: Rig, id: string): string | undefined =>
    rig.item(id)?.querySelector(".menu-item-label")?.textContent ?? undefined;

  test("reference actions sit together in the reading group", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      const ids = [...rig.panel().querySelectorAll("[role='menuitem']")].map((el) => el.id);
      rig.item("menu-views")!.click();
      expect([...rig.panel().querySelectorAll("button")].slice(-2).map((el) => el.id)).toEqual(["menu-open-reference", "menu-close-reference"]);
    } finally {
      teardown(rig);
    }
  });

  test("with nothing to undo or redo, they read the empty labels", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect(labelOf(rig, "menu-outline-undo")).toBe("Undo outline change (nothing to undo)");
      expect(labelOf(rig, "menu-outline-redo")).toBe("Redo outline change (nothing to redo)");
    } finally {
      teardown(rig);
    }
  });

  test("with a label, they read it", () => {
    const rig = mount();
    try {
      rig.outlineHistory.undoLabel = "moving s2";
      rig.outlineHistory.redoLabel = "renaming c1";
      rig.title("menu-outline").click();
      expect(labelOf(rig, "menu-outline-undo")).toBe("Undo moving s2");
      expect(labelOf(rig, "menu-outline-redo")).toBe("Redo renaming c1");
    } finally {
      teardown(rig);
    }
  });

  test("clicking runs outlineUndo / outlineRedo", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      rig.item("menu-outline-undo")?.click();
      rig.title("menu-outline").click();
      rig.item("menu-outline-redo")?.click();
      expect(rig.calls.outlineUndo).toBe(1);
      expect(rig.calls.outlineRedo).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("they show their shared chord, once as a name and once visibly", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      const undo = rig.item("menu-outline-undo");
      expect(undo?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Z");
      const hint = undo?.querySelector(".menu-item-shortcut");
      expect(hint?.textContent).toBe("Ctrl+Z");
      expect(hint?.getAttribute("aria-hidden")).toBe("true");
      const redo = rig.item("menu-outline-redo");
      expect(redo?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Shift+Z");
    } finally {
      teardown(rig);
    }
  });
});


test("privacy lock is disabled until enabled, for menu and shortcut", () => {
  const privacy = { enabled: false, calls: 0 };
  const rig = mount(privacy);
  const press = () => {
    const event = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    rig.title("menu-file").click();
    expect(rig.item("menu-privacy-lock")?.getAttribute("aria-disabled")).toBe("true");
    rig.item("menu-privacy-lock")?.click();
    expect(press()).toBe(false);
    expect(privacy.calls).toBe(0);
    privacy.enabled = true;
    expect(press()).toBe(true);
    expect(privacy.calls).toBe(1);
    rig.title("menu-file").click();
    expect(rig.item("menu-privacy-lock")?.getAttribute("aria-disabled")).toBe("false");
    rig.item("menu-privacy-lock")?.click();
    expect(privacy.calls).toBe(2);
  } finally { rig.bar.destroy(); rig.container.remove(); }
});


test("privacy shortcut changes revoke the old binding and can disable it", () => {
  const privacy = { enabled: true, calls: 0, shortcut: "ctrl_alt_p" as "ctrl_alt_p" | "off" };
  const rig = mount(privacy);
  const press = (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, bubbles: true }));
  try {
    press("l");
    expect(privacy.calls).toBe(0);
    press("p");
    expect(privacy.calls).toBe(1);
    rig.title("menu-file").click();
    expect(rig.item("menu-privacy-lock")?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+Alt+P");
    privacy.shortcut = "off";
    press("p");
    press("l");
    expect(privacy.calls).toBe(1);
  } finally { rig.bar.destroy(); rig.container.remove(); }
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`composition keeps global shortcuts with the input method (${JSON.stringify(composition)})`, () => {
    const privacy = { enabled: true, calls: 0 };
    const r = mount(privacy);
    try {
      for (const chord of [{ key: "l", ctrlKey: true, shiftKey: true }, { key: "l", ctrlKey: true, altKey: true }, { key: "f", altKey: true }]) {
        const event = new KeyboardEvent("keydown", { ...chord, ...composition, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(r.calls.library).toBe(0); expect(privacy.calls).toBe(0);
        expect(r.list().hidden).toBe(true);
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      expect(r.calls.library).toBe(1);
    } finally { r.bar.destroy(); r.container.remove(); }
  });
}


describe("short menu pages", () => {
  test("File keeps frequent actions direct and moves publishing and copies onto pages", () => {
    const rig = mount();
    try {
      rig.title("menu-file").click();
      expect([...rig.panel().querySelectorAll("button")].map((item) => item.id)).toEqual([
        "menu-project-new", "menu-project-open", "menu-project-rename", "menu-import", "menu-export",
        "menu-publishing", "menu-copies", "menu-library", "menu-preferences", "menu-privacy-lock", "menu-quit",
      ]);
      expect(rig.item("menu-export")?.getAttribute("aria-keyshortcuts")).toBe("Ctrl+E");
      rig.item("menu-copies")!.click();
      expect([...rig.panel().querySelectorAll("button")].map((item) => item.id)).toEqual([
        "menu-panel-back", "menu-backup-now", "menu-encrypted-backups", "menu-mirror-changes",
      ]);
      expect(rig.title("menu-file").getAttribute("aria-expanded")).toBe("true");
      press("ArrowLeft");
      expect(document.activeElement?.id).toBe("menu-copies");
      expect(rig.panel().hidden).toBe(false);
    } finally { teardown(rig); }
  });
  test("Outline starts with eight task choices and creation falls back to common types plus More", () => {
    const rig = mount();
    try {
      rig.title("menu-outline").click();
      expect([...rig.panel().querySelectorAll("button")].map((item) => item.id)).toEqual([
        "menu-new", "menu-go-to", "menu-nav-back", "menu-nav-forward", "menu-organize", "menu-planning", "menu-views", "menu-review",
      ]);
      rig.item("menu-new")!.click();
      expect([...rig.panel().querySelectorAll("button")].map((item) => item.id)).toEqual([
        "menu-panel-back", "menu-new-scene", "menu-new-chapter", "menu-new-part", "menu-more",
      ]);
      press("Escape");
      expect(rig.panel().hidden).toBe(true);
      expect(rig.list().hidden).toBe(true);
    } finally { teardown(rig); }
  });
  test("New hands off to the provided chooser after closing the entire menu", () => {
    let calls = 0;
    const rig = mount(undefined, () => {
      expect(rig.panel().hidden).toBe(true);
      expect(rig.list().hidden).toBe(true);
      calls++;
    });
    try {
      rig.title("menu-outline").click();
      expect(rig.item("menu-new")?.getAttribute("aria-haspopup")).toBe("dialog");
      rig.item("menu-new")!.click();
      expect(calls).toBe(1);
      expect(rig.calls.created).toEqual([]);
    } finally { teardown(rig); }
  });
});

for (const chord of [
  { key: "f", altKey: true },
  { key: "l", ctrlKey: true, shiftKey: true },
  { key: "f", ctrlKey: true },
]) {
  test(`close warning contains ${JSON.stringify(chord)} before document shortcuts`, async () => {
    const rig = mount();
    const prompt = createClosePrompt({ container: document.body });
    let findOpened = false;
    const onFind = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.altKey && event.key === "f") findOpened = true;
    };
    document.addEventListener("keydown", onFind);
    try {
      const choice = prompt.openPreferences();
      const stay = document.querySelector<HTMLButtonElement>("#close-prompt-panel button")!;
      stay.dispatchEvent(new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true }));
      expect(rig.panel().hidden).toBe(true);
      expect(rig.calls.library).toBe(0);
      expect(findOpened).toBe(false);
      expect(document.activeElement === stay).toBe(true);
      stay.click();
      expect(await choice).toBe("stay");
    } finally {
      document.removeEventListener("keydown", onFind);
      prompt.destroy();
      teardown(rig);
    }
  });
}

for (const shortcut of ["ctrl_alt_l", "ctrl_alt_p", "off"] as const) {
  test(`close warning retains only the configured privacy shortcut ${shortcut}`, async () => {
    const privacy = { enabled: true, calls: 0, shortcut };
    const rig = mount(privacy);
    const prompt = createClosePrompt({ container: document.body, privacyShortcut: () => privacy.shortcut });
    try {
      const choice = prompt.open(1);
      const stay = document.querySelector<HTMLButtonElement>("#close-prompt-panel button")!;
      for (const key of ["l", "p"]) {
        stay.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      }
      expect(privacy.calls).toBe(shortcut === "off" ? 0 : 1);
      expect(document.activeElement === stay).toBe(true);
      stay.click();
      await choice;
    } finally {
      prompt.destroy();
      teardown(rig);
    }
  });
}
