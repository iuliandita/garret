import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { t } from "../src/i18n";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createFindBar,
  type FindBar,
  type FindBarDeps,
  type FindHit,
  type FindResults,
} from "../src/find-bar";

/** A promise a test resolves by hand, so a search can be observed mid-flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Several ticks: a search runs drain and then the host, each a microtask hop. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function hit(over: Partial<FindHit> = {}): FindHit {
  return {
    item_id: "s1",
    title: "Arrival",
    kind: "scene",
    snippet: "she reached the inn at dusk",
    matches: 1,
    title_match: false,
    openable: true,
    ...over,
  };
}

function results(over: Partial<FindResults> = {}): FindResults {
  return { results: [hit()], total: 1, truncated: false, scanned: 3, skipped: 0, ...over };
}

interface Rig {
  container: HTMLElement;
  bar: FindBar;
  el: <T extends Element>(selector: string) => T;
  input: () => HTMLInputElement;
  status: () => string;
  rows: () => HTMLElement[];
  type: (value: string) => void;
  runSearch: () => void;
  /** What goes in the replace field, and the two buttons beside it. */
  replaceField: () => HTMLInputElement;
  typeReplacement: (value: string) => void;
  clickReplaceOne: () => void;
  clickReplaceAll: () => void;
  bookButton: () => HTMLButtonElement;
  clickReplaceBook: () => void;
  /** Every replace the unit asked for, with the arguments it passed. The QUERY
   *  is the point: Replace must act on the field beside the button, not on the
   *  query the rows below came from. */
  replacements: () => { kind: string; query: string; replacement: string }[];
  /** Every call the unit made, in the order it made them. An end-state
   *  assertion cannot see an ordering bug; this can. */
  calls: () => string[];
  queries: () => { query: string; limit: number }[];
  /** The PROBLEM channel: a failed drain, a failed search. */
  notices: () => string[];
  /** The GOOD NEWS channel. Kept apart from `notices` deliberately - a replace
   *  count used to go down the problem channel and be painted in the failure
   *  surface, and an assertion on one merged list could not see it. */
  dones: () => string[];
  opened: () => string[];
  openedWith: () => string[];
  selected: () => string[];
  /** How many times the panel asked the page to take focus back. A COUNT, not
   *  the element it landed on: the unit no longer owns a focus target, and
   *  printing a happy-dom node on failure is what kills the runner. */
  dismissals: () => number;
}

interface RigOptions {
  drain?: () => Promise<void>;
  find?: (query: string, limit: number) => Promise<FindResults>;
  /** Whether the single replace changed any text. False is the ordinary first
   *  press: a match got selected and nothing was written. */
  replaced?: boolean;
  /** How many occurrences replaceAll reports. 0 is the "none in this scene"
   *  answer and is a different status line, not a failure. */
  replacedAll?: number;
  /** How many matches replaceAll reports as LEFT because they cross a paragraph
   *  break. Replacing one of those would merge the two blocks. */
  spanningAll?: number;
  /** Whether the whole-manuscript replace is offered at all. The corpus path
   *  does not offer it, and the button must be ABSENT there rather than
   *  present and inert. */
  book?: boolean;
  /** What the host reports the manuscript-wide replace did. */
  bookResult?: { replaced: number; spanning: number; documents: number; snapshot: { label: string } };
  /** Make the manuscript-wide replace reject. */
  bookFails?: boolean;
}

let open: Rig | null = null;

function mount(options: RigOptions = {}): Rig {
  const container = document.createElement("span");
  document.body.appendChild(container);
  const calls: string[] = [];
  const queries: { query: string; limit: number }[] = [];
  const notices: string[] = [];
  const dones: string[] = [];
  const opened: string[] = [];
  // The query each open was told to reveal.
  const openedWith: string[] = [];
  const selectedIds: string[] = [];
  const replacements: { kind: string; query: string; replacement: string }[] = [];
  let dismissals = 0;

  const bar = createFindBar({
    container,
    drain: () => {
      calls.push("drain");
      return options.drain?.() ?? Promise.resolve();
    },
    find: (query, limit) => {
      calls.push("find");
      queries.push({ query, limit });
      return options.find?.(query, limit) ?? Promise.resolve(results());
    },
    openItem: (id, query) => {
      opened.push(id);
      openedWith.push(query);
    },
    selectItem: (id) => selectedIds.push(id),
    replaceMatch: (query, replacement) => {
      // Pushed onto BOTH lists: `calls` carries the ordering against drain and
      // find, which is what says whether a replace re-searches; `replacements`
      // carries the arguments.
      calls.push("replaceMatch");
      replacements.push({ kind: "replaceMatch", query, replacement });
      return options.replaced ?? true;
    },
    replaceAll: (query, replacement) => {
      calls.push("replaceAll");
      replacements.push({ kind: "replaceAll", query, replacement });
      return { replaced: options.replacedAll ?? 1, spanning: options.spanningAll ?? 0 };
    },
    replaceEverywhere:
      options.book === false
        ? undefined
        : (query, replacement) => {
            calls.push("replaceEverywhere");
            replacements.push({ kind: "replaceEverywhere", query, replacement });
            if (options.bookFails === true) return Promise.reject(new Error("no project is open"));
            return Promise.resolve(
              options.bookResult ?? {
                replaced: 47,
                spanning: 0,
                documents: 12,
                snapshot: { label: 'Before replacing "alpha" with "gamma"' },
              },
            );
          },
    onNotice: (message) => notices.push(message),
    onDone: (message) => dones.push(message),
    onDismiss: () => {
      dismissals++;
    },
  });

  const el = <T extends Element>(selector: string): T => {
    const found = container.querySelector(selector);
    if (found === null) throw new Error(`no ${selector} in the find bar`);
    return found as T;
  };

  const rig: Rig = {
    container,
    bar,
    el,
    input: () => el<HTMLInputElement>("#find-query"),
    status: () => el<HTMLElement>("#find-status").textContent ?? "",
    rows: () => [...container.querySelectorAll<HTMLElement>("#find-results [role=option]")],
    type: (value) => {
      el<HTMLInputElement>("#find-query").value = value;
    },
    runSearch: () =>
      el<HTMLButtonElement>("#find-run").dispatchEvent(new Event("click", { bubbles: true })),
    replaceField: () => el<HTMLInputElement>("#find-replace"),
    typeReplacement: (value) => {
      el<HTMLInputElement>("#find-replace").value = value;
    },
    clickReplaceOne: () =>
      el<HTMLButtonElement>("#find-replace-one").dispatchEvent(
        new Event("click", { bubbles: true }),
      ),
    clickReplaceAll: () =>
      el<HTMLButtonElement>("#find-replace-all").dispatchEvent(
        new Event("click", { bubbles: true }),
      ),
    bookButton: () => el<HTMLButtonElement>("#find-replace-book"),
    clickReplaceBook: () =>
      el<HTMLButtonElement>("#find-replace-book").dispatchEvent(
        new Event("click", { bubbles: true }),
      ),
    replacements: () => [...replacements],
    calls: () => [...calls],
    queries: () => [...queries],
    notices: () => [...notices],
    dones: () => [...dones],
    opened: () => [...opened],
    openedWith: () => [...openedWith],
    selected: () => [...selectedIds],
    dismissals: () => dismissals,
  };
  open = rig;
  return rig;
}

afterEach(() => {
  open?.bar.destroy();
  open?.container.remove();
  open = null;
});

describe("the find panel", () => {
  test("starts closed, and the strip holds the panel and nothing else", () => {
    // The toggle that used to sit in the bar was retired: Edit > Find and
    // Ctrl+F are the two routes in. A button re-added here would put a second
    // route back in the strip AND change the bar's line box, which is a
    // click-geometry constant in five rigs.
    const rig = mount();
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(true);
    expect([...rig.container.children].map((c) => c.id)).toEqual(["find-panel"]);
    expect(rig.container.querySelectorAll(":scope > button")).toHaveLength(0);
  });

  test("open() shows the panel and puts the caret in the query field", () => {
    // The menu's Find item calls this; Ctrl+F runs the same three lines. The
    // focus is the point of it - a panel that appears with the caret elsewhere
    // makes the writer click before they can type.
    const rig = mount();
    rig.input().value = "inn";
    rig.bar.open();

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
    expect(document.activeElement?.id).toBe("find-query");
    // Selected, not just focused: opening on an old query and typing should
    // replace it rather than append to it.
    expect(rig.input().selectionStart).toBe(0);
    expect(rig.input().selectionEnd).toBe(3);
  });

  test("openWith(query) fills the field, opens, and RUNS the search", async () => {
    // The bubble's Find in manuscript: the writer already selected the words,
    // so this route searches at once rather than making them press Search
    // again on a field it just filled for them.
    const rig = mount();
    rig.bar.openWith("harbor");

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
    expect(rig.input().value).toBe("harbor");
    await settle();
    expect(rig.queries()).toEqual([{ query: "harbor", limit: 200 }]);
  });

  test("replaces whatever the container held", () => {
    // The container is the page shell's, and a project switch hands the same
    // element to the next mount. Appending would leave two panels sharing one
    // set of ids.
    const container = document.createElement("span");
    document.body.appendChild(container);
    container.appendChild(document.createElement("b"));
    const bar = createFindBar({
      container,
      drain: () => Promise.resolve(),
      find: () => Promise.resolve(results()),
      openItem: () => undefined,
      selectItem: () => undefined,
      onNotice: () => undefined,
      onDone: () => undefined,
      onDismiss: () => undefined,
    });
    expect(container.querySelector("b")).toBeNull();
    bar.destroy();
    container.remove();
  });
});

describe("searching", () => {
  test("drains before invoking the host", async () => {
    const rig = mount();
    rig.type("inn");
    rig.runSearch();
    await settle();

    // project_find reads the STORE on its own connection. A host call made
    // before the drain searches a file missing whatever is still sitting in the
    // debounce -- and the writer searches for the sentence they just typed.
    expect(rig.calls()).toEqual(["drain", "find"]);
  });

  test("a drain rejection does not search", async () => {
    const rig = mount({ drain: () => Promise.reject(new Error("save failed")) });
    rig.type("inn");
    rig.runSearch();
    await settle();

    expect(rig.calls()).toEqual(["drain"]);
    expect(rig.notices()).toHaveLength(1);
    expect(rig.notices()[0]).toContain("save failed");
    expect(rig.dones()).toEqual([]);
  });

  test("an empty query never reaches the host", async () => {
    const rig = mount();
    rig.type("   ");
    rig.runSearch();
    await settle();

    // Matching the empty string would return the whole book. The host declines
    // it too; this avoids the round trip and the momentary searching status.
    expect(rig.calls()).toEqual([]);
    expect(rig.status()).toBe("");
    expect(rig.rows()).toHaveLength(0);
  });

  test("the query is trimmed and the cap is sent", async () => {
    const rig = mount();
    rig.type("  inn  ");
    rig.runSearch();
    await settle();

    expect(rig.queries()).toEqual([{ query: "inn", limit: 200 }]);
  });

  test("Enter in the field searches", async () => {
    const rig = mount();
    rig.type("inn");
    rig.input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await settle();

    expect(rig.calls()).toEqual(["drain", "find"]);
  });

  test("renders a row per hit, with the title and the snippet", async () => {
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({
            results: [
              hit({ item_id: "a", title: "Arrival", snippet: "the inn at dusk" }),
              hit({ item_id: "b", title: "Departure", snippet: "left the inn" }),
            ],
            total: 2,
          }),
        ),
    });
    rig.type("inn");
    rig.runSearch();
    await settle();

    const rows = rig.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.itemId).toBe("a");
    // AT-SPI exposes `id`, never `data-*`. Without this a graded rig could only
    // align probed rows by title, and 2,292 of the 20,000 stress items share
    // one -- the defect the navigator's `nav-row-<index>` ids exist to avoid.
    expect(rows[0]?.id).toBe("find-row-a");
    expect(rows[1]?.id).toBe("find-row-b");
    expect(rows[0]?.querySelector(".find-title")?.textContent).toBe("Arrival");
    expect(rows[0]?.querySelector(".find-snippet")?.textContent).toBe("the inn at dusk");
  });

  test("each row carries its own accessible name, because the spans are prunable", async () => {
    // WebKitGTK drops untyped generic containers -- the word-count slice found
    // #project-bar itself pruned. The two spans in a row are exactly that, so
    // the row's name is the only channel certain to reach a screen reader, and
    // it carries the item's TYPE, which the layout conveys only by position.
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({ results: [hit({ title: "Arrival", kind: "chapter", snippet: "the inn" })] }),
        ),
    });
    rig.type("inn");
    rig.runSearch();
    await settle();

    expect(rig.rows()[0]?.getAttribute("aria-label")).toBe("Arrival, chapter: the inn");
  });

  test("a title-only hit shows its type, not its title a second time", async () => {
    // Found by screenshot: the first version repeated the title in the snippet
    // slot, so a matching part rendered the same string twice, one line under
    // the other. The host now sends an empty snippet for a title-only hit.
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({
            results: [
              hit({ title: "The Winter Book", kind: "part", snippet: "", matches: 0, openable: false, title_match: true }),
            ],
          }),
        ),
    });
    rig.type("winter");
    rig.runSearch();
    await settle();

    const row = rig.rows()[0];
    expect(row?.querySelector(".find-title")?.textContent).toBe("The Winter Book");
    expect(row?.querySelector(".find-snippet")?.textContent).toBe("part");
    expect(row?.getAttribute("aria-label")).toBe("The Winter Book, part, title match");
  });

  test("reports the count, and says when the list is capped", async () => {
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit()], total: 4812, truncated: true })),
    });
    rig.type("the");
    rig.runSearch();
    await settle();

    // A truncation nobody is told about reads as completeness. Both figures
    // have to be on the line a screen reader announces.
    expect(rig.status()).toContain("4,812");
    expect(rig.status()).toContain("Showing 1 of");
  });

  test("an uncapped result set does not claim to be capped", async () => {
    // The failing direction. Without this, a status line that always said
    // "showing N of M" would satisfy the assertion above.
    const rig = mount({ find: () => Promise.resolve(results({ total: 1 })) });
    rig.type("inn");
    rig.runSearch();
    await settle();

    expect(rig.status()).not.toContain("Showing");
    expect(rig.status()).toContain("1 result for");
  });

  test("no matches says so rather than showing an empty list", async () => {
    const rig = mount({ find: () => Promise.resolve(results({ results: [], total: 0 })) });
    rig.type("zzzz");
    rig.runSearch();
    await settle();

    expect(rig.rows()).toHaveLength(0);
    expect(rig.status()).toContain("No matches");
    expect(rig.status()).toContain("zzzz");
  });

  test("a failure is reported and clears the stale list", async () => {
    // ONE rig across both searches, deliberately. An earlier version of this
    // test mounted a fresh bar for the failing search, so there was never a
    // stale list in it to clear -- and deleting `results.replaceChildren()`
    // from the failure path passed the whole suite. Found by mutation.
    let call = 0;
    const rig = mount({
      find: () => {
        call++;
        return call === 1
          ? Promise.resolve(results({ results: [hit()], total: 1 }))
          : Promise.reject(new Error("store gone"));
      },
    });

    rig.type("inn");
    rig.runSearch();
    await settle();
    expect(rig.rows()).toHaveLength(1);

    rig.type("inn again");
    rig.runSearch();
    await settle();

    // Leaving the previous results under a failed search shows the writer an
    // answer to a question nobody asked, under a line saying the search failed.
    expect(rig.rows()).toHaveLength(0);
    expect(rig.notices()).toHaveLength(1);
    expect(rig.notices()[0]).toContain("store gone");
    expect(rig.dones()).toEqual([]);
  });

  test("a failure is a notice, never a failure banner", async () => {
    // COMPILE-TIME. There is no latching banner on the dep surface at all, so a
    // later change reaching for raiseFailure cannot compile rather than merely
    // being wrong.
    const latching: Extract<keyof FindBarDeps, "raiseFailure" | "onFailure" | "onError">[] = [];
    expect(latching).toHaveLength(0);
    const deps: FindBarDeps = {
      container: document.createElement("span"),
      drain: () => Promise.resolve(),
      find: () => Promise.resolve(results()),
      openItem: () => undefined,
      selectItem: () => undefined,
      onNotice: () => undefined,
      onDone: () => undefined,
      onDismiss: () => undefined,
    };
    expect(Object.keys(deps).sort()).toEqual([
      "container",
      "drain",
      "find",
      "onDismiss",
      "onDone",
      "onNotice",
      "openItem",
      "selectItem",
    ]);
  });

  test("an older search that resolves late does not overwrite a newer one", async () => {
    // Not a nicety. The reader would see an older result set land under a newer
    // query's summary line, describing neither.
    const first = deferred<FindResults>();
    let call = 0;
    const rig = mount({
      find: () => {
        call++;
        return call === 1
          ? first.promise
          : Promise.resolve(results({ results: [hit({ item_id: "new" })], total: 1 }));
      },
    });

    rig.type("old");
    rig.runSearch();
    await settle();
    rig.type("new");
    rig.runSearch();
    await settle();

    first.resolve(results({ results: [hit({ item_id: "stale" })], total: 99 }));
    await settle();

    expect(rig.rows()).toHaveLength(1);
    expect(rig.rows()[0]?.dataset.itemId).toBe("new");
    expect(rig.status()).not.toContain("99");
  });
});

describe("activating a result", () => {
  test("an openable hit opens it, and the panel gets out of the way", async () => {
    // AMENDED. The panel used to stay open, decided when activating a result
    // took the writer to the top of a scene. It now puts the caret on the word,
    // and the panel covers most of the prose column - so staying up hides the
    // thing that was just asked for.
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit({ item_id: "s7", openable: true })] })),
    });
    rig.bar.open();
    rig.type("inn");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.opened()).toEqual(["s7"]);
    expect(rig.selected()).toEqual([]);
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(true);
  });

  test("closing on activation keeps the query and the results for the next one", async () => {
    // What makes the amendment above cheap rather than a regression: the reason
    // the panel used to stay open was that working through several results
    // should not mean searching again. setOpen only toggles `hidden`, so Ctrl+F
    // brings the same list straight back and the next result is one arrow away.
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({
            results: [
              hit({ item_id: "s7", openable: true }),
              hit({ item_id: "s8", openable: true }),
            ],
          }),
        ),
    });
    rig.type("inn");
    rig.runSearch();
    await settle();
    const searchesBefore = rig.queries().length;

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));
    rig.bar.open();

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
    expect(rig.input().value).toBe("inn");
    expect(rig.rows()).toHaveLength(2);
    expect(rig.queries()).toHaveLength(searchesBefore);
  });

  test("a hit that cannot be opened selects its row instead", async () => {
    // A part or a chapter holds no document. Hiding it from the results would
    // be worse: the writer's chapter title genuinely matched.
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({ results: [hit({ item_id: "c3", kind: "chapter", openable: false })] }),
        ),
    });
    // Opened first, or the assertion below passes on a panel that was never
    // open and says nothing about what activation did to it.
    rig.bar.open();
    rig.type("inn");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.opened()).toEqual([]);
    expect(rig.selected()).toEqual(["c3"]);
    // STAYS OPEN, unlike an openable hit: nothing opened and the editor did not
    // move, so there is nothing behind the panel to look at and closing it
    // would read as though something had happened.
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
  });

  test("activation marks exactly one row selected", async () => {
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({
            results: [hit({ item_id: "a" }), hit({ item_id: "b" })],
            total: 2,
          }),
        ),
    });
    rig.type("inn");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));
    rig.rows()[1]?.dispatchEvent(new Event("click", { bubbles: true }));

    const selected = rig.rows().map((r) => r.getAttribute("aria-selected"));
    expect(selected).toEqual(["false", "true"]);
  });

  test("a click that lands on the snippet still activates the row", async () => {
    // The listener is delegated and the row has children; matching on the event
    // target alone would make half of every row inert.
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit({ item_id: "s9" })] })),
    });
    rig.type("inn");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.querySelector(".find-snippet")?.dispatchEvent(
      new Event("click", { bubbles: true }),
    );

    expect(rig.opened()).toEqual(["s9"]);
  });
});

/** A real Escape keydown inside the panel, where the unit listens for it. */
function pressEscape(rig: Rig): void {
  rig.el<HTMLElement>("#find-panel").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

describe("the keyboard", () => {
  test("Ctrl+F opens the panel from anywhere in the page", () => {
    // On the document, not in the ProseMirror keymap: the keymap only fires
    // while the editor holds focus, and a writer in the navigator still expects
    // Ctrl+F.
    const rig = mount();
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
    // WebKit has its own find affordance on this chord; without this both open.
    expect(event.defaultPrevented).toBe(true);
  });

  test("a bare f does not open the panel", () => {
    // The failing direction: a handler that ignored the modifier would swallow
    // the letter f everywhere in the application, including mid-word.
    const rig = mount();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }),
    );
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(true);
  });

  test("Ctrl+Alt+F is not the find chord", () => {
    const rig = mount();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(true);
  });

  test("Escape closes the panel", () => {
    const rig = mount();
    rig.bar.open();
    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);

    pressEscape(rig);

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(true);
  });

  test("Escape asks the page to take focus back, exactly once", () => {
    // The toggle beside the panel was this unit's focus-return target and is
    // gone; the page decides now. Nothing calling onDismiss leaves focus on
    // <body>, where the writer's next keystroke reaches nothing - a worse
    // outcome than the button they lost. Counted, not asserted against an
    // element: this unit no longer knows where focus went.
    const rig = mount();
    rig.bar.open();
    expect(rig.dismissals()).toBe(0);

    pressEscape(rig);

    expect(rig.dismissals()).toBe(1);
  });

  test("only Escape dismisses the panel", () => {
    // The failing direction: a handler that dismissed on any key would throw
    // focus out of the query field on the writer's first letter.
    const rig = mount();
    rig.bar.open();

    rig.el<HTMLElement>("#find-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );

    expect(rig.el<HTMLElement>("#find-panel").hidden).toBe(false);
    expect(rig.dismissals()).toBe(0);
  });
});

describe("teardown", () => {
  test("destroy() removes the document-level Ctrl+F listener", () => {
    // THE ONE THAT MATTERS. Every other listener dies with the elements this
    // unit owns; this one is on the document and outlives them. A leaked copy
    // answers Ctrl+F after a project switch by focusing an input no longer in
    // the page, and accumulates one handler per switch.
    const rig = mount();
    const panel = rig.el<HTMLElement>("#find-panel");
    rig.bar.destroy();

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(panel.hidden).toBe(true);
    expect(rig.container.children).toHaveLength(0);
  });

  test("a resolution after destroy() repaints nothing", async () => {
    const gate = deferred<FindResults>();
    const rig = mount({ find: () => gate.promise });
    rig.type("inn");
    rig.runSearch();
    await settle();
    const list = rig.el<HTMLElement>("#find-results");

    rig.bar.destroy();
    gate.resolve(results({ results: [hit()], total: 1 }));
    await settle();

    // The container belongs to the page shell; the next project mounts into it.
    expect(list.children).toHaveLength(0);
    expect(rig.container.children).toHaveLength(0);
  });

  test("a rejection after destroy() reports nothing", async () => {
    const gate = deferred<FindResults>();
    const rig = mount({ find: () => gate.promise });
    rig.type("inn");
    rig.runSearch();
    await settle();

    rig.bar.destroy();
    gate.reject(new Error("store gone"));
    await settle();

    expect(rig.notices()).toEqual([]);
    expect(rig.dones()).toEqual([]);
  });

  test("destroy() is idempotent", () => {
    const rig = mount();
    rig.bar.destroy();
    expect(() => rig.bar.destroy()).not.toThrow();
  });
});

describe("activating a result: which word to jump to", () => {
  test("hands the open the query the results came from", async () => {
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit({ item_id: "s7", openable: true })] })),
    });
    rig.type("harbour");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.openedWith()).toEqual(["harbour"]);
  });

  test("hands over the query THESE rows are about, not what is in the field now", async () => {
    // A writer can keep typing without pressing Return. The rows on screen are
    // still the previous query's, so jumping to whatever is in the field would
    // put the caret on a word the row they clicked is not about - or, more
    // often, on nothing at all, which reads as the feature being broken.
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit({ item_id: "s7", openable: true })] })),
    });
    rig.type("harbour");
    rig.runSearch();
    await settle();
    rig.type("harbourmaster and then some");

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.openedWith()).toEqual(["harbour"]);
  });

  test("hands over the TRIMMED query, which is what was searched for", async () => {
    const rig = mount({
      find: () => Promise.resolve(results({ results: [hit({ item_id: "s7", openable: true })] })),
    });
    rig.type("  harbour  ");
    rig.runSearch();
    await settle();

    rig.rows()[0]?.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.openedWith()).toEqual(["harbour"]);
  });
});

/** A real keydown on the query field, cancelable so defaultPrevented carries
 *  information. */
function pressInput(rig: Rig, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  rig.input().dispatchEvent(event);
  return event;
}

describe("driving the results from the keyboard", () => {
  const twoHits = () =>
    Promise.resolve(
      results({
        results: [
          hit({ item_id: "s1", openable: true }),
          hit({ item_id: "s2", openable: true }),
        ],
      }),
    );

  async function searched() {
    const rig = mount({ find: twoHits });
    rig.type("harbour");
    rig.runSearch();
    await settle();
    return rig;
  }

  test("ArrowDown exposes the active option through the focused query combobox", async () => {
    // Focus stays in the query field, so aria-activedescendant is the only
    // channel that tells a screen reader which option is current.
    const rig = await searched();
    rig.bar.open();
    rig.input().focus();

    pressInput(rig, "ArrowDown");

    expect(document.activeElement === rig.input()).toBe(true);
    expect(rig.input().getAttribute("role")).toBe("combobox");
    expect(rig.input().getAttribute("aria-controls")).toBe("find-results");
    expect(rig.input().getAttribute("aria-expanded")).toBe("true");
    expect(rig.rows()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rig.input().getAttribute("aria-activedescendant")).toBe("find-row-s1");
    expect(rig.el("#find-results").hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("Enter opens the highlighted row instead of searching again", async () => {
    const rig = await searched();
    const searchesBefore = rig.queries().length;

    pressInput(rig, "ArrowDown");
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual(["s1"]);
    expect(rig.queries()).toHaveLength(searchesBefore);
  });

  test("Enter with nothing highlighted still searches", async () => {
    // The order matters to a writer: type, Enter, arrow, Enter. Breaking the
    // first Enter to make the second work would be a bad trade.
    const rig = await searched();
    const searchesBefore = rig.queries().length;

    pressInput(rig, "Enter");
    // The search path is async; asserting before it settles reads as "Enter did
    // nothing", which is also what a broken fallback looks like.
    await settle();

    expect(rig.opened()).toEqual([]);
    expect(rig.queries().length).toBeGreaterThan(searchesBefore);
  });

  test("ArrowDown twice reaches the second row", async () => {
    const rig = await searched();

    pressInput(rig, "ArrowDown");
    pressInput(rig, "ArrowDown");
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual(["s2"]);
  });

  test("the highlight CLAMPS at the ends rather than wrapping", async () => {
    // A writer holding ArrowDown through 200 results should stop at the last
    // one, not reappear at the top having lost their place.
    const rig = await searched();

    for (let i = 0; i < 5; i++) pressInput(rig, "ArrowDown");
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual(["s2"]);
  });

  test("ArrowUp from nothing highlights the LAST row", async () => {
    const rig = await searched();

    pressInput(rig, "ArrowUp");
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual(["s2"]);
  });

  test("a new search clears the highlight, so Enter searches again", async () => {
    // Otherwise the highlight names a row that is gone - or one at the same
    // ordinal describing a different scene, which is worse because it opens.
    const rig = await searched();
    pressInput(rig, "ArrowDown");

    rig.type("crate");
    rig.runSearch();
    await settle();

    expect(rig.el("#find-results").hasAttribute("aria-activedescendant")).toBe(false);
    const searchesBefore = rig.queries().length;
    pressInput(rig, "Enter");
    await settle();
    expect(rig.opened()).toEqual([]);
    expect(rig.queries().length).toBeGreaterThan(searchesBefore);
  });

  test("the arrow keys are consumed, so the field's caret does not move", async () => {
    const rig = await searched();

    expect(pressInput(rig, "ArrowDown").defaultPrevented).toBe(true);
    expect(pressInput(rig, "ArrowUp").defaultPrevented).toBe(true);
  });

  test("arrowing with no results at all does nothing and does not throw", async () => {
    const rig = mount({ find: () => Promise.resolve(results({ results: [] })) });
    rig.type("nothing");
    rig.runSearch();
    await settle();

    expect(() => pressInput(rig, "ArrowDown")).not.toThrow();
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual([]);
  });

  test("a non-openable row selects rather than opens, from the keyboard too", async () => {
    // The mouse and the keyboard go through one activate(), which is what stops
    // them drifting apart.
    const rig = mount({
      find: () =>
        Promise.resolve(
          results({ results: [hit({ item_id: "c3", kind: "chapter", openable: false })] }),
        ),
    });
    rig.type("harbour");
    rig.runSearch();
    await settle();

    pressInput(rig, "ArrowDown");
    pressInput(rig, "Enter");

    expect(rig.opened()).toEqual([]);
    expect(rig.selected()).toEqual(["c3"]);
  });
});

describe("replacing in the open scene", () => {
  /** A rig with a rendered result list behind it, which is the state a writer
   *  is actually in when they reach for Replace. */
  async function searched(options: RigOptions = {}): Promise<Rig> {
    const rig = mount(options);
    rig.type("alpha");
    rig.runSearch();
    await settle();
    return rig;
  }

  test("the panel holds a replace field and two buttons that say WHERE they act", () => {
    // A writer must not be able to read "All in scene" as "in the manuscript".
    // Replace-all is the most destructive single action a writing application
    // offers and this one is deliberately scoped to the open scene, so the
    // scope has to be on the control -- in the visible label AND in the
    // accessible name, because those are two different readers.
    const rig = mount();

    expect(rig.replaceField().id).toBe("find-replace");
    expect(rig.replaceField().getAttribute("aria-label")).toBe(t("find.replace.label"));
    expect(rig.replaceField().placeholder).toBe("");
    expect(rig.input().labels?.[0]?.textContent).toBe(t("find.query.label"));
    rig.replaceField().value = "Dracula";
    expect(rig.replaceField().labels?.[0]?.textContent).toBe(t("find.replace.label"));

    const one = rig.el<HTMLButtonElement>("#find-replace-one");
    const all = rig.el<HTMLButtonElement>("#find-replace-all");
    expect(one.textContent).toBe("Replace");
    expect(all.textContent).toBe("All in scene");
    expect(one.getAttribute("aria-label")).toBe("Replace this occurrence in the open scene");
    expect(all.getAttribute("aria-label")).toBe("All in scene: replace every occurrence in the open scene");
    const panel = rig.el<HTMLElement>("#find-panel");
    const heading = rig.el<HTMLElement>("#find-heading");
    expect(panel.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(panel.hasAttribute("aria-label")).toBe(false);
    expect(heading.textContent).toBe(t("find.title"));

    // The claim above, stated as the thing that must not be lost: both names
    // name the scene, and neither says "manuscript".
    for (const name of [one.getAttribute("aria-label"), all.getAttribute("aria-label")]) {
      expect(name).toContain("in the open scene");
      expect(name).not.toContain("manuscript");
    }
    // Buttons, not submits: the panel is not a form and a submit would reload
    // the page under a webview that has nowhere to reload to.
    expect(one.type).toBe("button");
    expect(all.type).toBe("button");
  });

  test("Replace acts on the LIVE query field, not on the query the rows came from", () => {
    // The opposite rule from a row click, and deliberately so. A row click uses
    // the query THOSE rows are about, so the caret lands on the word the row
    // describes. A button beside a box reading "beta" must replace beta: the
    // writer edited the box, can see what it says, and nothing on screen would
    // explain a press that acted on the previous word instead.
    return searched().then((rig) => {
      rig.type("beta");
      rig.typeReplacement("gamma");

      rig.clickReplaceOne();

      expect(rig.replacements()).toEqual([
        { kind: "replaceMatch", query: "beta", replacement: "gamma" },
      ]);
    });
  });

  test("Replace all acts on the LIVE query field too", async () => {
    const rig = await searched();
    rig.type("beta");
    rig.typeReplacement("gamma");

    rig.clickReplaceAll();

    expect(rig.replacements()).toEqual([
      { kind: "replaceAll", query: "beta", replacement: "gamma" },
    ]);
  });

  test("the query is trimmed and the replacement is NOT", async () => {
    // The query is trimmed because that is what was searched for. The
    // replacement is the writer's text: a replacement of " -- " is three
    // characters of deliberate spacing, and trimming it would silently join two
    // words in their prose.
    const rig = await searched();
    rig.type("  beta  ");
    rig.typeReplacement("  gamma  ");

    rig.clickReplaceOne();

    expect(rig.replacements()).toEqual([
      { kind: "replaceMatch", query: "beta", replacement: "  gamma  " },
    ]);
  });

  test("an empty replacement is a deletion, not a reason to refuse", async () => {
    // The field left empty means "take this word out", which is an ordinary
    // edit. A guard treating it as unfilled would remove the only way to do it.
    const rig = await searched();

    rig.clickReplaceAll();

    expect(rig.replacements()).toEqual([
      { kind: "replaceAll", query: "alpha", replacement: "" },
    ]);
  });

  test("Replace all reports the count, and re-runs the search", async () => {
    const rig = await searched({ replacedAll: 3 });
    const before = rig.calls().length;
    rig.typeReplacement("beta");

    rig.clickReplaceAll();

    // THE STATUS LINE NEVER SHOWS THE COUNT. `search()` writes the catalog
    // searching status, including its ellipsis,
    // synchronously, before its first await, so the count is gone in the same
    // tick it was written -- no writer ever sees it there. That is what the
    // notice is for, and it is the only channel that reports the one number
    // this action produces.
    expect(rig.status()).toBe(t("find.searching"));
    // GOOD NEWS, so it goes down onDone. It used to go down onNotice, which
    // raised the same undismissable red alert bar as a failed save.
    expect(rig.dones()).toEqual(["Replaced 3 occurrences in this scene."]);
    expect(rig.notices()).toEqual([]);

    await settle();
    // ONE deliberate action, so the list should be about the manuscript as it
    // is now -- and the drain the search performs is wanted anyway.
    expect(rig.calls().slice(before)).toEqual(["replaceAll", "drain", "find"]);
  });

  test("one occurrence is reported in the singular", async () => {
    const rig = await searched({ replacedAll: 1 });

    rig.clickReplaceAll();

    expect(rig.dones()).toEqual(["Replaced 1 occurrence in this scene."]);
    expect(rig.notices()).toEqual([]);
  });

  test("a large count is grouped, like every other figure in the chrome", async () => {
    const rig = await searched({ replacedAll: 1200 });

    rig.clickReplaceAll();

    expect(rig.dones()).toEqual(["Replaced 1,200 occurrences in this scene."]);
    expect(rig.notices()).toEqual([]);
  });

  test("no occurrences says so, and does NOT re-search", async () => {
    // Nothing changed, so re-listing would pay a drain and a whole-manuscript
    // scan to render the same rows -- and would replace the one line that says
    // why the press appeared to do nothing.
    const rig = await searched({ replacedAll: 0 });
    const before = rig.calls().length;

    rig.clickReplaceAll();
    await settle();

    expect(rig.status()).toBe('No occurrences of "alpha" in this scene.');
    expect(rig.calls().slice(before)).toEqual(["replaceAll"]);
    // No banner either, down EITHER channel: nothing happened, and one for it
    // would train the writer to ignore the channel that reports the counts that
    // matter.
    expect(rig.notices()).toEqual([]);
    expect(rig.dones()).toEqual([]);
  });

  test("Replace does NOT re-run the search", async () => {
    // The writer is stepping through occurrences one press at a time. Re-listing
    // on every press moves the rows under them and costs a drain and a scan per
    // word.
    const rig = await searched();
    const before = rig.calls().length;

    rig.clickReplaceOne();
    rig.clickReplaceOne();
    await settle();

    expect(rig.calls().slice(before)).toEqual(["replaceMatch", "replaceMatch"]);
  });

  test("a press that replaced something says so and points at the stale list", async () => {
    const rig = await searched({ replaced: true });

    rig.clickReplaceOne();

    expect(rig.status()).toContain("Replaced one occurrence in this scene");
    // AND the search summary is restated rather than written over. That line is
    // the only channel reporting the 200-result cap, so a replace that destroyed
    // it would leave a truncated list on screen reading as a complete one.
    expect(rig.status()).toContain('for “alpha”');
  });

  test("a press that only selected a match tells the writer to press again", async () => {
    // The ordinary FIRST press. Reporting it as a failure would be wrong -- a
    // match is now selected and the next press acts on it -- and reporting it as
    // a replacement would be a lie about the writer's prose.
    const rig = await searched({ replaced: false });

    rig.clickReplaceOne();

    expect(rig.status()).toContain(
      "Nothing replaced. Press Replace again to change the occurrence now selected.",
    );
    // The search summary is restated rather than written over, for the same
    // reason it is after a successful press: that line is the only channel
    // reporting the 200-result cap.
    expect(rig.status()).toContain("for “alpha”");
  });

  test("neither button replaces with an empty query, and BOTH say why", () => {
    // Silence was the defect. Edit > Replace... lands the caret in the REPLACE
    // field and leaves the query alone, so on a fresh window the ordinary first
    // use of that menu item was: type the replacement, press Replace, watch
    // nothing happen at all.
    const rig = mount();
    rig.typeReplacement("gamma");

    rig.clickReplaceOne();
    expect(rig.replacements()).toEqual([]);
    expect(rig.status()).toContain("Type what to look for");

    rig.clickReplaceAll();
    expect(rig.replacements()).toEqual([]);
    expect(rig.status()).toContain("Type what to look for");
  });

  test("neither button replaces with a whitespace-only query, and both say why", () => {
    // Matching the empty string would mean replacing between every pair of
    // characters in the scene, which is not a search anyone asked for. Saying so
    // rather than returning silently is the whole of the fix here.
    const rig = mount();
    rig.type("   ");
    rig.typeReplacement("gamma");

    rig.clickReplaceOne();
    rig.clickReplaceAll();

    expect(rig.replacements()).toEqual([]);
    expect(rig.status()).toContain("Type what to look for");
  });

  test("destroy() removes both replace listeners", async () => {
    // The elements are detached by destroy(), and a listener still bound to a
    // detached button fires perfectly well when the element is dispatched to
    // directly -- so this is a real claim and not a restatement of the teardown.
    // A leaked handler would reach the PREVIOUS project's editor after a switch.
    const rig = await searched();
    const one = rig.el<HTMLButtonElement>("#find-replace-one");
    const all = rig.el<HTMLButtonElement>("#find-replace-all");
    const before = rig.replacements().length;

    rig.bar.destroy();
    one.dispatchEvent(new Event("click", { bubbles: true }));
    all.dispatchEvent(new Event("click", { bubbles: true }));

    expect(rig.replacements()).toHaveLength(before);
  });

  test("the replace controls survive a search, so the field is not cleared under the writer", async () => {
    // renderResults replaces the RESULTS list, not the panel. A writer who
    // types a replacement, presses Return to re-search and finds the field
    // empty has lost work they cannot see they lost.
    const rig = await searched();
    rig.typeReplacement("gamma");

    rig.runSearch();
    await settle();

    expect(rig.replaceField().value).toBe("gamma");
    expect(rig.el<HTMLElement>("#find-replace-one").id).toBe("find-replace-one");
  });
});

describe("matches that cross a paragraph break are reported, never hidden", () => {
  async function searched(options: RigOptions = {}): Promise<Rig> {
    const rig = mount(options);
    rig.type("alpha");
    rig.runSearch();
    await settle();
    return rig;
  }

  // Replacing across a block boundary MERGES the two paragraphs, so those
  // matches are left alone. A writer told "replaced 5" who can still see a
  // sixth highlighted has been misled, and the reason is not something they
  // could work out for themselves.
  test("the notice names how many were left and why", async () => {
    const rig = await searched({ replacedAll: 5, spanningAll: 2 });
    rig.clickReplaceAll();
    const notice = rig.dones().at(-1) ?? "";
    expect(notice).toContain("Replaced 5 occurrences");
    expect(notice).toContain("2 matches were left alone");
    expect(notice).toContain("paragraph break");
  });

  test("a single left-alone match reads in the singular", async () => {
    const rig = await searched({ replacedAll: 1, spanningAll: 1 });
    const notice = (rig.clickReplaceAll(), rig.dones().at(-1) ?? "");
    expect(notice).toContain("One match was left alone");
  });

  test("nothing is said about them when there are none", async () => {
    // The failing direction. Without it the clause could be appended always,
    // and the two tests above would still pass.
    const rig = await searched({ replacedAll: 5, spanningAll: 0 });
    rig.clickReplaceAll();
    expect(rig.dones().at(-1) ?? "").not.toContain("left alone");
  });

  test("all matches spanning a break is NOT reported as 'no occurrences'", async () => {
    // The scene DOES contain the phrase. Telling the writer it does not would
    // send them looking for a bug in the search.
    const rig = await searched({ replacedAll: 0, spanningAll: 3 });
    rig.clickReplaceAll();
    expect(rig.status()).toContain("3 matches were left alone");
    expect(rig.status()).not.toContain("No occurrences");
  });
});

describe("replacing throughout the manuscript", () => {
  const open = (rig: ReturnType<typeof mount>, query = "alpha"): void => {
    rig.bar.open();
    rig.type(query);
    rig.typeReplacement("gamma");
  };

  test("the button is ABSENT where the operation is not offered", () => {
    // The corpus path has no store. A control that could only fail is worse
    // than none, and an inert visible button is worse than both.
    const rig = mount({ book: false });
    expect(rig.bookButton().hidden).toBe(true);
  });

  test("the first press ASKS and does not replace", async () => {
    // This operation was refused earlier because it had no inverse; a writer who has
    // just been shown a result count is not in a position to have decided
    // beforehand.
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    await settle();
    expect(rig.calls()).not.toContain("replaceEverywhere");
    expect(rig.bookButton().textContent).toContain("Really");
  });

  test("the second press replaces, and the report names the snapshot", async () => {
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.clickReplaceBook();
    await settle();
    expect(rig.replacements().at(-1)).toEqual({
      kind: "replaceEverywhere",
      query: "alpha",
      replacement: "gamma",
    });
    const said = rig.dones().join(" ");
    expect(said).toContain("47 occurrences");
    expect(said).toContain("12 documents");
    // The writer did not choose the label, so it is repeated back to them: it
    // is their handle on the way back.
    expect(said).toContain('Before replacing "alpha" with "gamma"');
  });

  test("the report goes down the GOOD NEWS channel, never the failure surface", async () => {
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.clickReplaceBook();
    await settle();
    expect(rig.notices()).toEqual([]);
    expect(rig.dones().length).toBe(1);
  });

  test("matches left alone are counted and named, never folded into the total", async () => {
    const rig = mount({
      bookResult: {
        replaced: 5,
        spanning: 2,
        documents: 3,
        snapshot: { label: "Before replacing X with Y" },
      },
    });
    open(rig);
    rig.clickReplaceBook();
    rig.clickReplaceBook();
    await settle();
    const said = rig.dones().join(" ");
    expect(said).toContain("2 matches were left alone");
  });

  test("changing the QUERY retires the confirmation", async () => {
    // A confirmation that outlives what it was confirming is not a
    // confirmation: the writer armed it for one word and would rewrite another.
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.type("beta");
    rig.input().dispatchEvent(new Event("input", { bubbles: true }));
    rig.clickReplaceBook();
    await settle();
    expect(rig.calls()).not.toContain("replaceEverywhere");
    expect(rig.bookButton().textContent).toContain("Really");
  });

  test("changing the REPLACEMENT retires the confirmation", async () => {
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.typeReplacement("delta");
    rig.replaceField().dispatchEvent(new Event("input", { bubbles: true }));
    rig.clickReplaceBook();
    await settle();
    expect(rig.calls()).not.toContain("replaceEverywhere");
  });

  test("closing the panel retires the confirmation", async () => {
    // Otherwise the arm survives out of sight and the next single press on a
    // reopened panel rewrites the book, having asked nothing.
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.el<HTMLElement>("#find-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    rig.bar.open();
    rig.clickReplaceBook();
    await settle();
    expect(rig.calls()).not.toContain("replaceEverywhere");
  });

  test("an empty query is refused OUT LOUD before anything is armed", async () => {
    const rig = mount();
    rig.bar.open();
    rig.type("   ");
    rig.clickReplaceBook();
    await settle();
    expect(rig.calls()).not.toContain("replaceEverywhere");
    expect(rig.bookButton().textContent).not.toContain("Really");
    expect(rig.status()).not.toBe("");
  });

  test("the panel says it is working before it waits on the host", async () => {
    // The host holds the store mutex across a snapshot of every document and a
    // rewrite of every match. A panel that looked idle through that would read
    // as broken.
    const rig = mount();
    open(rig);
    rig.clickReplaceBook();
    rig.clickReplaceBook();
    expect(rig.status()).toContain("Replacing throughout the manuscript");
  });

  test("a failure says so and does not claim anything was replaced", async () => {
    const rig = mount({ bookFails: true });
    open(rig);
    rig.clickReplaceBook();
    rig.clickReplaceBook();
    await settle();
    expect(rig.dones()).toEqual([]);
    expect(rig.notices().join(" ")).toContain("Could not replace throughout the manuscript");
  });
});
