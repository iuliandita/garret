// The navigator row's revision state: the mark, the attribute the stylesheet
// keys on, and the description a screen reader gets instead of a changed name.
//
// The DOM half is asserted as attributes and text, never through
// getComputedStyle: happy-dom does no layout and loads no stylesheet, so a
// computed-colour assertion passes for every implementation including none. The
// stylesheet half is read as TEXT, the way nav-row-type.test.ts and
// theme.test.ts read it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { t } from "../src/i18n";
import { createNavigator } from "../src/navigator/index";
import { REVISION_STATES, STATE_MARKS, stateDescriptionId } from "../src/revision-states";

function makeContainer(clientHeight = 400): HTMLElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  document.body.append(container);
  return container;
}

/** A walk whose states DISAGREE with both depth and type, for the reason
 *  `typedSource` disagrees with depth: a fixture where `done` is always the
 *  deepest row, or always the scene, cannot tell an implementation reading the
 *  store from one deriving the state from something else. */
function statedSource() {
  const items = [
    { id: "p-1", parent_id: null, title: "Part One", depth: 0, type: "part", state: "done" },
    { id: "c-1", parent_id: "p-1", title: "Ch A", depth: 1, type: "chapter", state: null },
    { id: "s-1", parent_id: "c-1", title: "Sc 1", depth: 2, type: "scene", state: "draft" },
    { id: "b-1", parent_id: "s-1", title: "Deep Part", depth: 3, type: "part", state: "outline" },
    { id: "p-2", parent_id: null, title: "Part Two", depth: 0, type: "part", state: "revising" },
  ];
  return {
    items,
    count: items.length,
    seed: "stated-v1",
    titleAt: (i: number) => items[i]!.title,
    idAt: (i: number) => items[i]!.id,
    depthAt: (i: number) => items[i]!.depth,
    typeAt: (i: number) => items[i]!.type,
    stateAt: (i: number) => items[i]!.state,
  };
}

const rowsIn = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll("[role='treeitem']")] as HTMLElement[];

const rowNamed = (container: HTMLElement, title: string): HTMLElement => {
  const row = rowsIn(container).find(
    (r) => r.querySelector(".nav-title")?.textContent === title,
  );
  if (row === undefined) throw new Error(`no row titled ${title}`);
  return row;
};

describe("a row wears its revision state", () => {
  test("the state comes from the source and reaches three places at once", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: statedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });

    const part = rowNamed(container, "Part One");
    expect(part.dataset.state).toBe("done");
    expect(part.querySelector(".nav-state")?.textContent).toBe(STATE_MARKS.done);
    expect(part.getAttribute("aria-describedby")).toBe(stateDescriptionId("done"));
    // The load-bearing one: a part at depth 3 inside a scene, marked `outline`
    // while the shallower rows are further along. Nothing about its depth or its
    // type predicts its state.
    const deep = rowNamed(container, "Deep Part");
    expect(deep.dataset.state).toBe("outline");
    expect(deep.querySelector(".nav-state")?.textContent).toBe(STATE_MARKS.outline);

    nav.destroy();
    container.remove();
  });

  test("an unmarked row shows nothing and describes nothing", () => {
    // Never a placeholder mark and never a description saying so: the row is a
    // title first, and a marker for "unset" on every row of a manuscript nobody
    // has marked is noise in the surface a writer scans. Same rule as an absent
    // word count rendering as nothing rather than 0.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: statedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });

    const unmarked = rowNamed(container, "Ch A");
    expect(unmarked.dataset.state).toBeUndefined();
    expect(unmarked.querySelector(".nav-state")?.textContent).toBe("");
    expect(unmarked.hasAttribute("aria-describedby")).toBe(false);

    nav.destroy();
    container.remove();
  });

  test("the row's accessible NAME is still exactly the title", () => {
    // Two graded rigs locate rows by name in the painted tree - menu-cli's
    // rowNamed, which additionally refuses a duplicate title, and the outline
    // run's alignment. A mark folded into the name reports as a row that cannot
    // be FOUND rather than as a broken feature, and a writer's chapter stops
    // being called what they called it.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: statedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });

    const part = rowNamed(container, "Part One");
    // A row's name is computed from its CONTENT, and `aria-hidden` is what takes
    // a child out of that computation. NOT textContent, which the mark is of
    // course part of - asserting textContent here was the first version of this
    // test and it fails against the correct implementation, which is a guard
    // that cannot be satisfied rather than one that catches nothing.
    expect(part.querySelector(".nav-state")?.getAttribute("aria-hidden")).toBe("true");
    expect(part.querySelector(".nav-count")?.getAttribute("aria-hidden")).toBe("true");
    // Everything NOT hidden, which is what a name computation is left with.
    const named = [...part.children]
      .filter((child) => child.getAttribute("aria-hidden") !== "true")
      .map((child) => child.textContent)
      .join("");
    expect(named).toBe("Part One");

    nav.destroy();
    container.remove();
  });

  test("a recycled row element loses the state of the row it used to hold", () => {
    // The virtual list repaints elements in place, so a state written only when
    // present leaves the old mark, the old tint AND a description saying "Draft"
    // on a row nobody marked - the worst of the three, because it is the channel
    // a reader cannot see to doubt.
    const container = makeContainer();
    const nav = createNavigator({
      container, source: statedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });
    const elementAt = (i: number): HTMLElement => rowsIn(container)[i] as HTMLElement;

    const recycled = elementAt(2);
    expect(recycled.dataset.state).toBe("draft");

    nav.handleKey("ArrowDown"); // Ch A
    nav.handleKey("ArrowLeft"); // collapse Ch A: Part Two slides into index 2

    const after = elementAt(2);
    // Element identity: a list that unmounted and remounted would pass this
    // without ever touching the defect.
    expect(after).toBe(recycled);
    expect(after.dataset.state).toBe("revising");
    expect(after.querySelector(".nav-state")?.textContent).toBe(STATE_MARKS.revising);
    expect(after.getAttribute("aria-describedby")).toBe(stateDescriptionId("revising"));

    nav.destroy();
    container.remove();
  });

  test("a recycled row that lands on an UNMARKED row is cleared, not left", () => {
    // The delete branch, which the test above cannot reach: recycling one marked
    // row onto another marked row overwrites all three channels either way.
    const container = makeContainer();
    const source = statedSource();
    // Part Two unmarked, so the collapse recycles `draft` onto nothing.
    source.items[4]!.state = null;
    const nav = createNavigator({
      container, source, rowHeight: 24, overscan: 4, mode: "virtual",
    });
    const elementAt = (i: number): HTMLElement => rowsIn(container)[i] as HTMLElement;

    const recycled = elementAt(2);
    expect(recycled.dataset.state).toBe("draft");

    nav.handleKey("ArrowDown");
    nav.handleKey("ArrowLeft");

    const after = elementAt(2);
    expect(after).toBe(recycled);
    expect(after.dataset.state).toBeUndefined();
    expect(after.querySelector(".nav-state")?.textContent).toBe("");
    expect(after.hasAttribute("aria-describedby")).toBe(false);

    nav.destroy();
    container.remove();
  });

  test("a source that reports no states at all clears the attribute", () => {
    // `stateAt` is optional on TreeSource because a corpus source has no items
    // to answer with, and `reload` accepts ANY TreeSource - so a navigator
    // mounted on the store can be handed a stateless source.
    const container = makeContainer();
    const source = statedSource();
    const nav = createNavigator({
      container, source, rowHeight: 24, overscan: 4, mode: "virtual",
    });
    expect(rowsIn(container)[0]!.dataset.state).toBe("done");

    nav.reload({
      count: source.count,
      seed: source.seed,
      titleAt: source.titleAt,
      idAt: source.idAt,
      depthAt: source.depthAt,
      items: source.items,
    });

    for (const row of rowsIn(container)) {
      expect(row.dataset.state).toBeUndefined();
      expect(row.hasAttribute("aria-describedby")).toBe(false);
    }

    nav.destroy();
    container.remove();
  });

  test("a state this build does not know is drawn as no state at all", () => {
    // It can only come from a newer build. Drawing an unknown mark, or pointing
    // aria-describedby at an element that does not exist, are both worse than
    // drawing nothing - the second is a description a screen reader resolves to
    // the empty string with no way for anyone to notice.
    const container = makeContainer();
    const source = statedSource();
    source.items[0]!.state = "abandoned";
    const nav = createNavigator({
      container, source, rowHeight: 24, overscan: 4, mode: "virtual",
    });

    const row = rowNamed(container, "Part One");
    expect(row.dataset.state).toBeUndefined();
    expect(row.querySelector(".nav-state")?.textContent).toBe("");
    expect(row.hasAttribute("aria-describedby")).toBe(false);

    nav.destroy();
    container.remove();
  });

  test("every state has a description element, mounted once and removed on destroy", () => {
    const container = makeContainer();
    const nav = createNavigator({
      container, source: statedSource(), rowHeight: 24, overscan: 4, mode: "virtual",
    });

    // BOOLEANS AND LENGTHS, never the element itself. `expect(node)` on a
    // happy-dom element prints the WHOLE node on failure - megabytes of getters
    // - and the run is then killed by its own timeout with a truncated log,
    // which reads as a hang rather than as an assertion. A recorded trap
    // for focus assertions; it is the same trap here, and this file hit it.
    for (const state of REVISION_STATES) {
      const el = document.getElementById(stateDescriptionId(state));
      expect(el !== null).toBe(true);
      expect(el?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
    // Exactly one holder, however many navigators have been built: a project
    // switch constructs the next navigator around the previous one's teardown.
    expect(document.querySelectorAll("#nav-state-descriptions").length).toBe(1);

    nav.destroy();
    // Left behind, they would accumulate one holder per project switch, and the
    // ids would then be ambiguous.
    expect(document.getElementById(stateDescriptionId("draft")) === null).toBe(true);
    container.remove();
  });
});

describe("the stylesheet draws the state without changing the row's box", () => {
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");

  function block(selector: string): string {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector} in style.css`);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  test("the mark sets no height of its own", () => {
    // The row is an absolutely positioned box of exactly ROW_HEIGHT whose
    // coordinates five rigs compute. A smaller font inside the same line box is
    // free; a line-height, a vertical padding or a height is not.
    const mark = block("#nav .nav-state");
    expect(mark).toContain("font-size");
    expect(mark).not.toContain("line-height");
    expect(mark).not.toMatch(/(?:^|;)\s*padding\s*:/);
    expect(mark).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:/);
  });

  test("no state rule is the only thing telling two states apart", () => {
    // COLOUR IS NOT ALLOWED TO BE LOAD-BEARING. Whatever the stylesheet tints,
    // the marks are already a fill progression - an empty ring through to a
    // solid disc - so the row still says where it stands in greyscale and to a
    // reader who cannot tell two tints apart. What this pins is that the four
    // MARKS are four distinct characters; a palette can then do what it likes.
    const marks = REVISION_STATES.map((s) => STATE_MARKS[s]);
    expect(new Set(marks).size).toBe(marks.length);
    for (const mark of marks) expect(mark.length).toBe(1);
  });

  test("any state colour rule carries [role=treeitem]", () => {
    // The recorded specificity hazard: the type rules are one id plus two
    // attributes, so a bare `#nav [data-state="done"]` loses to them silently -
    // the rule is in the file, it matches, and it is overridden.
    for (const match of css.matchAll(/#nav\s+\[data-state=/g)) {
      throw new Error(`state rule without [role="treeitem"] at index ${match.index}`);
    }
    expect(css).toContain('#nav [role="treeitem"][data-state="done"]');
  });

  test("the descriptions are hidden from sight and NOT from the accessibility tree", () => {
    // `display: none` content is only conditionally included in a description
    // computation, so the holder is clipped instead. `aria-hidden` on it would
    // remove the one channel this feature has to a screen-reader user.
    const holder = block("#nav-state-descriptions");
    expect(holder).toContain("clip-path");
    expect(holder).not.toContain("display: none");
    // COMMENTS STRIPPED FIRST. The recorded theme.test.ts trap, third instance:
    // the comment inside this very function explains why it is NOT aria-hidden
    // and NAMES the attribute, so a search over the raw text finds it in the
    // prose and fails against the correct source.
    const source = readFileSync(join(import.meta.dir, "..", "src/navigator/index.ts"), "utf8");
    const at = source.indexOf("function mountStateDescriptions");
    expect(at).toBeGreaterThan(-1);
    const body = source
      .slice(at, source.indexOf("\n}\n", at))
      .replace(/\/\/[^\n]*/g, "");
    expect(body).toContain("holder.id");
    expect(body).not.toContain("aria-hidden");
  });
});

describe("the synopsis mark", () => {
  test("a row in the set carries data-synopsis and the description; others carry neither", () => {
    const container = makeContainer();
    const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "naive" });
    nav.setSynopses(new Set(["s-1"]));
    const marked = rowNamed(container, "Sc 1");
    expect(marked.dataset.synopsis).toBe("true");
    // Beside the revision state's description, not instead of it.
    expect(marked.getAttribute("aria-describedby")).toBe(
      `${stateDescriptionId("draft")} nav-synopsis-description`,
    );
    const plain = rowNamed(container, "Ch A");
    expect(plain.dataset.synopsis).toBeUndefined();
    expect(plain.getAttribute("aria-describedby")).toBeNull();
    expect(document.getElementById("nav-synopsis-description")?.textContent).toBe("Has a synopsis");
    nav.destroy();
  });

  test("a cleared synopsis takes the mark and its description off the row", () => {
    // The recycling rule: written on every paint, deleted when absent.
    const container = makeContainer();
    const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "naive" });
    nav.setSynopses(new Set(["c-1"]));
    expect(rowNamed(container, "Ch A").dataset.synopsis).toBe("true");
    expect(rowNamed(container, "Ch A").getAttribute("aria-describedby")).toBe("nav-synopsis-description");
    nav.setSynopses(new Set());
    expect(rowNamed(container, "Ch A").dataset.synopsis).toBeUndefined();
    expect(rowNamed(container, "Ch A").getAttribute("aria-describedby")).toBeNull();
    nav.destroy();
  });

  test("the mark is its own span, outside the title's clip, and says what it means", () => {
    const container = makeContainer();
    const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "naive" });
    nav.setSynopses(new Set(["s-1"]));
    const mark = rowNamed(container, "Sc 1").querySelector(".nav-synopsis");
    expect(mark?.textContent).toBe("\u00a7");
    expect((mark as HTMLElement)?.dataset.navHint).toBe("Has a synopsis");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.closest(".nav-title")).toBeNull();
    const plain = rowNamed(container, "Ch A").querySelector(".nav-synopsis");
    expect(plain?.textContent).toBe("");
    expect(plain?.hasAttribute("title")).toBe(false);
    nav.destroy();
    const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");
    expect(css).not.toContain(".nav-title::after");
  });
});

describe("the appearances mark", () => {
  test("only tagged scenes show the mark and its description", () => {
    const container = makeContainer();
    const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "naive" });
    nav.setAppearances(new Set(["s-1", "c-1"]));
    const scene = rowNamed(container, "Sc 1");
    expect(scene.dataset.appearances).toBe("true");
    expect(scene.querySelector(".nav-appearances")?.textContent).toBe("◆");
    expect(scene.querySelector(".nav-appearances")?.getAttribute("aria-hidden")).toBe("true");
    expect(scene.getAttribute("aria-describedby")).toBe(
      `${stateDescriptionId("draft")} nav-appearances-description`,
    );
    expect(rowNamed(container, "Ch A").dataset.appearances).toBeUndefined();
    expect(document.getElementById("nav-appearances-description")?.textContent).toBe(
      "Has tagged people, places, or things",
    );
    nav.setAppearances(new Set());
    expect(scene.dataset.appearances).toBeUndefined();
    expect(scene.querySelector(".nav-appearances")?.textContent).toBe("");
    expect(scene.getAttribute("aria-describedby")).toBe(stateDescriptionId("draft"));
    nav.destroy();
    container.remove();
  });
});

describe("the section separator survives selection", () => {
  // A selected row's pill is ALSO painted as a ::before at equal specificity,
  // later in the file - so a separator drawn as ::before on the same element
  // was erased the moment a reader selected that row. Pinned here because a
  // screenshot would show the loss but never say why it came back.
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8");

  test("the separator is painted on ::after, not ::before", () => {
    expect(css).toContain('[data-first-reserved="true"]::after');
    expect(css).not.toContain('[data-first-reserved="true"]::before');
  });

  test("a fallback border-top precedes the color-mix one, for an engine without color-mix()", () => {
    const at = css.indexOf('[data-first-reserved="true"]::after');
    expect(at).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    const block = css.slice(open + 1, close);
    const borders = [...block.matchAll(/border-top:\s*([^;]+);/g)].map((m) => m[1]);
    expect(borders.length).toBe(2);
    expect(borders[0]).not.toContain("color-mix");
    expect(borders[1]).toContain("color-mix");
  });
});

describe("a truncated title", () => {
  test("shows its full text on hover, and only when the ellipsis cut it", () => {
    const container = makeContainer();
    const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "naive" });
    const row = rowNamed(container, "Sc 1");
    const title = row.querySelector(".nav-title") as HTMLElement;
    const hover = (): void => {
      title.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    };
    Object.defineProperty(title, "clientWidth", { configurable: true, value: 40 });
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 40 });
    hover();
    expect(title.hasAttribute("title")).toBe(false);
    Object.defineProperty(title, "scrollWidth", { configurable: true, value: 90 });
    hover();
    expect(title.getAttribute("title")).toBe("Sc 1");
    // The tip repeats the title, so the row's name is still exactly the title.
    expect(row.getAttribute("aria-label")).toBeNull();
    nav.destroy();
  });
});


test("delegated indicator tips follow hover and keyboard selection without changing row names", async () => {
  const container = makeContainer();
  const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "virtual" });
  nav.setSynopses(new Set(["s-1"]));
  nav.setAppearances(new Set(["s-1"]));
  nav.setCounts(new Map([["s-1", 35]]));
  const row = rowNamed(container, "Sc 1");
  const tip = (): HTMLElement | null => document.querySelector(".nav-indicator-tip");
  for (const [selector, text] of [[".nav-synopsis", t("nav.synopsis.described")], [".nav-appearances", t("nav.appearances.described")], [".nav-state", t("nav.state.described", { state: "Draft" })], [".nav-count", t("nav.words.described", { count: "35" })]]) {
    row.querySelector(selector)?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip()?.textContent).toBe(text);
    expect(row.children.length).toBe(5);
  }
  const hovered = tip()!;
  row.querySelector(".nav-count")?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  hovered.dispatchEvent(new MouseEvent("mouseenter"));
  await Bun.sleep(250);
  expect(tip()).toBe(hovered);
  hovered.dispatchEvent(new MouseEvent("mouseleave"));
  expect(tip()).toBeNull();
  container.focus();
  nav.selectById("s-1");
  expect(tip()?.textContent).toContain(t("nav.words.described", { count: "35" }));
  expect(row.getAttribute("aria-describedby")).toContain("nav-word-description");
  expect(document.getElementById("nav-word-description")?.textContent).toBe(t("nav.words.described", { count: "35" }));
  container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(tip()?.textContent).toBe(t("nav.state.described", { state: "Outline" }));
  container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
  expect(tip() !== null).toBe(true);
  container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(tip()).toBeNull();
  row.querySelector(".nav-count")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  container.dispatchEvent(new Event("scroll"));
  expect(tip()).toBeNull();
  nav.setCounts(new Map());
  expect((row.querySelector(".nav-count") as HTMLElement).dataset.navHint).toBeUndefined();
  nav.reload(statedSource());
  expect(tip()).toBeNull();
  nav.destroy();
  container.focus();
  expect(tip()).toBeNull();
  container.remove();
});


test("keyboard indicator descriptions sit beside the row without covering the next row", () => {
  const container = makeContainer();
  const nav = createNavigator({ container, source: statedSource(), rowHeight: 24, overscan: 2, mode: "virtual" });
  nav.setCounts(new Map([["s-1", 35]]));
  const row = rowNamed(container, "Sc 1");
  row.getBoundingClientRect = () => ({ left: 4, right: 240, top: 60, bottom: 84, width: 236, height: 24, x: 4, y: 60, toJSON: () => ({}) });
  try {
    container.focus(); nav.selectById("s-1");
    const tip = document.querySelector<HTMLElement>(".nav-indicator-tip")!;
    expect(Number.parseFloat(tip.style.left)).toBe(248);
    expect(Number.parseFloat(tip.style.top)).toBe(60);
  } finally { nav.destroy(); container.remove(); }
});
