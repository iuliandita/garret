import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  coverTint,
  createLibrary,
  deskAndShelf,
  filterBooks,
  sortBooks,
  type Library,
  type LibraryBook,
  type LibraryDeps,
  type LibraryIdentity,
  type LibraryOverview,
  type LibraryWordsAnswer,
} from "../src/library";
import type { BookStats, LibraryMembership, MembershipEdit } from "../src/library-summary";

function book(over: Partial<LibraryBook> = {}): LibraryBook {
  return {
    path: "/lib/a.db",
    name: "A",
    modified_at: 1000,
    opened_at: null,
    identity_id: null,
    identity_name: null,
    book_id: null,
    series: null,
    universe: null,
    membership_error: null,
    cover: { state: "none", data_uri: null },
    error: null,
    missing: false,
    ...over,
  };
}

function overview(books: LibraryBook[], over: Partial<LibraryOverview> = {}): LibraryOverview {
  return { identities: [], selected_identity: null, vault_error: null, books, more: 0, took_ms: 12, ...over };
}

interface Rig {
  library: Library;
  answer: LibraryOverview;
  currentPath: string;
  opened: string[];
  created: Array<{ name: string; identityId: string | null }>;
  forgotten: string[];
  persisted: Array<string | null>;
  saved: Array<{ name: string; sort_name: string; bio: string }>;
  notices: string[];
  dones: string[];
  /** One resolver per path, so a test can hold a `bookWords` answer open and
   *  release it exactly when it wants to. */
  wordResolvers: Map<string, { resolve(a: LibraryWordsAnswer): void; reject(e: Error): void }>;
  openFails: Set<string>;
  membership: LibraryMembership;
  membershipSaves: Array<{ generation: number; edit: MembershipEdit }>;
  stats: Map<string, BookStats>;
  statResolvers: Map<string, (answer: BookStats) => void>;
}

function rig(): Rig {
  const state: Rig = {
    library: undefined as unknown as Library,
    answer: overview([]),
    currentPath: "",
    opened: [],
    created: [],
    forgotten: [],
    persisted: [],
    saved: [],
    notices: [],
    dones: [],
    wordResolvers: new Map(),
    openFails: new Set(),
    membership: { version: 1, series: null, universe: null },
    membershipSaves: [],
    stats: new Map(),
    statResolvers: new Map(),
  };
  const deps: LibraryDeps = {
    overview: async () => state.answer,
    bookStats: (path) => state.stats.has(path) ? Promise.resolve(state.stats.get(path)!)
      : new Promise<BookStats>((resolve) => { state.statResolvers.set(path, resolve); }),
    getMembership: async () => ({ generation: 1, membership: state.membership }),
    saveMembership: async (generation, edit) => {
      state.membershipSaves.push({ generation, edit });
      return state.membership;
    },
    bookWords: (path) =>
      new Promise<LibraryWordsAnswer>((resolve, reject) => {
        state.wordResolvers.set(path, { resolve, reject });
      }),
    openBook: async (path) => {
      if (state.openFails.has(path)) throw new Error(`could not open ${path}`);
      state.opened.push(path);
    },
    createBook: async (name, identityId) => {
      state.created.push({ name, identityId });
    },
    forget: async (path) => {
      state.forgotten.push(path);
    },
    saveIdentity: async (fields) => {
      state.saved.push(fields);
      const created: LibraryIdentity = { id: "i-new", name: fields.name, sort_name: fields.sort_name, bio: fields.bio };
      return [...state.answer.identities, created];
    },
    persistHomeIdentity: async (id) => {
      state.persisted.push(id);
    },
    currentPath: () => state.currentPath,
    onNotice: (message) => state.notices.push(message),
    onDone: (message) => state.dones.push(message),
  };
  state.library = createLibrary(deps);
  return state;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("pure helpers", () => {
  test("sortBooks: opened_at desc, never-opened after every opened book, then modified_at desc", () => {
    const a = book({ path: "a", opened_at: 20 });
    const b = book({ path: "b", opened_at: 10 });
    const c = book({ path: "c", opened_at: null, modified_at: 5 });
    const d = book({ path: "d", opened_at: null, modified_at: 50 });
    const sorted = sortBooks([c, a, d, b]).map((x) => x.path);
    expect(sorted).toEqual(["a", "b", "d", "c"]);
  });

  test("filterBooks: null is All, an id keeps only that identity's books", () => {
    const a = book({ path: "a", identity_id: "i1" });
    const b = book({ path: "b", identity_id: "i2" });
    const c = book({ path: "c", identity_id: null });
    expect(filterBooks([a, b, c], null).map((x) => x.path)).toEqual(["a", "b", "c"]);
    expect(filterBooks([a, b, c], "i1").map((x) => x.path)).toEqual(["a"]);
  });

  test("deskAndShelf: the desk is the most recent, the rest is the shelf", () => {
    const a = book({ path: "a", opened_at: 20 });
    const b = book({ path: "b", opened_at: 10 });
    const { desk, shelf } = deskAndShelf([b, a]);
    expect(desk?.path).toBe("a");
    expect(shelf.map((x) => x.path)).toEqual(["b"]);
  });

  test("deskAndShelf: an empty library has no desk", () => {
    expect(deskAndShelf([]).desk).toBeNull();
  });

  test("coverTint answers 1..6, differs between paths, and is stable", () => {
    const tints = new Set(["a", "b", "c", "d", "e", "f", "/x/one.db", "/x/two.db"].map(coverTint));
    for (const t of tints) {
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(6);
    }
    expect(tints.size).toBeGreaterThan(1);
    // FNV-1a over the path, pinned: a cover's tint must not change between
    // builds or the shelf reshuffles its colours on every update.
    expect(coverTint("/x/one.db")).toBe(6);
    expect(coverTint("/x/two.db")).toBe(2);
  });
});

describe("createLibrary", () => {
  test("open paints one desk and N-1 shelf tiles, plus the New book tile", async () => {
    const r = rig();
    r.answer = overview([
      book({ path: "a", name: "A", opened_at: 30 }),
      book({ path: "b", name: "B", opened_at: 20 }),
      book({ path: "c", name: "C", opened_at: 10 }),
    ]);
    r.library.open();
    await flush();
    const shelf = document.querySelectorAll("#library-shelf .shelf-tile");
    // Two real books on the shelf (A is the desk) plus the New book tile.
    expect(shelf.length).toBe(3);
    expect(document.getElementById("library-new-book-tile")).not.toBeNull();
    expect(document.querySelector("#library-desk h3")?.textContent).toBe("A");
    expect(document.getElementById("library")?.classList.contains("library-is-empty")).toBe(false);
    expect(document.getElementById("library-group-filters")?.hidden).toBe(false);
  });

  test("the wordmark leads the room and stays out of the accessible tree", () => {
    rig();
    const mark = document.getElementById("library-wordmark");
    expect(mark?.parentElement?.firstElementChild).toBe(mark);
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.textContent).toBe("");
  });

  test("the desk is the most recently opened book", async () => {
    const r = rig();
    r.answer = overview([book({ path: "old", name: "Old", opened_at: 1 }), book({ path: "new", name: "New", opened_at: 99 })]);
    r.library.open();
    await flush();
    expect(document.querySelector("#library-desk h3")?.textContent).toBe("New");
  });

  test("an empty library shows the empty sentence and no desk", async () => {
    const r = rig();
    r.answer = overview([]);
    r.library.open();
    await flush();
    expect(document.getElementById("library-empty")?.hidden).toBe(false);
    expect(document.getElementById("library-desk")?.children.length).toBe(0);
    expect(document.getElementById("library")?.classList.contains("library-is-empty")).toBe(true);
    expect(document.getElementById("library-group-filters")?.hidden).toBe(true);
    expect(document.getElementById("library-desk")?.hidden).toBe(true);
    expect(document.querySelector("#library > h3")?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("library-new-book-tile")?.textContent).toContain("New book");
  });

  test("selecting a pen name filters the shelf and persists the choice", async () => {
    const r = rig();
    r.answer = overview(
      [
        book({ path: "a", name: "A", identity_id: "i1", opened_at: 20 }),
        book({ path: "b", name: "B", identity_id: "i2", opened_at: 10 }),
      ],
      { identities: [{ id: "i1", name: "Ada", sort_name: "Ada", bio: "" }, { id: "i2", name: "Bram", sort_name: "Bram", bio: "" }] },
    );
    r.library.open();
    await flush();
    const pill = Array.from(document.querySelectorAll<HTMLButtonElement>(".pill")).find(
      (b) => b.textContent === "Ada",
    );
    expect(pill).toBeDefined();
    pill?.click();
    await flush();
    expect(r.persisted).toEqual(["i1"]);
    // Only Ada's book is on screen now -- as the desk, with nothing on the
    // shelf but the New book tile.
    expect(document.querySelector("#library-desk h3")?.textContent).toBe("A");
    const shelf = document.querySelectorAll("#library-shelf .shelf-tile");
    expect(shelf.length).toBe(1);
    expect(document.getElementById("library-new-book-tile")).not.toBeNull();
  });

  test("New book creates then opens, and pins the selected identity", async () => {
    const r = rig();
    r.answer = overview([], { selected_identity: "i1", identities: [{ id: "i1", name: "Ada", sort_name: "Ada", bio: "" }] });
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    const tile = document.getElementById("library-new-book-tile") as HTMLButtonElement;
    tile.click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "The Harbour";
    expect(input.closest("button") === null).toBe(true);
    expect(document.getElementById("library-new-book-create")?.textContent).toBe("Create");
    expect(document.activeElement === input).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(r.created).toEqual([{ name: "The Harbour", identityId: "i1" }]);
    expect(r.library.isOpen()).toBe(false);
  });

  test("the empty-library Create button uses the same book creation path", async () => {
    const r = rig();
    r.answer = overview([]);
    r.library.open();
    await flush();
    (document.getElementById("library-new-book-tile") as HTMLButtonElement).click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "The Harbour";
    (document.getElementById("library-new-book-create") as HTMLButtonElement).click();
    await flush();
    expect(r.created).toEqual([{ name: "The Harbour", identityId: null }]);
  });

  test("Escape cancels the new-book name and returns focus without closing the library", async () => {
    const r = rig();
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    (document.getElementById("library-new-book-tile") as HTMLButtonElement).click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "Discard this";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.library.isOpen()).toBe(true);
    expect(document.getElementById("library-new-book-name") === null).toBe(true);
    expect(document.activeElement?.id).toBe("library-new-book-tile");
    expect(r.created).toEqual([]);
    r.library.destroy();
  });

  test("blank or composing Enter does not create and repeated Enter creates once", async () => {
    const r = rig();
    r.library.open();
    await flush();
    (document.getElementById("library-new-book-tile") as HTMLButtonElement).click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.value = "The Harbour";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(r.created).toEqual([]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(r.created).toEqual([{ name: "The Harbour", identityId: null }]);
    r.library.destroy();
  });

  test("Escape with nothing open behind the screen does not close it", async () => {
    const r = rig();
    r.currentPath = "";
    r.library.open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.library.isOpen()).toBe(true);
  });

  test("Escape with a book open behind the screen closes it", async () => {
    const r = rig();
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.library.isOpen()).toBe(false);
  });

  test("a word count arrives late and paints into the tile", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", name: "A" })]);
    r.library.open();
    await flush();
    const resolver = r.wordResolvers.get("a");
    expect(resolver).toBeDefined();
    resolver?.resolve({ words: 42, took_ms: 5 });
    await flush();
    const meta = document.querySelector("#library-desk .desk-meta");
    expect(meta?.textContent).toContain("42");
  });

  test("a closed screen ignores a word count that arrives after it closed", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", name: "A" })]);
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    const before = document.querySelector("#library-desk .desk-meta")?.textContent;
    const resolver = r.wordResolvers.get("a");
    r.library.close();
    resolver?.resolve({ words: 42, took_ms: 5 });
    await flush();
    // Reopen with a fresh, empty answer: if the stale resolve above had been
    // painted into anything, it could only have landed on the DOM this
    // reopen just replaced -- but the direct check is that the OLD desk
    // element's text never changed after close().
    const after = document.querySelector("#library-desk .desk-meta")?.textContent;
    expect(after).toBe(before);
    expect(after).not.toContain("42");
  });

  test("the close control starts hidden, before any overview answer has painted", () => {
    // A synchronous check, deliberately: `open()` calls `refresh()` but does
    // not await it, so this is what a writer's eyes meet in the frame before
    // the promise resolves. `paint()` is what later decides its visibility.
    const r = rig();
    const closeButton = document.getElementById("library-close") as HTMLButtonElement;
    expect(closeButton.hidden).toBe(true);
    void r; // constructed for its side effect of building the DOM
  });

  test("#library-timing carries the overview's own took_ms once it answers", async () => {
    const r = rig();
    r.answer = overview([], { took_ms: 37 });
    r.library.open();
    await flush();
    const timing = document.getElementById("library-timing");
    expect(timing?.textContent).toContain("37");
  });

  test("#library-timing carries the slowest word count seen so far, not an average", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", name: "A" }), book({ path: "b", name: "B", opened_at: 1 })]);
    r.library.open();
    await flush();
    r.wordResolvers.get("a")?.resolve({ words: 10, took_ms: 5 });
    await flush();
    r.wordResolvers.get("b")?.resolve({ words: 20, took_ms: 40 });
    await flush();
    const timing = document.getElementById("library-timing");
    expect(timing?.textContent).toContain("40");
    expect(timing?.textContent).not.toContain("5 ms");
  });

  test("the desk's title carries an id a rig can read before pressing Continue writing", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", name: "A Desk Book" })]);
    r.library.open();
    await flush();
    expect(document.getElementById("library-desk-title")?.textContent).toBe("A Desk Book");
  });

  test("saving a pen name announces it through onDone", async () => {
    const r = rig();
    r.answer = overview([]);
    r.library.open();
    await flush();
    document.getElementById("library-new-pen-name")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const name = document.getElementById("library-pen-name-name") as HTMLInputElement;
    name.value = "Ada Vane";
    document.getElementById("library-pen-name-save")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();
    expect(r.dones.some((d) => d.includes("Ada Vane"))).toBe(true);
  });

  test("creating a book announces it through onDone", async () => {
    const r = rig();
    r.answer = overview([]);
    r.library.open();
    await flush();
    const tile = document.getElementById("library-new-book-tile") as HTMLButtonElement;
    tile.click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "The Harbour";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(r.dones.some((d) => d.includes("The Harbour"))).toBe(true);
  });

  test("a large word count is grouped for display, plural category from the raw count", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", name: "A" })]);
    r.library.open();
    await flush();
    r.wordResolvers.get("a")?.resolve({ words: 16319, took_ms: 8 });
    await flush();
    const meta = document.querySelector("#library-desk .desk-meta");
    expect(meta?.textContent).toContain("16,319");
    expect(meta?.textContent).not.toContain("16319");
  });

  test("membership is saved only by the explicit button and Escape asks before discarding a dirty draft", async () => {
    const r = rig();
    r.currentPath = "/lib/a.db";
    r.answer = overview([book()]);
    r.library.open();
    await flush();
    document.getElementById("library-membership-open")?.click();
    await flush();
    const choice = document.querySelector<HTMLSelectElement>("#library-membership select")!;
    choice.value = "__new__";
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    const name = document.querySelector<HTMLInputElement>("#library-membership input")!;
    name.value = "Harbour";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(r.membershipSaves).toHaveLength(0);
    expect(document.getElementById("library-membership-discard")).not.toBeNull();
    const buttons = document.querySelectorAll<HTMLButtonElement>("#library-membership button");
    buttons[0].click();
    await flush();
    expect(r.membershipSaves[0]).toEqual({
      generation: 1, edit: { series: { kind: "new", name: "Harbour" }, universe: { kind: "none" } },
    });
  });

  test("summary reads saved books sequentially and a close drops a late answer", async () => {
    const r = rig();
    r.currentPath = "/lib/a.db";
    r.answer = overview([book({ path: "a", book_id: "a" }), book({ path: "b", book_id: "b" })], { more: 3 });
    r.library.open();
    await flush();
    document.getElementById("library-summary-toggle")?.click();
    await flush();
    expect([...r.statResolvers.keys()]).toEqual(["a"]);
    r.statResolvers.get("a")?.({
      book_id: "a", identity_id: null, membership: { version: 1, series: null, universe: null }, words: 12,
      unreadable_documents: 0, documents: 1, activity: null, activity_interrupted: false,
      activity_warning: null, read_at_ms: Date.now(), took_ms: 1,
    });
    await flush();
    expect(r.statResolvers.has("b")).toBe(true);
    r.library.close();
    r.statResolvers.get("b")?.({
      book_id: "b", identity_id: null, membership: { version: 1, series: null, universe: null }, words: 900,
      unreadable_documents: 0, documents: 1, activity: null, activity_interrupted: false,
      activity_warning: null, read_at_ms: Date.now(), took_ms: 1,
    });
    await flush();
    expect(document.getElementById("library-summary-result")?.textContent).toContain("12");
    expect(document.getElementById("library-summary-result")?.textContent).not.toContain("900");
    expect(document.getElementById("library-summary-coverage")?.textContent).toContain("3");
  });

  test("summary shows available activity only for books whose ledger answered", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", book_id: "a" }), book({ path: "b", book_id: "b" })]);
    r.stats.set("a", {
      book_id: "a", identity_id: null, membership: { version: 1, series: null, universe: null }, words: 10,
      unreadable_documents: 0, documents: 1, activity: {
        typing: { added: 5, deleted: 1 }, pasted: { added: 0, deleted: 0 },
        imported: { added: 0, deleted: 0 }, restored: { added: 0, deleted: 0 },
        unattributed: { added: 0, deleted: 0 },
      }, activity_interrupted: false, activity_warning: null, read_at_ms: Date.now(), took_ms: 1,
    });
    r.stats.set("b", {
      book_id: "b", identity_id: null, membership: { version: 1, series: null, universe: null }, words: 20,
      unreadable_documents: 0, documents: 2, activity: null,
      activity_interrupted: false, activity_warning: "unavailable", read_at_ms: Date.now(), took_ms: 1,
    });
    r.library.open();
    await flush();
    document.getElementById("library-summary-toggle")?.click();
    await flush();
    expect(document.getElementById("library-summary-result")?.textContent).toContain("30");
    expect(document.getElementById("library-summary-activity")?.textContent).toContain("1 of 2");
    expect(document.getElementById("library-summary-activity")?.textContent).toContain("+5/−1");
  });
  test("a changed pen-name pin is excluded and reported instead of counted in the old scope", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", book_id: "a", identity_id: "old" })], { selected_identity: "old" });
    r.stats.set("a", {
      book_id: "a", identity_id: "new", membership: { version: 1, series: null, universe: null }, words: 900,
      unreadable_documents: 0, documents: 1, activity: null, activity_interrupted: false,
      activity_warning: null, read_at_ms: Date.now(), took_ms: 1,
    });
    r.library.open();
    await flush();
    document.getElementById("library-summary-toggle")?.click();
    await flush();
    expect(document.getElementById("library-summary-result")?.textContent).not.toContain("900");
    expect(document.getElementById("library-summary-coverage")?.textContent).toBe("1 book could not be read. Not read yet.");
  });

  test("destroy invalidates a pending summary before another book is read", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", book_id: "a" }), book({ path: "b", book_id: "b" })]);
    r.library.open();
    await flush();
    document.getElementById("library-summary-toggle")?.click();
    await flush();
    r.library.destroy();
    r.statResolvers.get("a")?.({
      book_id: "a", identity_id: null, membership: { version: 1, series: null, universe: null }, words: 12,
      unreadable_documents: 0, documents: 1, activity: null, activity_interrupted: false,
      activity_warning: null, read_at_ms: Date.now(), took_ms: 1,
    });
    await flush();
    expect(r.statResolvers.has("b")).toBe(false);
  });

});
