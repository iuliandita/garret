import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { DOMParser, type Node as PmNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  countWordsIn,
  createEditor,
  docJsonFrom,
  editorPlugins,
  type PmNodeJson,
  readableBody,
  schema,
} from "../src/editor";
import { countWords } from "../src/words";

// "alpha beta" in one paragraph: text runs 1..11, so "alpha" is 1..6 and
// "beta" is 7..11.
const ALPHA_FROM = 1;
const ALPHA_TO = 6;
const BETA_FROM = 7;
const BETA_TO = 11;

function stateOf(paragraphs: string[]): EditorState {
  const doc = schema.nodeFromJSON(
    docJsonFrom({
      kind: "blocks",
      blocks: paragraphs.map((text) => ({ type: "paragraph", text })),
    }) as unknown as Record<string, unknown>,
  );
  return EditorState.create({ doc, plugins: editorPlugins() });
}

function select(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

/** Sends a key through the plugins EXACTLY as the editor would, to each
 *  plugin's handleKeyDown prop in plugin order. Calling toggleMark directly
 *  would pass with the Mod-i binding deleted; this cannot. */
function pressKey(state: EditorState, event: Partial<KeyboardEvent>): EditorState | null {
  let next: EditorState | null = null;
  const view = {
    state,
    dispatch: (tr: Transaction) => {
      next = state.apply(tr);
    },
  } as unknown as EditorView;
  for (const plugin of editorPlugins()) {
    const handler = plugin.props?.handleKeyDown;
    if (handler === undefined) continue;
    if (handler.call(plugin, view, event as KeyboardEvent) === true) return next;
  }
  return null;
}

const MOD_I: Partial<KeyboardEvent> = { key: "i", keyCode: 73, ctrlKey: true };
const MOD_B: Partial<KeyboardEvent> = { key: "b", keyCode: 66, ctrlKey: true };
const MOD_U: Partial<KeyboardEvent> = { key: "u", keyCode: 85, ctrlKey: true };
const MOD_Z: Partial<KeyboardEvent> = { key: "z", keyCode: 90, ctrlKey: true };

/** Builds `<p>{inline}alpha{/inline} beta</p>` out of real DOM nodes and runs
 *  ProseMirror's own DOM parser over it against this schema -- the same code
 *  path a clipboard paste takes, without needing a clipboard event. */
function pastedDoc(wrapper: HTMLElement | null): PmNode {
  const div = document.createElement("div");
  const p = document.createElement("p");
  if (wrapper === null) {
    p.appendChild(document.createTextNode("alpha"));
  } else {
    wrapper.appendChild(document.createTextNode("alpha"));
    p.appendChild(wrapper);
  }
  p.appendChild(document.createTextNode(" beta"));
  div.appendChild(p);
  return DOMParser.fromSchema(schema).parse(div);
}

function styled(tag: string, style: string): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute("style", style);
  return el;
}

describe("emphasis marks through the keymap", () => {
  test("Mod-i marks the selection with em", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    expect(selected.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);

    const next = pressKey(selected, MOD_I);
    expect(next).not.toBeNull();
    expect(next!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(true);
    // Not a mark-everything implementation: the rest of the paragraph is clean.
    expect(next!.doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.em)).toBe(false);
    expect(next!.doc.textContent).toBe("alpha beta");
  });

  test("Mod-i again unmarks it", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_I);
    expect(marked).not.toBeNull();
    const unmarked = pressKey(marked!, MOD_I);
    expect(unmarked).not.toBeNull();
    expect(unmarked!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);
    // A toggle that dropped the text would also clear the mark.
    expect(unmarked!.doc.textContent).toBe("alpha beta");
  });

  test("Mod-b marks with strong, and the two marks coexist on one range", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const bold = pressKey(selected, MOD_B);
    expect(bold).not.toBeNull();
    expect(bold!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.strong)).toBe(true);
    expect(bold!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);

    const both = pressKey(bold!, MOD_I);
    expect(both).not.toBeNull();
    expect(both!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.strong)).toBe(true);
    expect(both!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(true);
  });

  test("Mod-u marks the selection with underline", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    expect(selected.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(false);

    const next = pressKey(selected, MOD_U);
    expect(next).not.toBeNull();
    expect(next!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(true);
    expect(next!.doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.underline)).toBe(false);
    expect(next!.doc.textContent).toBe("alpha beta");
  });

  test("Mod-u again unmarks it", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_U);
    expect(marked).not.toBeNull();
    const unmarked = pressKey(marked!, MOD_U);
    expect(unmarked).not.toBeNull();
    expect(unmarked!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(false);
    expect(unmarked!.doc.textContent).toBe("alpha beta");
  });

  test("underline coexists with the other two on one range", () => {
    // The three controls are independent, which is what makes a toolbar of
    // three pressed states meaningful rather than a three-way radio.
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const bold = pressKey(selected, MOD_B);
    const italic = pressKey(bold!, MOD_I);
    const all = pressKey(italic!, MOD_U);
    expect(all).not.toBeNull();
    expect(all!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.strong)).toBe(true);
    expect(all!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(true);
    expect(all!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(true);
  });

  test("a mark toggle undoes as one step, leaving earlier edits alone", () => {
    // The typed "!" is what makes this falsifiable. If the mark transaction
    // never entered the history, this undo would remove the "!" instead, and
    // the document would come back unmarked either way.
    const base = stateOf(["alpha beta"]);
    const typed = base.apply(base.tr.insertText("!", BETA_TO));
    const selected = select(typed, BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_I);
    expect(marked).not.toBeNull();
    expect(marked!.doc.textContent).toBe("alpha beta!");

    const undone = pressKey(marked!, MOD_Z);
    expect(undone).not.toBeNull();
    expect(undone!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);
    expect(undone!.doc.textContent).toBe("alpha beta!");
    expect(undone!.doc.eq(typed.doc)).toBe(true);
  });
});

describe("marks across serialize and reload", () => {
  test("a marked range survives a real serialize -> replaceDoc round trip", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_I);
    expect(marked).not.toBeNull();

    const editor = createEditor(document.createElement("div"), {
      kind: "pmjson",
      json: marked!.doc.toJSON() as PmNodeJson,
    });
    const stored = editor.serialize();
    editor.replaceDoc({ kind: "pmjson", json: JSON.parse(stored) as PmNodeJson });

    const reloaded = schema.nodeFromJSON(
      JSON.parse(editor.serialize()) as unknown as Record<string, unknown>,
    );
    expect(reloaded.textContent).toBe("alpha beta");
    expect(reloaded.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(true);
    expect(reloaded.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.em)).toBe(false);
    editor.destroy();
  });

  test("an underlined range survives a real serialize -> replaceDoc round trip", () => {
    // The mark has to be in the STORED JSON, not only in the running editor:
    // this is what makes an underline outlive a project switch, and what the
    // exporter counts.
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_U);
    expect(marked).not.toBeNull();

    const editor = createEditor(document.createElement("div"), {
      kind: "pmjson",
      json: marked!.doc.toJSON() as PmNodeJson,
    });
    const stored = editor.serialize();
    expect(stored).toContain("underline");
    editor.replaceDoc({ kind: "pmjson", json: JSON.parse(stored) as PmNodeJson });

    const reloaded = schema.nodeFromJSON(
      JSON.parse(editor.serialize()) as unknown as Record<string, unknown>,
    );
    expect(reloaded.textContent).toBe("alpha beta");
    expect(reloaded.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(true);
    expect(reloaded.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.underline)).toBe(false);
    editor.destroy();
  });

  test("a document stored before marks existed still loads", () => {
    // Every body in the store predates this change and carries no marks key.
    const legacy: PmNodeJson = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "alpha beta" }] }],
    };
    const editor = createEditor(document.createElement("div"), { kind: "pmjson", json: legacy });
    expect(JSON.parse(editor.serialize())).toEqual(legacy);
    editor.replaceDoc({ kind: "pmjson", json: legacy });
    expect(JSON.parse(editor.serialize())).toEqual(legacy);
    editor.destroy();
  });
});

describe("pasted emphasis", () => {
  test("a plain paste carries no marks (control for the two below)", () => {
    const doc = pastedDoc(null);
    expect(doc.textContent).toBe("alpha beta");
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.em)).toBe(false);
  });

  test("an <em> tag parses to the em mark", () => {
    const doc = pastedDoc(document.createElement("em"));
    expect(doc.textContent).toBe("alpha beta");
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.em)).toBe(true);
    expect(doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);
  });

  test("an inline font-style: italic parses to the em mark", () => {
    const doc = pastedDoc(styled("span", "font-style: italic"));
    expect(doc.textContent).toBe("alpha beta");
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.em)).toBe(true);
    expect(doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(false);
  });

  test("a <u> tag parses to the underline mark", () => {
    const doc = pastedDoc(document.createElement("u"));
    expect(doc.textContent).toBe("alpha beta");
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.underline)).toBe(true);
    expect(doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(false);
  });

  test("an inline text-decoration: underline parses to the underline mark", () => {
    // What a word processor pastes. `underline` is the literal every source
    // emits for it, so an exact style match is enough here -- unlike
    // font-weight, where the value has to be tested.
    const doc = pastedDoc(styled("span", "text-decoration: underline"));
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.underline)).toBe(true);
    expect(doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.underline)).toBe(false);
  });

  test("a <strong> tag parses to the strong mark", () => {
    const doc = pastedDoc(document.createElement("strong"));
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.strong)).toBe(true);
  });

  test("an inline font-weight: bold parses to the strong mark", () => {
    const doc = pastedDoc(styled("span", "font-weight: bold"));
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.strong)).toBe(true);
  });

  test("an inline font-weight: 700 parses to the strong mark", () => {
    // The form the inline-style rule was actually added for. Google Docs and a
    // modern Word HTML export emit a NUMBER, and `{ style: "font-weight=bold" }`
    // is an exact string match on the value, so the whole word-processor paste
    // path missed the source it existed to serve.
    const doc = pastedDoc(styled("span", "font-weight: 700"));
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.strong)).toBe(true);
    expect(doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.strong)).toBe(false);
  });

  test("an inline font-weight: 400 inside a <b> clears the strong mark", () => {
    // The other half of the numeric rule, and why `clearMark` is in the spec at
    // all: a word processor wraps a run in a bold tag and then un-bolds part of
    // it with a weight of 400. Without the clearing rule the whole run comes in
    // bold, which is a paste that changes the writer's emphasis.
    const b = document.createElement("b");
    const normal = styled("span", "font-weight: 400");
    normal.appendChild(document.createTextNode("alpha"));
    b.appendChild(normal);
    const div = document.createElement("div");
    const p = document.createElement("p");
    p.appendChild(b);
    p.appendChild(document.createTextNode(" beta"));
    div.appendChild(p);
    const doc = DOMParser.fromSchema(schema).parse(div);

    expect(doc.textContent).toBe("alpha beta");
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.strong)).toBe(false);
  });

  test("a font-weight below the bold threshold is not bold", () => {
    // 300 is lighter than normal. A rule that matched the property rather than
    // its value would bold it, and would bold every un-bolded run too.
    const doc = pastedDoc(styled("span", "font-weight: 300"));
    expect(doc.rangeHasMark(ALPHA_FROM, ALPHA_TO, schema.marks.strong)).toBe(false);
  });
});

describe("the schema precondition the Rust walks rely on", () => {
  test("every non-text node in the schema is a block", () => {
    // NOT a property of this schema worth asserting for its own sake. TWO Rust
    // walks over the same stored JSON put a separator before EVERY non-text
    // node, while ProseMirror's textBetween puts one before every BLOCK node.
    // Both agree with the page only while those sets are the same. Add a
    // hard_break, an image or any inline leaf and "hello<br>world" is one thing
    // to the page and another to each walk -- at a fixture of plain paragraphs
    // no graded run would ever notice.
    //
    // This fails the day such a node is added. Read the note on document_text
    // before changing it: the fix is to split BOTH Rust separator rules by node
    // type, not to delete this.
    const inline = Object.values(schema.nodes)
      .filter((type) => type.name !== "text" && type.isInline)
      .map((type) => type.name);
    // The message is the point. A bare `toEqual([])` names the new node and
    // nothing else, so a reader fixes whichever walk they already know about
    // and ships the other one broken.
    expect(inline.length === 0 ? PRECONDITION_HOLDS : brokenPrecondition(inline)).toBe(
      PRECONDITION_HOLDS,
    );
  });
});

const PRECONDITION_HOLDS = "every non-text node in the schema is a block";

function brokenPrecondition(inline: string[]): string {
  return [
    `inline non-text node(s) added to the schema: ${inline.join(", ")}.`,
    "TWO Rust walks separate on every non-text node and BOTH are now wrong:",
    "store::document_text (app/shell-tauri/src-tauri/src/store/mod.rs) counts",
    '"hello<br>world" as two words where the page counts one, so a project total',
    "stops being the sum of its scenes; export::document_markdown",
    "(app/shell-tauri/src-tauri/src/export.rs) emits a blank line there, so the",
    "exported manuscript breaks a paragraph mid-sentence.",
    "Split BOTH separator rules by node type. Do not delete this test.",
  ].join(" ");
}

describe("countWordsIn", () => {
  test("two paragraphs count as two words, not one", () => {
    // Without a block separator the text content is "onetwo" -- one word. No
    // other assertion in this file would notice.
    expect(countWordsIn(stateOf(["one", "two"]).doc)).toBe(2);
  });

  test("a single paragraph counts its own words", () => {
    expect(countWordsIn(stateOf(["alpha beta gamma"]).doc)).toBe(3);
  });

  test("an empty document counts zero", () => {
    expect(countWordsIn(stateOf([""]).doc)).toBe(0);
  });

  test("marks do not affect the count", () => {
    const selected = select(stateOf(["alpha beta"]), BETA_FROM, BETA_TO);
    const marked = pressKey(selected, MOD_I);
    expect(marked).not.toBeNull();
    expect(marked!.doc.rangeHasMark(BETA_FROM, BETA_TO, schema.marks.em)).toBe(true);
    expect(countWordsIn(marked!.doc)).toBe(countWordsIn(selected.doc));
    expect(countWordsIn(marked!.doc)).toBe(countWords("alpha beta"));
  });
});

describe("readableBody", () => {
  // THE SCHEMA CHANGE IS THE MIGRATION, and it runs in both directions. A file
  // holding an underline opens in this build and CRASHES an older one:
  // `schema.nodeFromJSON` throws `RangeError: There is no mark type underline
  // in this schema`, and the page's load sites hand a parsed body straight in.
  // The Rust side is deliberately permissive by contrast - an unrecognised node
  // contributes its descendants' text - so the asymmetry is real and it is on
  // the page. This is the cheap half of the answer: ask first, and report.
  test("an ordinary body reads", () => {
    const json = readableBody(
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }],
      }),
    );
    expect(json).not.toBeNull();
    expect(schema.nodeFromJSON(json as unknown as Record<string, unknown>).textContent).toBe(
      "alpha",
    );
  });

  test("a body carrying a mark this build does not know is refused, not thrown", () => {
    // What a NEWER build's file looks like to this one. The whole point is that
    // the caller gets an answer it can report rather than an exception through
    // the middle of a document swap.
    const body = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha", marks: [{ type: "highlight" }] }],
        },
      ],
    });
    expect(() =>
      schema.nodeFromJSON(JSON.parse(body) as unknown as Record<string, unknown>),
    ).toThrow();
    expect(readableBody(body)).toBeNull();
  });

  test("a body carrying a NODE this build does not know is refused too", () => {
    const body = JSON.stringify({
      type: "doc",
      content: [{ type: "code_block", content: [{ type: "text", text: "alpha" }] }],
    });
    expect(readableBody(body)).toBeNull();
  });

  test("bytes that are not JSON at all are refused", () => {
    expect(readableBody("{not json at all")).toBeNull();
    expect(readableBody("")).toBeNull();
  });

  test("valid JSON that is not a document is refused", () => {
    // The store's own acceptance rule, restated: `{"foo":1}` is not a document
    // to the page either, and `nodeFromJSON` throws on it rather than returning
    // something empty.
    expect(readableBody(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(readableBody(JSON.stringify([]))).toBeNull();
  });

  test("a body carrying THIS build's underline reads", () => {
    // The control that makes the refusals above mean something: the mark this
    // slice adds is not itself unreadable.
    const body = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha", marks: [{ type: "underline" }] }],
        },
      ],
    });
    expect(readableBody(body)).not.toBeNull();
  });
});

describe("Editor.activeMarks and the three toggles", () => {
  // WHAT THE TOOLBAR READS AND WHAT IT PRESSES. The keymap owns the bindings;
  // these are a SECOND CALLER of the same commands, exactly as undo/redo are,
  // so the chord the panel advertises and the chord that works cannot drift
  // from the button.
  function editorOn(text: string): ReturnType<typeof createEditor> {
    return createEditor(document.createElement("div"), {
      kind: "blocks",
      blocks: [{ type: "paragraph", text }],
    });
  }

  test("nothing is active in a fresh document", () => {
    const editor = editorOn("alpha beta");
    expect(editor.activeMarks()).toEqual({ bold: false, italic: false, underline: false });
    editor.destroy();
  });

  test("each toggle marks the selection and shows as active", () => {
    const editor = editorOn("alpha beta");
    editor.selectRange(BETA_FROM, BETA_TO);
    editor.toggleBold();
    expect(editor.activeMarks()).toEqual({ bold: true, italic: false, underline: false });
    editor.toggleItalic();
    expect(editor.activeMarks()).toEqual({ bold: true, italic: true, underline: false });
    editor.toggleUnderline();
    expect(editor.activeMarks()).toEqual({ bold: true, italic: true, underline: true });
    // And it really is in the document, not only in the readout: a pair of
    // matching lies would satisfy every assertion above.
    expect(editor.serialize()).toContain("underline");
    editor.destroy();
  });

  test("a second press of each toggle clears its own mark and no other", () => {
    const editor = editorOn("alpha beta");
    editor.selectRange(BETA_FROM, BETA_TO);
    editor.toggleBold();
    editor.toggleItalic();
    editor.toggleUnderline();
    editor.toggleItalic();
    expect(editor.activeMarks()).toEqual({ bold: true, italic: false, underline: true });
    editor.destroy();
  });

  test("a toggle pressed with NOTHING selected reads as active", () => {
    // `storedMarks`, and it is the whole of "press Bold, then type". ProseMirror
    // keeps a pending mark set on a collapsed caret and applies it to the next
    // character; a control that read only the marks AT the caret would sit
    // unpressed while the writer typed in bold, and pressing it again would
    // clear a mark the button said was off.
    const editor = editorOn("alpha beta");
    // caretToParagraph, not selectRange: `selectRange` REFUSES a collapsed
    // range (from >= to), so a test that asked for one would leave whatever
    // selection was there before and pass for the wrong reason.
    editor.caretToParagraph(0);
    expect(editor.selection()).toEqual({ from: BETA_TO, to: BETA_TO });
    expect(editor.activeMarks().bold).toBe(false);
    editor.toggleBold();
    expect(editor.activeMarks().bold).toBe(true);
    // And the promise is kept: what gets typed really is bold.
    editor.typeChar("x");
    expect(editor.serialize()).toContain("strong");
    editor.destroy();
  });

  test("a caret in the middle of an underlined word reads as underlined", () => {
    // The other half of the collapsed case: no stored marks, so the answer is
    // the marks at the caret. Without it a writer clicking into their own
    // underlined phrase sees three unpressed controls.
    const editor = editorOn("alpha beta");
    editor.selectRange(ALPHA_FROM, BETA_TO);
    editor.toggleUnderline();
    editor.caretToParagraph(0);
    expect(editor.selection()).toEqual({ from: BETA_TO, to: BETA_TO });
    // No stored marks here - the caret was MOVED, which clears them - so this
    // is the other arm: the marks at the caret.
    expect(editor.activeMarks().underline).toBe(true);
    editor.destroy();
  });

  test("a selection that is only PARTLY marked does not read as active", () =>{
    // The falsifiable half. `rangeHasMark` answers "anywhere in the range", so
    // an implementation using it would light the control up for a selection
    // that is mostly plain -- and pressing it would then REMOVE the emphasis
    // the writer could see, which is the opposite of what the pressed state
    // promised. "alpha" marked, "alpha beta" selected: not active.
    const editor = editorOn("alpha beta");
    editor.selectRange(ALPHA_FROM, ALPHA_TO);
    editor.toggleUnderline();
    editor.selectRange(ALPHA_FROM, BETA_TO);
    expect(editor.activeMarks().underline).toBe(false);
    editor.selectRange(ALPHA_FROM, ALPHA_TO);
    expect(editor.activeMarks().underline).toBe(true);
    editor.destroy();
  });

  test("onStateChange fires for a selection move as well as for an edit", () => {
    // onChange cannot serve the toolbar: it is guarded on `tr.docChanged`, so a
    // caret moved into an underlined word would leave the control unpressed
    // over prose that is underlined. This is a SECOND callback, not a widened
    // one -- the flush must still not be armed by a caret jump.
    const seen: string[] = [];
    const editor = createEditor(
      document.createElement("div"),
      { kind: "blocks", blocks: [{ type: "paragraph", text: "alpha beta" }] },
      { onChange: () => seen.push("change"), onStateChange: () => seen.push("state") },
    );
    editor.selectRange(BETA_FROM, BETA_TO);
    expect(seen).toEqual(["state"]);
    editor.typeChar("x");
    expect(seen).toEqual(["state", "change", "state"]);
    editor.destroy();
  });
});

describe("Editor.wordCount", () => {
  test("reports the live document's count, across blocks and after typing", () => {
    const editor = createEditor(document.createElement("div"), {
      kind: "blocks",
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "paragraph", text: "two" },
      ],
    });
    expect(editor.wordCount()).toBe(2);
    editor.caretToParagraph(1);
    editor.typeChar(" ");
    editor.typeChar("x");
    expect(editor.wordCount()).toBe(3);
    editor.destroy();
  });
});
