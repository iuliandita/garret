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
import { createLibraryBookActions } from "../src/library-book-actions";
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
  browsed: Array<"import" | "restore">;
  created: Array<{ name: string; identityId: string | null }>;
  forgotten: string[];
  forgetFails: boolean;
  persisted: Array<string | null>;
  saved: Array<{ name: string; sort_name: string; bio: string }>;
  notices: string[];
  dones: string[];
  /** One resolver per path, so a test can hold a `bookWords` answer open and
   *  release it exactly when it wants to. */
  wordResolvers: Map<string, { resolve(a: LibraryWordsAnswer): void; reject(e: Error): void }>;
  openFails: Set<string>;
  openResult: boolean;
  pendingOpen: Promise<boolean> | null;
  pendingCreate: Promise<"opened" | "unattributed" | "unopened"> | null;
  createResult: "opened" | "unattributed" | "unopened";
  membership: LibraryMembership;
  membershipSaves: Array<{ generation: number; edit: MembershipEdit }>;
  stats: Map<string, BookStats>;
  statResolvers: Map<string, (answer: BookStats) => void>;
}

const mountedLibraries: Library[] = [];

function rig(overrides: Partial<LibraryDeps> = {}): Rig {
  const state: Rig = {
    library: undefined as unknown as Library,
    answer: overview([]),
    currentPath: "",
    opened: [],
    browsed: [],
    created: [],
    forgotten: [],
    forgetFails: false,
    persisted: [],
    saved: [],
    notices: [],
    dones: [],
    wordResolvers: new Map(),
    openFails: new Set(),
    openResult: true,
    pendingOpen: null,
    pendingCreate: null,
    createResult: "opened",
    membership: { version: 1, series: null, universe: null },
    membershipSaves: [],
    stats: new Map(),
    statResolvers: new Map(),
  };
  const deps: LibraryDeps = {
    openBooks: (focus) => state.browsed.push(focus),
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
      return state.pendingOpen ?? state.openResult;
    },
    createBook: async (name, identityId) => {
      state.created.push({ name, identityId });
      return state.pendingCreate ?? state.createResult;
    },
    forget: async (path) => {
      if (state.forgetFails) throw new Error("Library preference could not be saved");
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
  state.library = createLibrary({ ...deps, ...overrides });
  mountedLibraries.push(state.library);
  return state;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  for (const library of mountedLibraries.splice(0)) library.destroy();
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
  test("an empty library opens import and restore without creating a book", async () => {
    const r = rig();
    try {
      r.library.open();
      await flush();
      document.getElementById("library-import")?.click();
      expect(r.library.isOpen()).toBe(false);
      expect(r.browsed).toEqual(["import"]);
      r.library.open();
      await flush();
      document.getElementById("library-copies")?.click();
      expect(r.library.isOpen()).toBe(false);
      expect(r.browsed).toEqual(["import", "restore"]);
      expect(r.created).toEqual([]);
    } finally { r.library.destroy(); }
  });

  test("open paints one desk and N-1 shelf tiles, with New book above the desk", async () => {
    const r = rig();
    r.answer = overview([
      book({ path: "a", name: "A", opened_at: 30 }),
      book({ path: "b", name: "B", opened_at: 20 }),
      book({ path: "c", name: "C", opened_at: 10 }),
    ]);
    r.library.open();
    await flush();
    const shelf = document.querySelectorAll("#library-shelf .shelf-tile");
    // Only books belong on the shelf; creation stays above the desk.
    expect(shelf.length).toBe(2);
    expect(document.querySelector("#library-new-book-area")?.nextElementSibling?.id).toBe("library-existing-books");
    expect(document.querySelector("#library-existing-books")?.nextElementSibling?.id).toBe("library-desk");
    expect(document.getElementById("library-new-book-tile")).not.toBeNull();
    expect(document.querySelector("#library-desk h3")?.textContent).toBe("A");
    expect(document.getElementById("library")?.classList.contains("library-is-empty")).toBe(false);
    expect(document.getElementById("library-group-filters")?.hidden).toBe(false);
  });

  test("empty group filters hide independently while summary and membership remain available", async () => {
    const r = rig();
    r.currentPath = "/open/book.db";
    r.answer = overview([book({ series: { id: "series-1", name: "A series" } })]);
    r.library.open();
    await flush();
    expect(document.getElementById("library-series-filter")?.hidden).toBe(false);
    expect(document.getElementById("library-universe-filter")?.hidden).toBe(true);
    expect(document.getElementById("library-summary-toggle")?.hidden).toBe(false);
    expect(document.getElementById("library-membership-open")?.hidden).toBe(false);
  });

  test("shelf names separate title and byline and include late word counts", async () => {
    const r = rig();
    r.answer = overview([book({ path: "a", opened_at: 20 }), book({ path: "b", name: "Dracula", identity_name: "Bram Stoker", opened_at: 10 })]);
    r.library.open();
    await flush();
    const tile = document.querySelector<HTMLButtonElement>('#library-shelf button[data-path="b"]')!;
    expect(tile.getAttribute("aria-label")).toContain("Dracula · by Bram Stoker ·");
    r.wordResolvers.get("a")!.resolve({ words: 1, took_ms: 1 });
    await flush();
    r.wordResolvers.get("b")!.resolve({ words: 42, took_ms: 1 });
    await flush();
    expect(tile.getAttribute("aria-label")).toContain(" · 42 words");
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
    expect(shelf.length).toBe(0);
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
    const label = document.querySelector<HTMLLabelElement>('label[for="library-new-book-name"]');
    expect(label?.textContent).toBe("Book name");
    expect(label?.hidden).toBe(false);
    expect(input.parentElement?.className).toBe("field-with-label");
    input.value = "The Harbour";
    expect(input.closest("button") === null).toBe(true);
    expect(document.getElementById("library-new-book-create")?.textContent).toBe("Create");
    expect(document.activeElement === input).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(r.created).toEqual([{ name: "The Harbour", identityId: "i1" }]);
    expect(r.library.isOpen()).toBe(false);
  });

  test("a populated library has visible Create and Cancel controls", async () => {
    const r = rig();
    r.answer = overview([book()]);
    r.library.open();
    await flush();
    (document.getElementById("library-new-book-tile") as HTMLButtonElement).click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "Discard this";
    (document.getElementById("library-new-book-cancel") as HTMLButtonElement).click();
    expect(document.getElementById("library-new-book-name")).toBeNull();
    expect(document.activeElement?.id).toBe("library-new-book-tile");
    expect(r.created).toEqual([]);
    (document.getElementById("library-new-book-tile") as HTMLButtonElement).click();
    (document.getElementById("library-new-book-name") as HTMLInputElement).value = "The Harbour";
    (document.getElementById("library-new-book-create") as HTMLButtonElement).click();
    await flush();
    expect(r.created).toEqual([{ name: "The Harbour", identityId: null }]);
    r.library.destroy();
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
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(r.library.isOpen()).toBe(true);
  });

  test("Escape with a book open behind the screen closes it", async () => {
    const r = rig();
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
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

  for (const state of ["closed", "superseded", "current"] as const) {
    test(`an overview rejection reports only while its request is current (${state})`, async () => {
      let rejectOverview!: (error: Error) => void;
      const pending = new Promise<LibraryOverview>((_resolve, reject) => { rejectOverview = reject; });
      let requests = 0;
      const r = rig({ overview: () => requests++ === 0 ? pending : Promise.resolve(overview([book({ name: "Dracula" })])) });
      r.currentPath = "/open/book.db";
      r.library.open();
      await flush();
      if (state === "closed") r.library.close();
      if (state === "superseded") await r.library.refresh();
      rejectOverview(new Error("overview unavailable"));
      await flush();
      expect(r.notices).toHaveLength(state === "current" ? 1 : 0);
      if (state === "current") expect(r.notices[0]).toContain("overview unavailable");
      if (state === "superseded") expect(document.querySelector("#library-desk")?.textContent).toContain("Dracula");
    });
  }

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
    expect(timing?.getAttribute("aria-hidden")).toBe("true");
  });

  test("explicit diagnostics exposes the same host timing instrument", async () => {
    const r = rig({ diagnostics: true });
    r.answer = overview([], { took_ms: 37 });
    r.library.open();
    await flush();
    const timing = document.getElementById("library-timing");
    expect(timing?.getAttribute("aria-hidden")).toBe("false");
    expect(timing?.className).toBe("library-timing");
    expect(timing?.textContent).toBe("Overview 37 ms");
  });

  test("overflow guidance names the File menu command", async () => {
    const r = rig();
    r.answer = overview([book()], { more: 2 });
    r.library.open();
    await flush();
    expect(document.getElementById("library-more")?.textContent).toBe(
      "2 more books are not shown. Use File › Open book…",
    );
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
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
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


test("cover artwork is decorative beside the desk and shelf book metadata", async () => {
  const r = rig();
  r.answer = overview([
    book({ name: "Desk title", identity_name: "Desk author", opened_at: 20 }),
    book({ path: "/generated.db", name: "Shelf title", identity_name: "Shelf author", opened_at: 10 }),
    book({ path: "/pictured.db", name: "Picture title", identity_name: "Picture author",
      cover: { state: "present", data_uri: "data:image/png;base64,AA==" } }),
  ]);
  r.library.open();
  await flush();
  const deskCover = document.querySelector<HTMLElement>("#library-desk .cover")!;
  expect(deskCover.getAttribute("aria-hidden")).toBe("true");
  expect(deskCover.querySelector(".cover-title")?.textContent).toBe("Desk title");
  expect(document.getElementById("library-desk-title")?.textContent).toBe("Desk title");
  const shelfTiles = [...document.querySelectorAll<HTMLButtonElement>("#library-shelf button.shelf-tile")];
  expect(shelfTiles).toHaveLength(2);
  for (const tile of shelfTiles) {
    const cover = tile.querySelector<HTMLElement>(".cover")!;
    expect(cover.getAttribute("aria-hidden")).toBe("true");
    const exposedText = [...tile.querySelectorAll<HTMLElement>("span")]
      .filter((span) => !span.closest('[aria-hidden="true"]'))
      .map((span) => span.textContent);
    expect(exposedText.filter((text) => text === tile.querySelector(".shelf-title")?.textContent)).toHaveLength(1);
    expect(exposedText.filter((text) => text === tile.querySelector(".shelf-by")?.textContent)).toHaveLength(1);
  }
  expect(document.querySelector<HTMLImageElement>("#library-shelf .cover img")?.alt).toBe("");
});


describe("Library keyboard ownership", () => {
  test("entry isolates the covered editor, wraps Tab, and Escape restores focus", async () => {
    const editor = document.createElement("div");
    editor.id = "editor";
    const prose = document.createElement("div");
    prose.className = "ProseMirror";
    prose.tabIndex = 0;
    editor.append(prose);
    document.body.append(editor);
    prose.focus();
    const r = rig();
    r.currentPath = "/open/book.db";
    r.library.open();
    await flush();
    expect(editor.inert).toBe(true);
    expect(document.activeElement?.id).toBe("library");
    const first = document.querySelector<HTMLButtonElement>("#library .pill")!;
    const last = document.getElementById("library-copies")!;
    first.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement === last).toBe(true);
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(r.library.isOpen()).toBe(false);
    expect(editor.inert).toBe(false);
    expect(document.activeElement === prose).toBe(true);
  });

  for (const operation of ["open", "create"] as const) {
    test(`a pending ${operation} retains Tab focus with every Library control disabled`, async () => {
      const r = rig();
      r.answer = overview([book()]);
      const pendingOpen = Promise.withResolvers<boolean>();
      const pendingCreate = Promise.withResolvers<"opened" | "unattributed" | "unopened">();
      r.pendingOpen = pendingOpen.promise;
      r.pendingCreate = pendingCreate.promise;
      r.library.open();
      await flush();
      if (operation === "open") document.getElementById("library-continue")?.click();
      else {
        document.getElementById("library-new-book-tile")?.click();
        (document.getElementById("library-new-book-name") as HTMLInputElement).value = "Dracula";
        document.getElementById("library-new-book-create")?.click();
      }
      const root = document.getElementById("library")!;
      const controls = [...root.querySelectorAll<HTMLInputElement>("button, input, select, textarea")];
      expect(controls.length > 0).toBe(true);
      expect(controls.every((control) => control.disabled)).toBe(true);
      for (const keys of [
        { key: "Tab", shiftKey: false },
        { key: "Tab", shiftKey: true },
        { key: "Unidentified", code: "Tab", keyCode: 9, shiftKey: true },
      ]) {
        const tab = new KeyboardEvent("keydown", { ...keys, bubbles: true, cancelable: true });
        root.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(true);
        expect(document.activeElement?.id).toBe("library");
      }
      const composingTab = new KeyboardEvent("keydown", { key: "Tab", isComposing: true, bubbles: true, cancelable: true });
      root.dispatchEvent(composingTab);
      expect(composingTab.defaultPrevented).toBe(false);
      const prompt = document.createElement("button");
      prompt.id = "book-copy-prompt";
      document.body.append(prompt);
      prompt.focus();
      const promptTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      prompt.dispatchEvent(promptTab);
      expect(promptTab.defaultPrevented).toBe(false);
      expect(document.activeElement?.id).toBe("book-copy-prompt");
      if (operation === "open") pendingOpen.resolve(false);
      else pendingCreate.resolve("unopened");
      await flush();
      await flush();
      expect(document.activeElement?.id).toBe("book-copy-prompt");
    });
  }

  test("unavailable books keep Forget outside an interactive or disabled ancestor", async () => {
    const r = rig();
    r.answer = overview([book({ opened_at: 10 }), book({ path: "/missing.db", name: "Missing", missing: true })]);
    r.library.open();
    await flush();
    const forget = document.querySelector<HTMLButtonElement>("#library-shelf .shelf-forget")!;
    expect(forget.closest(".shelf-tile")?.tagName).toBe("DIV");
    expect(forget.parentElement?.closest("button, [disabled]") === null).toBe(true);
    forget.focus();
    expect(document.activeElement === forget).toBe(true);
    forget.click();
    await flush();
    expect(r.forgotten).toEqual(["/missing.db"]);
  });
});


test("refused open and create actions keep the Library available without success feedback", async () => {
  const r = rig();
  r.answer = overview([book()]);
  r.openResult = false;
  r.createResult = "unopened";
  r.library.open();
  await flush();
  document.getElementById("library-continue")?.click();
  await flush();
  expect(r.library.isOpen()).toBe(true);
  document.getElementById("library-new-book-tile")?.click();
  const input = document.getElementById("library-new-book-name") as HTMLInputElement;
  input.value = "New";
  document.getElementById("library-new-book-create")?.click();
  await flush();
  expect(r.library.isOpen()).toBe(true);
  expect(r.dones).toEqual([]);
});

test("an opened book with failed attribution closes without announcing complete success", async () => {
  const r = rig();
  r.createResult = "unattributed";
  r.library.open();
  await flush();
  document.getElementById("library-new-book-tile")?.click();
  (document.getElementById("library-new-book-name") as HTMLInputElement).value = "New";
  document.getElementById("library-new-book-create")?.click();
  await flush();
  expect(r.library.isOpen()).toBe(false);
  expect(r.dones).toEqual([]);
});


test("the unavailable most-recent book stays on the shelf with a working recovery action", async () => {
  const r = rig();
  r.answer = overview([book({ opened_at: 20, missing: true, name: "Missing" }), book({ path: "/available.db", opened_at: 10, name: "Available" })]);
  r.forgetFails = true;
  r.library.open();
  await flush();
  expect(document.getElementById("library-desk-title")?.textContent).toBe("Available");
  document.querySelector<HTMLButtonElement>("#library-shelf .shelf-forget")?.click();
  await flush();
  expect(r.notices).toEqual(["Library preference could not be saved"]);
  expect(document.querySelector("#library-shelf .shelf-forget") !== null).toBe(true);
  r.library.destroy();
});


for (const settles of ["success", "failure"] as const) {
  test(`opening a book reports busy and clears after ${settles}`, async () => {
    const r = rig();
    r.answer = overview([book({ name: "Pride and Prejudice" })]);
    r.currentPath = "/open/book.db";
    const pending = Promise.withResolvers<boolean>();
    r.pendingOpen = pending.promise;
    r.library.open();
    await flush();
    const root = document.getElementById("library")!;
    const status = document.getElementById("library-busy-status")!;
    const importButton = document.getElementById("library-import") as HTMLButtonElement;
    importButton.disabled = true;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    document.getElementById("library-continue")?.click();
    expect(root.dataset.busy).toBe("true");
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.closest('[aria-busy="true"]') === null).toBe(true);
    expect(document.getElementById("library-desk")?.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Opening book…");
    expect(root.querySelector("#library-heading")?.nextElementSibling === status).toBe(true);
    document.getElementById("library-continue")?.click();
    document.getElementById("library-import")?.click();
    document.getElementById("library-close")?.click();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    r.library.close();
    expect(r.library.isOpen()).toBe(true);
    expect(r.opened).toEqual(["/lib/a.db"]);
    expect(r.browsed).toEqual([]);
    await r.library.refresh();
    expect((document.getElementById("library-continue") as HTMLButtonElement).disabled).toBe(true);
    if (settles === "success") pending.resolve(true);
    else pending.reject(new Error("Book could not be opened"));
    await flush();
    expect(root.dataset.busy).toBe("false");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");
    expect(r.library.isOpen()).toBe(settles === "failure");
    expect(r.notices).toEqual(settles === "failure" ? ["Book could not be opened"] : []);
    expect((document.getElementById("library-continue") as HTMLButtonElement).disabled).toBe(false);
    expect(importButton.disabled).toBe(true);
  });
}

for (const settles of ["opened", "unopened", "failure"] as const) {
  test(`creating a book reports busy and clears after ${settles}`, async () => {
    const r = rig();
    r.currentPath = "/open/book.db";
    const pending = Promise.withResolvers<"opened" | "unattributed" | "unopened">();
    r.pendingCreate = pending.promise;
    r.library.open();
    await flush();
    document.getElementById("library-new-book-tile")?.click();
    const input = document.getElementById("library-new-book-name") as HTMLInputElement;
    input.value = "Alice's Adventures in Wonderland";
    document.getElementById("library-new-book-create")?.click();
    const root = document.getElementById("library")!;
    const status = document.getElementById("library-busy-status")!;
    expect(root.dataset.busy).toBe("true");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Creating book…");
    expect(input.disabled).toBe(true);
    expect(document.getElementById("library-new-book-area")?.getAttribute("aria-busy")).toBe("true");
    document.getElementById("library-new-book-cancel")?.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.getElementById("library-new-book-create")?.click();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    r.library.close();
    expect(r.library.isOpen()).toBe(true);
    expect(document.getElementById("library-new-book-name") === input).toBe(true);
    expect(r.created).toEqual([{ name: "Alice's Adventures in Wonderland", identityId: null }]);
    if (settles === "failure") pending.reject(new Error("Book could not be created"));
    else pending.resolve(settles);
    await flush();
    await flush();
    expect(root.dataset.busy).toBe("false");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");
    expect(r.library.isOpen()).toBe(settles !== "opened");
    expect(r.notices).toEqual(settles === "failure"
      ? [expect.stringContaining("Alice's Adventures in Wonderland")] : []);
    if (settles === "failure") expect(r.notices[0]).toContain("Book could not be created");
    expect(r.dones).toEqual(settles === "opened" ? ["Alice's Adventures in Wonderland created."] : []);
    expect(input.disabled).toBe(false);
  });
}


for (const error of [new Error("Permission denied"), "Storage unavailable"]) {
  test(`a create failure identifies the attempted title and ${typeof error === "string" ? "string" : "Error"} cause`, async () => {
    const r = rig({ createBook: async () => { throw error; } });
    r.library.open();
    await flush();
    document.getElementById("library-new-book-tile")?.click();
    (document.getElementById("library-new-book-name") as HTMLInputElement).value = "  Dracula  ";
    document.getElementById("library-new-book-create")?.click();
    await flush();
    await flush();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("Dracula");
    expect(r.notices[0]).toContain(error instanceof Error ? error.message : error);
    expect(r.dones).toEqual([]);
    expect(r.library.isOpen()).toBe(true);
    expect((document.getElementById("library-new-book-name") as HTMLInputElement).value).toBe("  Dracula  ");
  });
}

for (const result of ["refused", "failure"] as const) {
  test(`an ${result} open restores the initiating book control`, async () => {
    const r = rig();
    r.answer = overview([book({ name: "Pride and Prejudice" })]);
    const pending = Promise.withResolvers<boolean>();
    r.pendingOpen = pending.promise;
    r.library.open();
    await flush();
    const control = document.getElementById("library-continue")!;
    control.focus();
    control.click();
    expect(document.activeElement?.id).toBe("library");
    if (result === "failure") pending.reject(new Error("Book could not be opened"));
    else pending.resolve(false);
    await flush();
    expect(document.activeElement === control).toBe(true);
  });
}

for (const result of ["unopened", "failure"] as const) {
  test(`a ${result} create restores a useful control without losing the failed draft`, async () => {
    const r = rig();
    const pending = Promise.withResolvers<"opened" | "unattributed" | "unopened">();
    r.pendingCreate = pending.promise;
    r.library.open();
    await flush();
    document.getElementById("library-new-book-tile")?.click();
    (document.getElementById("library-new-book-name") as HTMLInputElement).value = "  Dracula  ";
    document.getElementById("library-new-book-create")?.click();
    expect(document.activeElement?.id).toBe("library");
    if (result === "failure") pending.reject(new Error("Book could not be created"));
    else pending.resolve("unopened");
    await flush();
    await flush();
    expect(document.activeElement?.id).toBe(result === "failure" ? "library-new-book-name" : "library-new-book-tile");
    if (result === "failure") expect((document.activeElement as HTMLInputElement).value).toBe("  Dracula  ");
    expect(r.created).toEqual([{ name: "Dracula", identityId: null }]);
  });
}

for (const operation of ["open", "create"] as const) {
  for (const changed of ["focus", "refresh", "privacy"] as const) {
    test(`a pending ${operation} does not restore focus after ${changed} changes`, async () => {
      const r = rig();
      r.answer = overview([book({ name: "Pride and Prejudice" })]);
      const pendingOpen = Promise.withResolvers<boolean>();
      const pendingCreate = Promise.withResolvers<"opened" | "unattributed" | "unopened">();
      r.pendingOpen = pendingOpen.promise;
      r.pendingCreate = pendingCreate.promise;
      r.library.open();
      await flush();
      if (operation === "open") document.getElementById("library-continue")?.click();
      else {
        document.getElementById("library-new-book-tile")?.click();
        (document.getElementById("library-new-book-name") as HTMLInputElement).value = "Dracula";
        document.getElementById("library-new-book-create")?.click();
      }
      const root = document.getElementById("library")!;
      if (changed === "focus") {
        const prompt = document.createElement("button");
        prompt.id = "book-copy-prompt";
        document.body.append(prompt);
        prompt.focus();
        root.focus();
      } else if (changed === "refresh") await r.library.refresh();
      else root.inert = true;
      if (operation === "open") pendingOpen.resolve(false);
      else pendingCreate.reject(new Error("Book could not be created"));
      await flush();
      await flush();
      expect(document.activeElement === root).toBe(true);
      expect(r.library.isOpen()).toBe(true);
    });
  }
}


for (const operation of ["open", "create"] as const) {
  test(`the real Library ${operation} adapter refreshes its switcher before restoring refusal focus`, async () => {
    const switchResult = Promise.withResolvers<"failed">();
    let switcherRefreshes = 0;
    const actions = createLibraryBookActions({
      invoke: async (command) => {
        if (command !== "project_create") throw new Error(`unexpected command ${command}`);
        return { path: "/lib/dracula.db", name: "Dracula" };
      },
      switchProject: () => switchResult.promise,
      // main.ts refreshes the separate Books switcher, not the Library overview.
      refresh: () => { switcherRefreshes++; },
      onNotice: () => {},
    });
    const r = rig(actions);
    r.answer = overview([book({ name: "Pride and Prejudice" })]);
    r.library.open();
    await flush();
    if (operation === "open") document.getElementById("library-continue")?.click();
    else {
      document.getElementById("library-new-book-tile")?.click();
      (document.getElementById("library-new-book-name") as HTMLInputElement).value = "Dracula";
      document.getElementById("library-new-book-create")?.click();
    }
    expect(switcherRefreshes).toBe(0);
    switchResult.resolve("failed");
    await flush();
    await flush();
    await flush();
    expect(switcherRefreshes).toBe(1);
    expect(r.library.isOpen()).toBe(true);
    expect(document.activeElement?.id).toBe(operation === "open" ? "library-continue" : "library-new-book-tile");
  });
}

for (const operation of ["open", "create"] as const) {
  test(`startup ${operation} focuses the visible mounted editor`, async () => {
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    const r = rig();
    r.answer = overview([book()]);
    r.library.open();
    await flush();
    const menu = document.createElement("button");
    menu.id = "app-menu";
    document.body.append(menu);
    const editor = document.createElement("div");
    editor.id = "editor";
    const hidden = document.createElement("div");
    hidden.hidden = true;
    const oldProse = document.createElement("div");
    oldProse.className = "ProseMirror";
    oldProse.tabIndex = 0;
    hidden.append(oldProse);
    const prose = document.createElement("div");
    prose.className = "ProseMirror";
    prose.tabIndex = 0;
    editor.append(hidden, prose);
    document.body.append(editor);
    if (operation === "open") document.getElementById("library-continue")?.click();
    else {
      document.getElementById("library-new-book-tile")?.click();
      (document.getElementById("library-new-book-name") as HTMLInputElement).value = "Dracula";
      document.getElementById("library-new-book-create")?.click();
    }
    await flush();
    expect(r.library.isOpen()).toBe(false);
    expect(document.activeElement === prose).toBe(true);
  });
}

test("manual Library dismissal returns to its originating control", async () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
  const r = rig();
  r.currentPath = "/open/book.db";
  r.library.open();
  await flush();
  r.library.close();
  expect(document.activeElement === origin).toBe(true);
});

test("a successful pending open preserves focus moved to a prompt", async () => {
  const r = rig();
  r.answer = overview([book()]);
  const pending = Promise.withResolvers<boolean>();
  r.pendingOpen = pending.promise;
  r.library.open();
  await flush();
  document.getElementById("library-continue")?.click();
  const prompt = document.createElement("button");
  prompt.id = "book-copy-prompt";
  document.body.append(prompt);
  prompt.focus();
  pending.resolve(true);
  await flush();
  expect(r.library.isOpen()).toBe(false);
  expect(document.activeElement === prompt).toBe(true);
});

test("opening another book returns focus to its editor instead of the Library origin", async () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
  const r = rig();
  r.currentPath = "/open/book.db";
  r.answer = overview([book()]);
  r.library.open();
  await flush();
  const editor = document.createElement("div");
  editor.id = "editor";
  const prose = document.createElement("div");
  prose.className = "ProseMirror";
  prose.tabIndex = 0;
  editor.append(prose);
  document.body.append(editor);
  document.getElementById("library-continue")?.click();
  await flush();
  expect(r.library.isOpen()).toBe(false);
  expect(document.activeElement === prose).toBe(true);
});


test("Library menu closes before actions, Escape returns to its opener, and global chords pass", async () => {
  const calls: string[] = [];
  const r = rig({ openPreferences: () => calls.push(String(r.library.isOpen())) });
  r.library.open();
  await flush();
  const opener = document.getElementById("library-menu")!;
  opener.click();
  expect(document.activeElement?.id).toBe("library-preferences");
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(r.library.isOpen()).toBe(true);
  expect(document.activeElement).toBe(opener);
  const heard: string[] = [];
  const listen = (event: KeyboardEvent): void => { heard.push(event.key); };
  document.addEventListener("keydown", listen);
  try {
    for (const key of ["=", "q", "f"]) opener.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }));
    expect(heard).toEqual(["=", "q"]);
  } finally { document.removeEventListener("keydown", listen); }
  opener.click();
  document.getElementById("library-preferences")?.click();
  expect(calls).toEqual(["false"]);
  expect(document.getElementById("library-menu-panel")?.hidden).toBe(true);
});

test("Library menu preserves dirty membership drafts and labels the identity choices", async () => {
  let called = false;
  const r = rig({ openHelp: () => { called = true; } });
  r.currentPath = "/lib/a.db";
  r.answer = overview([book()]);
  r.library.open();
  await flush();
  expect(document.querySelector(".pill-row")?.getAttribute("aria-labelledby")).toBe("library-writing-as");
  expect(document.querySelector(".pill-row")?.getAttribute("role")).toBe("group");
  document.getElementById("library-membership-open")?.click();
  await flush();
  const choice = document.querySelector<HTMLSelectElement>("#library-membership select")!;
  choice.value = "__new__";
  choice.dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("library-menu")?.click();
  document.getElementById("library-help")?.click();
  expect(called).toBe(false);
  expect(r.library.isOpen()).toBe(true);
  expect(document.getElementById("library-membership-discard")).not.toBeNull();
});
