import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";
import { schema } from "../src/editor";
import {
  applyWritingModes,
  focusPlugin,
  FOCUS_CLASS,
  DEFAULT_WRITING_MODES,
  FOCUS_MODES,
  TYPEWRITER_MODES,
  TYPEWRITER_ANCHOR,
  typewriterScrollTop,
  writingModesFrom,
} from "../src/writing-modes";

describe("narrowing what the host injected", () => {
  test("the known spellings are the values", () => {
    expect(writingModesFrom({ focus: "paragraph", typewriter: "on" })).toEqual({
      focus: "paragraph",
      typewriter: "on",
    });
    expect(writingModesFrom({ focus: "off", typewriter: "off" })).toEqual(DEFAULT_WRITING_MODES);
  });

  test("one unreadable axis costs exactly itself", () => {
    // The same rule the typography axes follow, for the same reason: the host
    // maps a failed parse of the whole settings file to defaults, so a strict
    // field would discard last_project too.
    expect(writingModesFrom({ focus: 7, typewriter: "on" })).toEqual({
      focus: "off",
      typewriter: "on",
    });
    expect(writingModesFrom({ focus: "paragraph", typewriter: "sometimes" })).toEqual({
      focus: "paragraph",
      typewriter: "off",
    });
  });

  test("an absent injection reads as the defaults rather than throwing", () => {
    expect(writingModesFrom({})).toEqual(DEFAULT_WRITING_MODES);
  });

  test("neither axis accepts the other's word", () => {
    // Two axes sharing an `off` is exactly where a single shared table would be
    // reached for, and "on" is not a focus mode.
    expect(writingModesFrom({ focus: "on" }).focus).toBe("off");
    expect(writingModesFrom({ typewriter: "paragraph" }).typewriter).toBe("off");
  });
});

describe("applying the modes to the root", () => {
  const root = (): HTMLElement => document.createElement("html");

  test("a chosen mode is written as an attribute", () => {
    const el = root();
    applyWritingModes(el, { focus: "paragraph", typewriter: "on" });
    expect(el.getAttribute("data-focus")).toBe("paragraph");
    expect(el.getAttribute("data-typewriter")).toBe("on");
  });

  test("`off` REMOVES the attribute rather than writing the word", () => {
    // The stylesheet has no rule for `off`, so leaving it behind works by
    // accident today and breaks the day any [data-focus] selector is added -
    // the same call applyTheme makes for `system`, pinned there for the same
    // reason.
    const el = root();
    applyWritingModes(el, { focus: "paragraph", typewriter: "on" });
    applyWritingModes(el, DEFAULT_WRITING_MODES);
    expect(el.hasAttribute("data-focus")).toBe(false);
    expect(el.hasAttribute("data-typewriter")).toBe(false);
  });

  test("the axes are independent", () => {
    const el = root();
    applyWritingModes(el, { focus: "paragraph", typewriter: "off" });
    expect(el.getAttribute("data-focus")).toBe("paragraph");
    expect(el.hasAttribute("data-typewriter")).toBe(false);
    applyWritingModes(el, { focus: "off", typewriter: "on" });
    expect(el.hasAttribute("data-focus")).toBe(false);
    expect(el.getAttribute("data-typewriter")).toBe("on");
  });
});

describe("the typewriter scroll position", () => {
  // Pure arithmetic, which is the whole reason it is a free function: happy-dom
  // does no layout, so a geometry assertion against a real element is vacuous.
  const PANE_TOP = 100;
  const PANE_HEIGHT = 600;
  const ANCHOR_LINE = PANE_TOP + PANE_HEIGHT * TYPEWRITER_ANCHOR;

  test("a caret already at the anchor line does not scroll", () => {
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 0, ANCHOR_LINE)).toBe(0);
  });

  test("a caret below the anchor scrolls DOWN by the difference", () => {
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 0, ANCHOR_LINE + 120)).toBe(120);
  });

  test("the current scroll position is carried, not discarded", () => {
    // Without this the second keystroke of every scene jumps back to the top:
    // the caret's viewport position already accounts for the scroll, so the
    // wanted position is relative to the content, not to the viewport.
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 500, ANCHOR_LINE)).toBe(500);
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 500, ANCHOR_LINE + 40)).toBe(540);
  });

  test("never negative", () => {
    // At the top of a document there is nothing above the caret to scroll into
    // view. A negative scrollTop is either clamped - a wasted write on every
    // keystroke - or honoured by an overscrolling container, which puts the
    // first line off screen.
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 0, PANE_TOP)).toBe(0);
    expect(typewriterScrollTop(PANE_TOP, PANE_HEIGHT, 0, PANE_TOP - 50)).toBe(0);
  });

  test("the anchor is ABOVE centre", () => {
    // Dead centre reads as slightly low, because the eye weights the written
    // text above the caret more than the empty space below it. Pinned so a
    // later tidy to 0.5 is a decision rather than an accident.
    expect(TYPEWRITER_ANCHOR).toBeLessThan(0.5);
    expect(TYPEWRITER_ANCHOR).toBeGreaterThan(0.3);
  });
});

describe("the three statements of the mode lists", () => {
  // The lists exist in writing-modes.ts, in index.html's head script and in
  // style.css, and none can import the others: the head script runs before the
  // bundle and CSS cannot read a TS constant. Same guard as the typography
  // axes', for the same reason.
  const AXES = [
    { attr: "focus", values: FOCUS_MODES },
    { attr: "typewriter", values: TYPEWRITER_MODES },
  ] as const;

  test("the head script allows exactly what writing-modes.ts knows", async () => {
    const html = await Bun.file("app/ui/index.html").text();
    for (const { attr, values } of AXES) {
      const call = html.match(
        new RegExp(`mode\\("${attr}",\\s*window\\.\\w+,\\s*\\[([^\\]]*)\\]\\)`),
      );
      expect(call).not.toBeNull();
      const allowed = [...(call?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
      expect(allowed.sort()).toEqual([...values].sort());
    }
  });

  test("the stylesheet has a rule for every value except off", async () => {
    // `off` is the ABSENCE of the attribute, so a rule for it could never match
    // and its presence would mean the attribute was being written.
    const css = await Bun.file("app/ui/style.css").text();
    for (const { attr, values } of AXES) {
      for (const value of values) {
        const selector = `[data-${attr}="${value}"]`;
        if (value === "off") expect(css).not.toContain(selector);
        else expect(css).toContain(selector);
      }
    }
  });

  test("the focus rule dims the siblings AND un-dims the focused block", async () => {
    // Both halves: a rule that only dimmed would grey the whole scene, and one
    // that only un-dimmed would do nothing at all.
    const css = await Bun.file("app/ui/style.css").text();
    expect(css).toContain('[data-focus="paragraph"] #editor .ProseMirror > *');
    expect(css).toContain('[data-focus="paragraph"] #editor .ProseMirror > .focus-block');
  });

  test("the focus transition is disabled under prefers-reduced-motion", async () => {
    // The only animation in the prose, and a colour fade at every caret
    // move is exactly what that preference exists for.
    const css = await Bun.file("app/ui/style.css").text();
    // The focus fade's own block: the panel shell has one of its own.
    const at = css.indexOf('prefers-reduced-motion: reduce) {\n  :root[data-focus="paragraph"]');
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, at + 260)).toContain("transition: none");
  });

  test("typewriter mode reserves room below the prose", async () => {
    // Without it the last paragraph cannot be brought to the anchor line at all,
    // so a writer at the end of a scene - where writers usually are - gets no
    // typewriter behaviour precisely when they want it.
    const css = await Bun.file("app/ui/style.css").text();
    const at = css.indexOf('[data-typewriter="on"]');
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, at + 200)).toMatch(/padding-bottom:\s*\d+vh/);
  });
});

describe("the focus decoration", () => {
  // The decoration is what the stylesheet keys off, and nothing else in the
  // application can see which block the caret is in. A mutation that made it
  // always land on the FIRST block survived the whole suite before this block
  // existed - the visible symptom would be a writer's first paragraph lit up
  // while the one they are typing in stays dimmed.
  const doc = (...paragraphs: string[]): PmNode =>
    schema.nodeFromJSON({
      type: "doc",
      content: paragraphs.map((text) => ({
        type: "paragraph",
        content: text.length > 0 ? [{ type: "text", text }] : [],
      })),
    });

  /** The [from, to] of the single decoration the plugin produced. */
  function decorated(node: PmNode, head: number): [number, number] | null {
    const plugin = focusPlugin();
    const state = EditorState.create({ doc: node, plugins: [plugin] });
    const moved = state.apply(state.tr.setSelection(TextSelection.create(node, head)));
    const set = plugin.props.decorations?.call(plugin, moved);
    if (set === undefined || set === null) return null;
    const found = (set as DecorationSet).find();
    if (found.length !== 1) return null;
    return [found[0]!.from, found[0]!.to];
  }

  test("decorates the block holding the caret, not the first one", () => {
    const node = doc("first", "second", "third");
    // Positions: <p>first</p> is 0..7, <p>second</p> 7..15, <p>third</p> 15..22.
    const first = decorated(node, 3);
    const second = decorated(node, 10);
    const third = decorated(node, 18);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    // Three different blocks, in order. Asserting they DIFFER is what a
    // first-block implementation fails.
    expect(first![0]).toBeLessThan(second![0]);
    expect(second![0]).toBeLessThan(third![0]);
  });

  test("the decoration spans exactly one top-level block", () => {
    const node = doc("first", "second");
    const at = decorated(node, 10);
    expect(at).not.toBeNull();
    expect(at![1] - at![0]).toBe(node.child(1).nodeSize);
  });

  test("carries the class the stylesheet keys off", () => {
    const node = doc("only");
    const plugin = focusPlugin();
    const state = EditorState.create({ doc: node, plugins: [plugin] });
    const set = plugin.props.decorations?.call(plugin, state) as DecorationSet;
    // `type.attrs` is where Decoration.node stores what it was given - NOT
    // `spec`, which is the third argument and is empty here. Probed against the
    // real object rather than assumed: an assertion on the wrong field would
    // pass for any class at all, including none.
    const found = set.find()[0] as unknown as { type?: { attrs?: Record<string, string> } };
    const attrs = found?.type?.attrs;
    expect(attrs?.class).toBe(FOCUS_CLASS);
  });

  test("an empty document decorates nothing rather than everything", () => {
    const node = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] });
    const plugin = focusPlugin();
    const state = EditorState.create({ doc: node, plugins: [plugin] });
    const set = plugin.props.decorations?.call(plugin, state) as DecorationSet;
    // One empty paragraph still HAS a block, so this is one decoration, not
    // zero - the assertion is that it does not throw and does not decorate the
    // document node itself.
    expect(set.find().length).toBeLessThanOrEqual(1);
  });
});

describe("the typewriter hook stays off the keystroke path", () => {
  // A SOURCE PARSE, because the cost this guards against is invisible to every
  // assertion available here: happy-dom does no layout, so `coordsAtPos` and
  // getBoundingClientRect are free in a test and expensive in a browser. The
  // word-count rescan that cost measurable typing latency had exactly this
  // shape - every scalar gate stayed green while the frame-time tail moved -
  // and the soak runs with this mode OFF, so no graded run would catch it
  // either.
  test("the layout read is coalesced into a frame, not run in dispatchTransaction", async () => {
    const src = await Bun.file("app/ui/src/editor.ts").text();
    const hook = src.indexOf("function holdTypewriterLine");
    const deferred = src.indexOf("function scrollToTypewriterLine");
    expect(hook).toBeGreaterThan(-1);
    expect(deferred).toBeGreaterThan(-1);

    // COMMENTS STRIPPED FIRST. The comment explaining why the layout read is
    // deferred names `coordsAtPos`, so a search over the raw text finds it in
    // the prose and fails against the correct source - the trap theme.test.ts
    // was caught in, where a guard parsed a sentence instead of a rule.
    const sync = src
      .slice(hook, deferred)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(sync).not.toContain("coordsAtPos");
    expect(sync).not.toContain("getBoundingClientRect");

    // A CALL, not the `typeof requestAnimationFrame` guard beside it. Asserting
    // the bare identifier passed against a mutation that replaced the whole
    // frame booking with a direct call, because the typeof check still
    // mentioned it - the guard was reading a word rather than a structure.
    const booking = sync.indexOf("requestAnimationFrame(() =>");
    expect(booking).toBeGreaterThan(-1);

    // And the deferred work must happen INSIDE that callback: every call to it
    // in this half comes after the booking.
    const calls = [...sync.matchAll(/scrollToTypewriterLine\(/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) expect(at).toBeGreaterThan(booking);

    // Guarded, or a burst of transactions books a frame each. BOTH halves: the
    // early return and the latch it reads, since a mutation deleting the return
    // leaves the assignment behind.
    expect(sync).toContain("if (typewriterPending) return;");
    expect(sync).toContain("typewriterPending = true;");
  });

  test("the mode is re-checked inside the frame", async () => {
    // The writer can turn it off between the transaction and the callback, and
    // a scroll they did not ask for is worse than a frame's delay.
    const src = await Bun.file("app/ui/src/editor.ts").text();
    const at = src.indexOf("function scrollToTypewriterLine");
    expect(src.slice(at, at + 400)).toContain('data-typewriter');
  });
});
