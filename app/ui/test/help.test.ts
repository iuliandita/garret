import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { createHelpPanel, SHORTCUTS } from "../src/help";
import { createMenuBar } from "../src/menu-bar";
import { t } from "../src/i18n";

const SOURCE = join(import.meta.dir, "..", "src");

/** Every chord the panel claims, flattened and upper-cased for comparison. */
function claimed(): Set<string> {
  const all = new Set<string>();
  for (const group of SHORTCUTS) {
    for (const row of group.rows) all.add(row.keys.toUpperCase());
  }
  return all;
}

describe("the panel does not lie about the editor's keymap", () => {
  /** ProseMirror binding syntax -> the spelling this application shows a
   *  writer. `Mod` is Ctrl on this platform; the application is Linux-only by
   *  the 2026-07-26 scope decision, so there is no Cmd case to render. */
  function readable(binding: string): string {
    const parts = binding.split("-");
    const key = parts[parts.length - 1] ?? "";
    const modifiers = parts.slice(0, -1).map((m) => (m === "Mod" ? "Ctrl" : m));
    // ProseMirror writes "Shift-Mod-z"; every menu and every other application
    // writes Ctrl before Shift.
    modifiers.sort((a, b) => (a === "Ctrl" ? -1 : b === "Ctrl" ? 1 : 0));
    return [...modifiers, key.toUpperCase()].join("+").toUpperCase();
  }

  /** Bindings that are real and deliberately NOT shown. Named one at a time, so
   *  a NEW binding added to the keymap fails this test rather than joining a
   *  silent exemption. */
  const UNLISTED: Record<string, string> = {
    "CTRL+Y": "a legacy alias for redo; Ctrl+Shift+Z is the one worth teaching",
  };

  test("every chord the editor binds is either shown or explicitly unlisted", () => {
    // THE POINT OF THIS FILE. help.ts restates chords it does not own: they are
    // arguments to a keymap() call, not exported values, so nothing can import
    // them. A binding that changes in editor.ts and not in help.ts leaves the
    // panel confidently telling a writer a lie, and NOTHING ELSE WOULD NOTICE --
    // no rendering difference, no failing gate, no screenshot that looks wrong.
    const editor = readFileSync(join(SOURCE, "editor.ts"), "utf8");
    // The keymap literal only; a match against the whole file would also catch
    // the word "Mod-z" in a comment and pass on prose.
    const keymaps = [...editor.matchAll(/keymap\(\{([^}]*)\}\)/g)].map((m) => m[1] ?? "");
    expect(keymaps.length).toBeGreaterThan(0);

    const bound = new Set<string>();
    for (const block of keymaps) {
      for (const match of block.matchAll(/"([^"]+)"\s*:/g)) {
        const binding = match[1];
        if (binding !== undefined) bound.add(readable(binding));
      }
    }
    // A vacuity guard: a regex that matched nothing would make every assertion
    // below trivially true.
    expect(bound.size).toBeGreaterThanOrEqual(4);

    const shown = claimed();
    const missing = [...bound].filter((chord) => !shown.has(chord) && UNLISTED[chord] === undefined);
    expect(missing).toEqual([]);
  });

  test("the unlisted allowlist has no dead entries", () => {
    // An exemption for a binding that no longer exists is an exemption that
    // would silently cover the NEXT binding to take that chord.
    const editor = readFileSync(join(SOURCE, "editor.ts"), "utf8");
    for (const chord of Object.keys(UNLISTED)) {
      const key = (chord.split("+").pop() ?? "").toLowerCase();
      expect(editor.toLowerCase()).toContain(`"mod-${key}"`);
    }
  });

  test("Ctrl+F is bound where the find bar says it is", () => {
    const find = readFileSync(join(SOURCE, "find-bar.ts"), "utf8");
    expect(claimed().has("CTRL+F")).toBe(true);
    // Not a keymap: the find bar listens on the document, so the chord is a
    // comparison rather than a key in an object literal.
    expect(find).toContain('event.key !== "f"');
    expect(find).toContain("event.ctrlKey");
  });

  test("the four Alt menu chords match the menu bar's own keys", () => {
    // 088: the bar names a catalog key per menu and the letter lives there.
    // `menu-accelerators.test.ts` pins the letter to the title in every
    // catalog; this is the panel's half, through the active catalog.
    const menu = readFileSync(join(SOURCE, "menu-bar.ts"), "utf8");
    const keys = [...menu.matchAll(/key:\s*t\("(menu\.[a-z]+\.key)"\)/g)].map((m) => t(m[1] ?? ""));
    expect(keys.length).toBe(4);
    const shown = claimed();
    for (const key of keys) expect(shown.has(`ALT+${key}`)).toBe(true);
  });
});

describe("the panel itself", () => {
  function mount(): { container: HTMLElement; panel: ReturnType<typeof createHelpPanel> } {
    const container = document.createElement("span");
    document.body.append(container);
    return { container, panel: createHelpPanel({ container }) };
  }

  test("it mounts hidden and opens on request", () => {
    const { container, panel } = mount();
    try {
      const element = container.querySelector<HTMLElement>("#help-panel");
      expect(element?.hidden).toBe(true);
      panel.open();
      expect(element?.hidden).toBe(false);
      expect(document.activeElement?.id).toBe("help-panel");
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("Escape inside the panel closes it", () => {
    const { container, panel } = mount();
    try {
      panel.open();
      const element = container.querySelector<HTMLElement>("#help-panel");
      element?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(element?.hidden).toBe(true);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("the groups flow inside #help-columns and the heading stays outside it (089)", () => {
    const { container, panel } = mount();
    try {
      const columns = container.querySelector<HTMLElement>("#help-panel > .panel-body > #help-columns");
      expect(columns).not.toBeNull();
      const groups = container.querySelectorAll("#help-panel .help-group, #help-panel .help-rows");
      expect(groups.length).toBe(SHORTCUTS.length * 2);
      const sections = columns?.querySelectorAll(":scope > .help-section") ?? [];
      expect(sections.length).toBe(SHORTCUTS.length);
      for (const section of sections) {
        expect(section.querySelectorAll(":scope > .help-group").length).toBe(1);
        expect(section.querySelectorAll(":scope > .help-rows").length).toBe(1);
      }
      expect(container.querySelector("#help-panel > .panel-header h2")).not.toBeNull();
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("every declared row is rendered as a term and a definition", () => {
    const { container, panel } = mount();
    try {
      const terms = container.querySelectorAll("#help-panel dt");
      const definitions = container.querySelectorAll("#help-panel dd");
      const rows = SHORTCUTS.reduce((n, group) => n + group.rows.length, 0);
      expect(rows).toBeGreaterThan(0);
      expect(terms.length).toBe(rows);
      expect(definitions.length).toBe(rows);
    } finally {
      panel.destroy();
      container.remove();
    }
  });

  test("destroy removes the panel from the container", () => {
    const { container, panel } = mount();
    panel.destroy();
    expect(container.querySelector("#help-panel")).toBeNull();
    container.remove();
  });
});

describe("the panel does not lie about the navigator's keys", () => {
  // The editor guard above exists because help.ts restates chords it cannot
  // import. The navigator is the SAME exposure and had no guard at all: its
  // keys are string literals in a keydown listener, a lookup table and a
  // switch, none of them exported. Writing this found four bindings the
  // application had never told anyone about - Space, Home/End, Page Up/Down and
  // type-ahead, the last of which is the fastest way through a long manuscript
  // and was undiscoverable since the navigator slice.
  const NAV = readFileSync(join(SOURCE, "navigator", "index.ts"), "utf8");

  /** DOM `key` values -> the spelling the panel shows. */
  const DISPLAY: Record<string, string> = {
    ArrowUp: "UP",
    ArrowDown: "DOWN",
    ArrowLeft: "LEFT",
    ArrowRight: "RIGHT",
    PageUp: "PAGE UP",
    PageDown: "PAGE DOWN",
    " ": "SPACE",
  };
  const display = (key: string): string => DISPLAY[key] ?? key.toUpperCase();

  /** The claimed chords broken into individual keys. A row reads
   *  "Home / End", so the set the panel actually claims is its tokens, not the
   *  whole string. */
  function claimedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const chord of claimed()) {
      for (const part of chord.split("/")) keys.add(part.trim());
    }
    return keys;
  }

  /** Every key the navigator binds, as the panel would have to spell it.
   *
   *  Three sources because the navigator has three: a lookup table for the
   *  Alt+Arrow moves, direct `event.key` comparisons in the listener, and a
   *  switch inside `nextIndex`. Missing any one of them would make this guard
   *  pass over a whole class of binding. */
  function bound(): Set<string> {
    const out = new Set<string>();
    const table = /const MOVE_KEYS[^{]*\{([^}]*)\}/.exec(NAV);
    if (table === null) throw new Error("MOVE_KEYS is no longer an object literal; this guard cannot read it");
    for (const match of (table[1] ?? "").matchAll(/(\w+)\s*:/g)) {
      // The table is only ever consulted under event.altKey.
      out.add(`ALT+${display(match[1] as string)}`);
    }
    for (const match of NAV.matchAll(/event\.key === "([^"]*)"/g)) {
      out.add(display(match[1] as string));
    }
    const jump = /function nextIndex[\s\S]*?\n\}/.exec(NAV);
    if (jump === null) throw new Error("nextIndex is no longer a function declaration; this guard cannot read it");
    for (const match of jump[0].matchAll(/case "([^"]*)"/g)) {
      out.add(display(match[1] as string));
    }
    return out;
  }

  test("every key the navigator binds is shown in the panel", () => {
    const keys = bound();
    // Vacuity guard: a regex that matched nothing would pass this test in
    // silence, which is the failure mode the editor guard's own `>= 4` exists
    // for. Eight is below the current count and above anything a broken parse
    // would produce.
    expect(keys.size).toBeGreaterThanOrEqual(8);
    const shown = claimedKeys();
    for (const key of keys) {
      expect(`${key} is bound by the navigator and must be in SHORTCUTS: ${shown.has(key)}`).toBe(
        `${key} is bound by the navigator and must be in SHORTCUTS: true`,
      );
    }
  });

  test("type-ahead is bound and the panel says so", () => {
    // Type-ahead has no key literal to parse - it is `key.length === 1`, every
    // printable character - so it cannot ride the guard above and needs its own
    // pair of assertions: that the navigator still does it, and that the panel
    // still names it.
    expect(NAV).toContain("typeAheadIndex");
    expect(claimedKeys().has("TYPE A TITLE")).toBe(true);
  });
});

describe("the help panel is actually in the document", () => {
  // The shortcuts panel shipped as the first place the application says
  // what any of its chords are, and it displayed NOTHING at first.
  // createHelpPanel appended it to #menu-controls and createMenuBar then called
  // container.replaceChildren() on that same element, detaching it - so
  // help.open() flipped `hidden` on a node in no document. Every unit test
  // passed (the element exists, the flag flips) and no gate could see it. A
  // screenshot found it.
  test("createMenuBar empties its container, which is why the order matters", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const earlier = document.createElement("p");
    container.append(earlier);
    expect(earlier.isConnected).toBe(true);

    // Captured and destroyed below: createMenuBar registers document-level
    // keydown and click listeners, and leaking them makes THIS test change the
    // behaviour of every later one in the run - which it did, by swallowing an
    // ArrowDown that menu-bar.test.ts asserts nothing handles.
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
      openPreferences: () => undefined,
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
      exportProject: () => undefined,
      exportAs: () => undefined,
      exportDocx: () => undefined,
      openEpubPreview: () => undefined,
      openPdfPreview: () => undefined,
      backupNow: () => undefined,
      importProject: () => undefined,
      openFind: () => undefined,
      openReplace: () => {},
      openHistory: () => {},
      openMirrorChanges: () => {},
      openComments: () => {},
      addComment: () => {},
      addToDictionary: () => {},
      navBack: () => {},
      navForward: () => {},
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
    });

    // The mechanism, stated as a test rather than as a comment: anything
    // appended to this container before the menu bar is built is gone.
    expect(earlier.isConnected).toBe(false);
    bar.destroy();
    container.remove();
  });

  test("main.ts builds the menu bar before the help panel", () => {
    // main.ts cannot be imported - it ends in `void main()` at module scope, so
    // importing it boots the page. Read and parsed, exactly as this file already
    // parses editor.ts and menu-bar.ts.
    const main = readFileSync(join(SOURCE, "main.ts"), "utf8");
    const menu = main.indexOf("createMenuBar({");
    const help = main.indexOf("createHelpPanel({");
    expect(menu).toBeGreaterThan(-1);
    expect(help).toBeGreaterThan(-1);
    expect(
      `createMenuBar before createHelpPanel: ${menu < help}`,
    ).toBe("createMenuBar before createHelpPanel: true");
  });
});

describe("the panel shows every group, in columns that grow down", () => {
  // Naming the navigator's keys took the panel past its 70vh cap and pushed
  // Delete and the whole Menus group below a scroll fold, so the groups went
  // into two columns. The columns then sat on the panel itself, beside its
  // max-height, and a multicol box with a constrained height does not scroll:
  // it spawns a third column SIDEWAYS, and the Menus group lived there,
  // off-screen, in both languages (089, found by a capture). happy-dom does no
  // layout, so this parses the stylesheet the way theme.test.ts does.
  const CSS = readFileSync(join(SOURCE, "..", "style.css"), "utf8");
  const block = (selector: string): string => {
    const at = CSS.indexOf(`\n${selector} {`);
    if (at < 0) throw new Error(`${selector} is not in style.css`);
    return CSS.slice(at, CSS.indexOf("}", at));
  };

  test("the columns are on #help-columns, which has no height; the panel scrolls", () => {
    expect(block("#help-columns")).toMatch(/column-count:\s*2/);
    expect(block("#help-columns")).not.toMatch(/max-height|\bheight:/);
    expect(block("#help-panel")).not.toContain("column-count");
    // The shell's body is what scrolls (238), and this one never sideways.
    expect(block(".panel-body")).toMatch(/overflow-y:\s*auto/);
    expect(block("#help-panel .panel-body")).toMatch(/overflow-x:\s*hidden/);
    expect(block("#help-panel .panel-body")).not.toContain("column-count");
  });

  test("a group and its rows cannot be split across a column break", () => {
    // A group title stranded at the foot of one column with its rows at the
    // head of the next reads as a heading for the wrong list.
    expect(block(".help-group")).toContain("break-after: avoid");
    expect(block(".help-rows")).toContain("break-inside: avoid");
  });
});

describe("the panel does not lie about the bars' own keys", () => {
  // The editor's chords and the navigator's are guarded above. The find bar and
  // the rename panel bind keys too - Enter commits a rename, Escape cancels it,
  // the find panel's arrows walk its results - and nothing checked them. This
  // is the same guard at a third and fourth surface: it does not prove the
  // CURRENT rows are right, it fails when a NEW key is bound and not shown.
  // Each is read with the panel shell, which binds their Escape since 238.
  const SURFACES = ["find-bar.ts", "rename-panel.ts"];
  const SHELL = "panel-shell.ts";

  /** Keys these files compare against, as the panel would spell them. */
  function boundIn(file: string): Set<string> {
    const source = readFileSync(join(SOURCE, file), "utf8");
    const out = new Set<string>();
    // `(?:===|!==)` spelled out: an earlier `(?:!)?==` matched `!==` and NOT
    // `===`, because the third `=` is not the space the pattern wanted next.
    // It found Enter, missed Escape, and the vacuity guard below is what
    // caught it - a partial regex is worse than none, because the keys it does
    // find make the test look like it is working.
    for (const match of source.matchAll(/event\.key\s*(?:===|!==)\s*"([^"]*)"/g)) {
      const key = match[1] as string;
      // Ctrl+F is the find bar's opener and is matched as a bare "f" beside an
      // event.ctrlKey test, so it cannot be read off the literal alone. It is
      // asserted by name in its own test above.
      if (key.length === 1) continue;
      out.add(key.startsWith("Arrow") ? key.slice(5).toUpperCase() : key.toUpperCase());
    }
    return out;
  }

  for (const file of SURFACES) {
    test(`every key ${file} binds is shown in the panel`, () => {
      const keys = new Set([...boundIn(file), ...boundIn(SHELL)]);
      // Vacuity guard: a regex matching nothing would pass in silence.
      expect(keys.size).toBeGreaterThanOrEqual(2);
      const shown = new Set<string>();
      for (const chord of claimed()) for (const part of chord.split("/")) shown.add(part.trim());
      for (const key of keys) {
        expect(`${file} binds ${key} and must show it: ${shown.has(key)}`).toBe(
          `${file} binds ${key} and must show it: true`,
        );
      }
    });
  }
});

describe("the two document-level chords are shown", () => {
  // Ctrl+F and Ctrl+P are bound on the DOCUMENT, in find-bar.ts and
  // quick-open.ts, not in the editor's keymap - so the chord guard that parses
  // editor.ts cannot see either of them. They are the two chords a writer is
  // most likely to reach for without being told, and the panel is the only place
  // the application says they exist.
  const DOCUMENT_CHORDS: { chord: string; source: string; key: string }[] = [
    { chord: "Ctrl+F", source: "app/ui/src/find-bar.ts", key: "f" },
    { chord: "Ctrl+P", source: "app/ui/src/quick-open.ts", key: "p" },
  ];

  for (const { chord, source, key } of DOCUMENT_CHORDS) {
    test(`${chord} is bound in ${source} and shown in the panel`, async () => {
      const text = await Bun.file(source).text();
      // Both halves, so neither can drift alone: the binding must exist in the
      // source AND the panel must name it. A test asserting only the panel would
      // pass for a chord nothing binds.
      expect(text).toContain(`event.key !== "${key}" && event.key !== "${key.toUpperCase()}"`);
      expect(text).toContain("document.addEventListener(\"keydown\"");
      expect(SHORTCUTS.some((group) => group.rows.some((row) => row.keys === chord))).toBe(true);
    });
  }
});

describe("Alt+Left and Alt+Right mean two things and the panel says both", () => {
  // These two keys are bound TWICE on purpose: the navigator outdents and
  // indents a row with them while the outline has focus, and project.ts walks
  // the navigation trail with them everywhere else. The navigator guard above
  // cannot see the second binding at all - it finds the chord in SHORTCUTS,
  // because the outline's own row is still there, and passes. So the panel could
  // lose the row that names back and forward and nothing would notice, which is
  // the exact failure this whole file exists to prevent.
  const PROJECT = readFileSync(join(SOURCE, "project.ts"), "utf8");

  const rowsFor = (keys: string): string[] =>
    SHORTCUTS.flatMap((group) => group.rows.filter((row) => row.keys === keys).map((row) => row.description));

  test("project.ts binds the chord on the document", () => {
    // Both halves, so neither can drift alone. A test asserting only the panel
    // would pass for a chord nothing binds.
    expect(PROJECT).toContain("historyChordOf(event)");
    expect(PROJECT).toContain('document.addEventListener("keydown", onHistoryChord)');
  });

  test("the panel carries a row for each meaning", () => {
    const descriptions = rowsFor("Alt+Left / Alt+Right");
    expect(descriptions.length).toBe(2);
    expect(descriptions.some((text) => /back and forward/i.test(text))).toBe(true);
    expect(descriptions.some((text) => /depth/i.test(text))).toBe(true);
  });

  test("the outline's row says when its meaning applies", () => {
    // Two rows with the same keys and no scope on either is a panel telling a
    // writer the same chord does two unrelated things, with nothing to decide
    // between them.
    const outline = rowsFor("Alt+Left / Alt+Right").find((text) => /depth/i.test(text));
    expect(outline).toContain("outline");
  });
});

describe("the context menu's chords are bound and shown", () => {
  // Shift+F10 and the Menu key cannot ride the navigator guard above. That guard
  // reads bare `event.key === "..."` literals and spells the chord as the key
  // alone, so an inline "F10" would demand a shortcuts row reading `F10` - a lie
  // about a chord that needs Shift. The predicate lives in its own module for
  // exactly that reason, which means it needs its own named guard here, the way
  // Ctrl+F and Alt+Left do.
  const CHORD = readFileSync(join(SOURCE, "nav-context-menu.ts"), "utf8");
  const NAVIGATOR = readFileSync(join(SOURCE, "navigator", "index.ts"), "utf8");

  test("both keys are in the predicate", () => {
    expect(CHORD).toContain('event.key === "ContextMenu"');
    expect(CHORD).toContain('event.key === "F10" && event.shiftKey');
  });

  test("the navigator calls the predicate", () => {
    // Both halves, so neither can drift alone: a panel row for a chord nothing
    // binds is the failure this file exists to prevent, and so is a binding
    // nothing shows.
    expect(NAVIGATOR).toContain("isContextMenuChord(event)");
  });

  test("the panel names them", () => {
    const rows = SHORTCUTS.flatMap((group) => group.rows).filter(
      (row) => row.keys === "Shift+F10 / Menu",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.description).toMatch(/context menu/i);
  });
});

describe("the outline's undo/redo chord is bound and shown (085)", () => {
  const NAVIGATOR = readFileSync(join(SOURCE, "navigator", "index.ts"), "utf8");

  test("the navigator's keydown handler answers Ctrl+Z and Ctrl+Y", () => {
    expect(NAVIGATOR).toContain("onUndo?.()");
    expect(NAVIGATOR).toContain("onRedo?.()");
  });

  test("the panel names the chord in the Outline group", () => {
    const outline = SHORTCUTS.find((group) => group.title === "Outline");
    expect(outline).not.toBeUndefined();
    const row = outline?.rows.find((r) => r.keys === "Ctrl+Z / Ctrl+Shift+Z");
    expect(row).not.toBeUndefined();
    expect(row?.description).toMatch(/undo|redo/i);
  });
});
