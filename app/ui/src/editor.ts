// app/ui/src/editor.ts
// A single-scene ProseMirror surface: typing latency needs a real typing
// target, but manuscript virtualization is a second independent variable.
// Holding it out keeps the navigator the only thing that differs between the
// control and the test.
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { type MarkType, type Node as PmNode, Schema } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { CorpusBlock } from "./fixture/source";
import { countWords } from "./words";
import { locateFirstMatch } from "./find-locate";
import { nextMatchAfter, planReplacements, planSelected } from "./replace";
import { focusPlugin, typewriterScrollTop } from "./writing-modes";
import { type CommentAnchor, commentsKey, commentsPlugin } from "./comments";
import { type CastNamePair, CAST_MARK_CLASS, castMarksKey, castMarksPlugin } from "./cast-marks";
import { isOneWord, wordAround, type WordRange } from "./word-at";
import { spellRedrawKey, spellRedrawPlugin } from "./spell-redraw";
import { EditSourceTracker, type EditSourceChange } from "./edit-source";

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  // Both the tag forms and the inline-style forms are listed because the two
  // arrive from different places: a word processor pastes styles, a web page
  // pastes tags, and a novelist does both.
  marks: {
    em: {
      // `font-style=italic` is an exact value match, and `italic` is the literal
      // every source emits for it -- unlike font-weight below.
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    strong: {
      // The two font-weight rules are prosemirror-schema-basic's, and they are
      // not interchangeable with `{ style: "font-weight=bold" }`: `matchStyle`
      // compares the value by exact string equality, and Google Docs and a
      // modern Word HTML export emit `font-weight: 700`. So the value has to be
      // tested rather than matched -- the keyword forms, and any weight of 500
      // or more.
      //
      // `clearMark` is the other half. A word processor wraps a run in <b> and
      // un-bolds part of it with an explicit weight of 400, so without a rule
      // that REMOVES the mark the whole run pastes in bold, silently changing
      // the writer's emphasis.
      parseDOM: [
        { tag: "strong" },
        { tag: "b" },
        { style: "font-weight=400", clearMark: (m) => m.type.name === "strong" },
        { style: "font-weight", getAttrs: (v) => /^(bold(er)?|[5-9]\d{2,})$/.test(v) && null },
      ],
      toDOM: () => ["strong", 0],
    },
    // UNDERLINE IS A REAL MARK AND MARKDOWN CANNOT CARRY IT. That asymmetry is
    // the whole of the decision behind this mark: the export DROPS it, on
    // the same fall-through every unrecognised mark takes, and the host COUNTS
    // the drop so the writer is told in the export notice. Emitting `<u>` into
    // the Markdown was rejected -- it breaks the escaper, the importer and the
    // readable mirror's accept path, and the third silently strips every
    // underline in the document.
    //
    // `text-decoration=underline` is an exact value match and is the literal a
    // word processor emits, like `font-style=italic` and unlike font-weight.
    underline: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
      toDOM: () => ["u", 0],
    },
  },
});

export interface PmNodeJson {
  type: string;
  text?: string;
  content?: PmNodeJson[];
}

export type DocInput =
  | { kind: "blocks"; blocks: CorpusBlock[] }
  | { kind: "pmjson"; json: PmNodeJson };

/** Pure: one schema, two entry formats. Exported so it is testable without a DOM. */
export function docJsonFrom(input: DocInput): PmNodeJson {
  if (input.kind === "pmjson") return input.json;
  const paragraphs: PmNodeJson[] = input.blocks
    .filter((b) => b.text.length > 0)
    .map((b) => ({ type: "paragraph", content: [{ type: "text", text: b.text }] }));
  return {
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }],
  };
}

/** A stored body this build can open, or null.
 *
 *  THE SCHEMA CHANGE IS THE MIGRATION, and it runs both ways. Adding `underline`
 *  means a file written here holds a mark an OLDER build has no type for, and
 *  `schema.nodeFromJSON` answers that with `RangeError: There is no mark type
 *  underline in this schema`. Every load site used to hand a `JSON.parse`
 *  result straight in, so that throw arrived from the middle of a document
 *  swap: at mount it was a blank window, and after mount it was an unhandled
 *  rejection and nothing on screen at all.
 *
 *  The Rust side is deliberately permissive by contrast -- an unrecognised node
 *  contributes its descendants' text (`store::document_text`) -- so the
 *  asymmetry is real and it is the page's. This is the cheap half of the
 *  answer, which is all the underline record asks for: ASK FIRST, and let the
 *  caller report. It does not attempt to salvage the body; a build that cannot
 *  read a document must not offer to edit it, because the first keystroke would
 *  write whatever it managed to keep over the writer's scene.
 *
 *  Returns the JSON rather than a boolean so the caller cannot parse twice and
 *  cannot pass a DIFFERENT string to the editor than the one that was checked.
 */
export function readableBody(body: string): PmNodeJson | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  try {
    schema.nodeFromJSON(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
  return parsed as PmNodeJson;
}

/** Clamp a seeded ordinal onto the document's current paragraph count. Pure, so
 *  the workload can draw a fixed-range integer and the document can grow under
 *  it without the draw ever going out of range. Wraps forward on a negative
 *  input: `n % childCount` alone yields a negative index, which ProseMirror only
 *  rejects deep inside `doc.child()` at soak time. */
export function paragraphTarget(childCount: number, n: number): number {
  if (childCount < 1) {
    throw new Error(`paragraphTarget: childCount ${childCount} has no paragraph to target`);
  }
  return ((n % childCount) + childCount) % childCount;
}

/** A paragraph break at the caret. Pure: takes a state, returns a transaction,
 *  dispatches nothing. */
export function splitTr(state: EditorState): Transaction {
  return state.tr.split(state.selection.from);
}

/** One character back, or null when the caret sits at a paragraph start and
 *  there is nothing inside the paragraph to erase. Null is a real no-op the
 *  caller still measures and counts: a Backspace at a boundary costs a keystroke
 *  in a real session too, and dropping the action would make the action count
 *  depend on document shape. */
export function erasePrevTr(state: EditorState): Transaction | null {
  const { $from, from } = state.selection;
  if ($from.parentOffset === 0) return null;
  return state.tr.delete(from - 1, from);
}

/** Caret to the end of paragraph `n`, wrapped onto the live paragraph count.
 *  End rather than start, because a writer returning to a paragraph continues
 *  it; typing at the start would prepend, which reads as corruption in the
 *  serialized body. */
export function caretTr(state: EditorState, n: number): Transaction {
  const target = paragraphTarget(state.doc.childCount, n);
  let start = 0;
  for (let i = 0; i < target; i++) start += state.doc.child(i).nodeSize;
  // start is the position BEFORE the node; +1 enters it, + content.size reaches
  // the end of its text.
  const inside = start + 1 + state.doc.child(target).content.size;
  return state.tr.setSelection(TextSelection.create(state.doc, inside));
}

/** The word count of a live ProseMirror document, per the spec's rule: every
 *  text node concatenated with a single space between adjacent block nodes,
 *  then counted by the one shared `countWords`. The separator is load-bearing --
 *  without it two paragraphs "one" and "two" concatenate to "onetwo" and count
 *  as one word. Marks are invisible here by construction: `textBetween` reads
 *  text nodes, not their marks. */
export function countWordsIn(doc: PmNode): number {
  return countWords(doc.textBetween(0, doc.content.size, " "));
}

/** The plain-text projection of a STORED body, for comparing two of them.
 *
 *  Through the schema and `textBetween`, NOT through a fresh walk of the JSON.
 *  A fourth restatement of the projection rule is a fourth thing that can drift
 *  from `store::append_node`, and this one has no Rust twin holding it honest:
 *  a diff is only ever read against another diff of the same rule, so a wrong
 *  projection would be self-consistent and invisible. `countWordsIn` above
 *  already rests on this exact equivalence -- one space between block nodes,
 *  marks invisible -- and the word figures beside a diff have to agree with the
 *  ones in the bar.
 *
 *  Throws on a body that is not this schema's JSON. That is the right answer
 *  for a caller who is about to paint it: the alternative is an empty string,
 *  which renders as "the whole scene was deleted". */
export function bodyText(body: string): string {
  const doc = schema.nodeFromJSON(JSON.parse(body) as unknown as Record<string, unknown>);
  return doc.textBetween(0, doc.content.size, " ");
}

/** Which of the three formatting marks the selection carries WHOLE. Pure, so it
 *  can be reasoned about and tested without a view.
 *
 *  Two cases, and they are genuinely different questions:
 *
 *   - A COLLAPSED CARET asks what the next character typed would carry.
 *     `storedMarks` is set by a toggle pressed with nothing selected and is
 *     null otherwise, in which case the marks at the caret are the answer.
 *     Without this, pressing Bold and then typing would show an unpressed
 *     control over text arriving in bold.
 *   - A RANGE asks whether EVERY text node in it carries the mark, which is
 *     `doc.rangeHasMark`'s complement rather than `rangeHasMark` itself. See
 *     `Editor.activeMarks` for why the looser question is the wrong one.
 */
export interface SelectionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box a selection occupies, from the view's `coordsAtPos` at both ends.
 *  Pure, so the collapsed-selection guard can be tested at its own boundary:
 *  happy-dom's `coordsAtPos` answers nothing usable, and a test through the
 *  view could not tell a guarded collapsed range from an unguarded one.
 *  Null for a collapsed range (asked of nothing), for a `coords` that throws
 *  (an unrendered or detached view, as in scrollToTypewriterLine), and for a
 *  union with no extent. */
export function unionSelectionRect(
  from: number,
  to: number,
  coords: (pos: number) => SelectionBox,
): SelectionBox | null {
  if (from === to) return null;
  let start: SelectionBox;
  let end: SelectionBox;
  try {
    start = coords(from);
    end = coords(to);
  } catch {
    return null;
  }
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  if (right - left === 0 && bottom - top === 0) return null;
  return { left, top, right, bottom };
}

export function activeMarksIn(state: EditorState): ActiveMarks {
  const { from, to, empty, $from } = state.selection;
  const carried = (type: MarkType): boolean => {
    if (empty) {
      const marks = state.storedMarks ?? $from.marks();
      return type.isInSet(marks) !== null && type.isInSet(marks) !== undefined;
    }
    let everywhere = true;
    let sawText = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText) return true;
      sawText = true;
      if (!type.isInSet(node.marks)) everywhere = false;
      return false;
    });
    // A selection holding no text at all (an empty paragraph swept over) is not
    // "entirely marked": answering true there would light every control up over
    // nothing.
    return sawText && everywhere;
  };
  return {
    bold: carried(schema.marks.strong),
    italic: carried(schema.marks.em),
    underline: carried(schema.marks.underline),
  };
}

/** The editing behavior a human needs and the synthetic workload does not: key
 *  bindings and an undo history. Exported as a list rather than built inline so
 *  it can be tested against an EditorState, with no EditorView and no browser.
 *
 *  `history()` must be present for `undo`/`redo` to have state to act on, but
 *  its position in this list does not matter: verified by swapping it past
 *  `keymap(baseKeymap)` and re-running the mutation tests with no failures.
 *  `baseKeymap` binds none of `Mod-z`/`Mod-y`/`Shift-Mod-z`/`Mod-i`/`Mod-b`/`Mod-u`
 *  (its only Mod bindings are `Mod-Enter`, `Mod-Backspace`, `Mod-Delete` and
 *  `Mod-a`, plus the mac Ctrl-/Alt- variants), so the keymap plugins do not
 *  currently compete for any key either. */
export function editorPlugins(): Plugin[] {
  return [
    history(),
    keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
    keymap({
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-b": toggleMark(schema.marks.strong),
      // FREE, on the same reasoning as the two above and checked the same way:
      // `baseKeymap` binds no `Mod-u` (its only Mod bindings are `Mod-Enter`,
      // `Mod-Backspace`, `Mod-Delete` and `Mod-a`, plus the mac variants), so
      // the keymap plugins do not compete for it either.
      "Mod-u": toggleMark(schema.marks.underline),
    }),
    keymap(baseKeymap),
    // LAST, so its decoration is computed against the state every other plugin
    // has already had its say about. It contributes no keys and no transaction
    // filter, so its position cannot change behaviour - but a decoration plugin
    // ahead of the keymaps reads as though it might.
    focusPlugin(),
    // Same reasoning, and after focus for a second one: both draw, and the
    // stylesheet reads more predictably when the comment underline is the
    // innermost of the two. Decoration order does not decide nesting in
    // ProseMirror, so this is legibility rather than behaviour, and it is said
    // out loud so nobody credits the order for something it does not do.
    commentsPlugin(),
    // LAST OF ALL: the cast mark is the quietest of the three decorations (a
    // 45%-opacity dotted underline) and reads most predictably as the
    // outermost one when a comment or a writer's own underline overlaps a
    // name.
    castMarksPlugin(),
    // Draws nothing a reader can see; its decoration exists for one
    // transaction at a time (111). Last, so it is outside every real one.
    spellRedrawPlugin(),
  ];
}

export interface Editor {
  typeChar(char: string): void;
  /** Enter. */
  splitParagraph(): void;
  /** Backspace. A no-op at a paragraph start, by design (see erasePrevTr). */
  erasePrev(): void;
  /** Jump to paragraph `n`, wrapped onto the live paragraph count. */
  caretToParagraph(n: number): void;
  /** Replace the whole document. A NEW EditorState, so the undo history does
   *  not cross documents: an undo that reached back into another scene's text
   *  would be corruption the user could not see coming.
   *
   *  Applied with updateState, deliberately NOT as a document-replacing
   *  transaction: updateState does not run dispatchTransaction, so no onChange
   *  fires. session.switchTo sets the new document id immediately before
   *  calling this, with no await between, and a transaction here would mark the
   *  newly opened document dirty with its own unedited body. */
  replaceDoc(input: DocInput): void;
  /** Prevent document-changing transactions while a host-side replacement is
   *  being reconciled. DOM editability alone does not stop toolbar commands. */
  setEditable(editable: boolean): void;
  /** Select the first occurrence of `query` in the open document and scroll it
   *  into view. Returns whether it landed.
   *
   *  A SELECTION, not a decoration: the browser already draws one, a writer
   *  already knows what one means, and the next keystroke replaces the word
   *  that was looked for - which is usually the point of looking for it.
   *
   *  Selection-only, so `tr.docChanged` is false and no onChange fires. The
   *  standing rule that a caret jump must never mark the document dirty is
   *  therefore enforced by ProseMirror here rather than restated.
   *
   *  False is not an error. See `locateFirstMatch`. */
  revealMatch(query: string): boolean;
  /** Tell the editor where this document's notes are, as the store holds them.
   *
   *  Replaces the whole list. Sent as transaction META rather than through a
   *  setter, because plugin state may only move through a transaction - and the
   *  transaction changes no document, so `docChanged` is false and no onChange
   *  fires. A note is not an edit.
   *
   *  Called on every document open and after every create or resolve. Positions
   *  arriving here describe the document as the store holds it, so nothing is
   *  mapped and any earlier cap is cleared. */
  setCommentAnchors(anchors: readonly CommentAnchor[]): void;
  /** Replace which names the cast-marks plugin looks for. Sent as transaction
   *  META for the identical reason `setCommentAnchors` is: plugin state may
   *  only change through a transaction, the transaction changes no document,
   *  so `docChanged` is false and no onChange fires. An empty list is how the
   *  "Mark cast names" preference turned off is expressed -- see project.ts. */
  setCastNames(names: readonly CastNamePair[]): void;
  /** The DOM element and member id of the cast mark the caret sits inside, or
   *  null when it is not inside one. The Ctrl+Shift+I route to the hover
   *  card: it has no pointer to anchor on, so it needs the element itself. */
  castMarkAtCaret(): { element: HTMLElement; memberId: string } | null;
  /** The word the caret touches, or the selection when it is exactly one
   *  word: what `Edit > Add word to dictionary` adds. Null with the caret
   *  between two spaces, or a selection spanning more than a word. Read from
   *  the textblock's own text, so a mark boundary inside the word is not a
   *  word boundary. */
  wordAtCaret(): WordRange | null;
  /** Redraw one range's text from fresh DOM nodes so WebKit's spelling
   *  marker on it is gone (111, `spell-redraw.ts`). No document change. */
  redrawSpelling(from: number, to: number): void;
  /** Where those notes are NOW, after every transaction since. This is what
   *  rides the flush. */
  commentAnchors(): readonly CommentAnchor[];
  /** Whether mapping was refused for this document. The flush must then send
   *  nothing rather than the positions it stopped maintaining. */
  commentsCapped(): boolean;
  /** The plain text of a range, for quoting a passage a note is on. Empty for a
   *  range outside the document, which is what an orphan's collapsed pair is. */
  textIn(from: number, to: number): string;
  /** Select a range and scroll it into view. False when the range does not fit
   *  the live document, which is an answer rather than an error: a panel row can
   *  outlive the prose it points at. */
  selectRange(from: number, to: number): boolean;
  /** The current selection as document positions.
   *
   *  Exists because the browser's own selection is not readable under the test
   *  environment: happy-dom does no layout, so `document.getSelection()` is
   *  empty whatever ProseMirror did, and an assertion against it passes for
   *  every implementation including none. The claim that a writer SEES the word
   *  selected is carried by the graded find run, which reads it off AT-SPI's
   *  text interface against a live window. */
  selection(): { from: number; to: number };
  /** The selection's box in viewport coordinates, or null when the
   *  selection is collapsed or the view has no layout (happy-dom). The
   *  union of coordsAtPos at both ends, which is right for one line and a
   *  usable envelope for several. */
  selectionRect(): SelectionBox | null;
  /** Replace the selected occurrence of `query` with `replacement`, then select
   *  the next occurrence in this document. If the selection is not exactly an
   *  occurrence, replaces nothing and selects the next one instead - which is
   *  what "Replace" means on a panel the writer has only just opened.
   *
   *  Returns whether text was replaced. False with a match still selected is
   *  the ordinary first press; false with nothing selected means the document
   *  holds no occurrence at all. */
  replaceMatch(query: string, replacement: string): boolean;
  /** Replace EVERY occurrence in the open document, in ONE transaction, and
   *  report how many, plus how many were LEFT because they span a paragraph
   *  break (replacing one of those would merge the two blocks - see replace.ts).
   *  Reported rather than dropped in silence: "replace all" that quietly left
   *  some behind is a worse promise than one that says how many and why. One transaction so one Ctrl+Z reverses the whole thing:
   *  a writer who replaces forty occurrences and regrets it must not have to
   *  press undo forty times, and must not be able to stop half way through by
   *  accident.
   *
   *  The open document only. See replace.ts for why that is a safety decision
   *  rather than an unfinished one. */
  replaceAll(query: string, replacement: string): { replaced: number; spanning: number };
  /** Exposed for tests and for the Edit menu. The keymap already binds both, so
   *  these are a SECOND caller of the same command and not a second binding:
   *  the menu must not own a keystroke, or the shortcut it advertises and the
   *  shortcut that works become two things that can drift. */
  undo(): void;
  redo(): void;
  /** The three formatting commands, for the toolbar. Second callers of the same
   *  `toggleMark` the keymap binds, on exactly the reasoning above: a button
   *  that owned its own transaction would be a second implementation of a
   *  chord, and the two would drift on the first change to either. */
  toggleBold(): void;
  toggleItalic(): void;
  toggleUnderline(): void;
  /** Which of the three the WHOLE selection carries, for the toolbar's pressed
   *  state.
   *
   *  THE WHOLE SELECTION, never "anywhere in it". `rangeHasMark` answers the
   *  looser question, and a control lit up for a selection that is mostly plain
   *  promises the opposite of what pressing it does: `toggleMark` on a partly
   *  marked range MARKS the rest, so the button would say "on" and then turn it
   *  further on. For a collapsed caret the answer is the marks that would apply
   *  to the next character typed - stored marks if a toggle has just been
   *  pressed, otherwise the marks at the caret - which is what makes pressing a
   *  control before typing work at all. */
  activeMarks(): ActiveMarks;
  focus(): void;
  /** The current document, serialized the way the store holds it. */
  serialize(): string;
  /** The open scene's word count, read from the live document so the display
   *  unit never has to reach into ProseMirror. */
  wordCount(): number;
  /** Hides or shows the ProseMirror DOM without touching its state (102: a
   *  timeline replaces it as #editor's visible content while one is open,
   *  the same recorded exception to `#editor`'s `will-change` rule that
   *  timeline-view.ts's own header explains). The EditorState, its undo
   *  history and its layout are all untouched -- this is `view.dom.hidden`
   *  and nothing else, restored the moment a prose document opens again. */
  setHidden(hidden: boolean): void;
  destroy(): void;
}

/** Which formatting the selection carries. Three booleans and not a set of mark
 *  names: the toolbar has three controls, they are independent, and a set would
 *  invite a fourth caller to ask about a mark no control shows. */
export interface ActiveMarks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface EditorOptions {
  /** Called after a transaction that CHANGED THE DOCUMENT is applied. Selection
   *  changes do not call it: `tr.docChanged` is false for those, which is the
   *  rule "a caret jump must never mark the document dirty", now enforced by
   *  ProseMirror instead of by a lookup table. */
  onChange?: (change: EditSourceChange) => void;
  /** Called after EVERY applied transaction, a selection move included.
   *
   *  A SECOND CALLBACK, deliberately: the flush is armed by onChange, and the
   *  standing rule that a caret jump must never mark the document dirty is
   *  enforced by ProseMirror's `docChanged` rather than restated. The toolbar
   *  needs the wider signal - a caret moved into an underlined word changes no
   *  document and must still repaint the pressed state - so it gets its own. */
  onStateChange?: () => void;
  /** The view's element took or lost focus. The bubble toolbar shows only
   *  while the editor has focus, and a blur whose relatedTarget is the
   *  bubble itself is not a loss. Bound to the view's DOM inside
   *  createEditor so the view stays private, like onStateChange. */
  onFocus?: () => void;
  onBlur?: (event: FocusEvent) => void;
}

export function createEditor(
  mount: HTMLElement,
  input: DocInput,
  opts: EditorOptions = {},
): Editor {
  const doc = schema.nodeFromJSON(docJsonFrom(input) as unknown as Record<string, unknown>);
  /** Keep the caret's line at the typewriter anchor, if the mode is on.
   *
   *  READS THE ROOT ATTRIBUTE rather than taking the mode as a dep. The
   *  preference is applied to the document element before first paint by the
   *  head script and changed there by the preferences panel; threading it in
   *  here would be a second copy of the same state, and the two would disagree
   *  the moment one of them was updated and the other was not.
   *
   *  Every step is guarded because none of it exists under happy-dom: there is
   *  no layout, `coordsAtPos` throws on an unrendered view, and the pane has no
   *  height. A throw here would be thrown from inside `dispatchTransaction`,
   *  i.e. from every keystroke.
   */
  /** Set while a frame is already booked, so a burst of transactions produces
   *  ONE layout read rather than one each. */
  let typewriterPending = false;

  function holdTypewriterLine(): void {
    if (typeof document === "undefined") return;
    // The cheap half, and it runs on EVERY transaction: one attribute read, no
    // layout. Everything below is deferred.
    if (document.documentElement.getAttribute("data-typewriter") !== "on") return;
    if (typewriterPending) return;
    if (typeof requestAnimationFrame !== "function") return;
    typewriterPending = true;
    // COALESCED INTO A FRAME, not run here. `coordsAtPos` and
    // getBoundingClientRect are layout reads, and doing them synchronously
    // inside dispatchTransaction forces a layout on every keystroke - the exact
    // shape of the word-count rescan that cost measurable typing latency while
    // every scalar gate stayed green. Once per frame is also all the scroll
    // position can be seen at.
    requestAnimationFrame(() => {
      typewriterPending = false;
      scrollToTypewriterLine();
    });
  }

  function scrollToTypewriterLine(): void {
    // Re-checked in the frame: the writer can turn the mode off between the
    // transaction and the callback, and a scroll they did not ask for is worse
    // than a frame's delay.
    if (document.documentElement.getAttribute("data-typewriter") !== "on") return;
    const pane = mount.closest("#editor");
    if (!(pane instanceof HTMLElement)) return;
    let caretTop: number;
    try {
      caretTop = view.coordsAtPos(view.state.selection.head).top;
    } catch {
      // An unrendered or detached view. Nothing to scroll to, and a caret
      // position is not worth an exception on the typing path.
      return;
    }
    const box = pane.getBoundingClientRect();
    if (box.height <= 0) return;
    pane.scrollTop = typewriterScrollTop(box.top, box.height, pane.scrollTop, caretTop);
  }

  let editable = true;
  const editSources = new EditSourceTracker();
  const view: EditorView = new EditorView(mount, {
    state: EditorState.create({ doc, plugins: editorPlugins() }),
    dispatchTransaction(tr) {
      if (tr.docChanged && !editable) return;
      const before = view.state;
      if (tr.docChanged) editSources.prepare(tr);
      view.updateState(before.apply(tr));
      if (tr.docChanged) {
        const change = editSources.record(tr, before, view.state, () => countWordsIn(before.doc));
        opts.onChange?.(change);
      }
      // AFTER onChange, so a listener that reads the document sees the same
      // state this one does, and outside the docChanged guard because that is
      // the whole reason it is a separate callback.
      opts.onStateChange?.();
      // AFTER updateState, so the caret is measured where it now is rather than
      // where it was. Outside the docChanged guard on purpose: a caret moved by
      // an arrow key changes no document and still has to be brought to the
      // anchor line, which is most of what typewriter mode is for.
      holdTypewriterLine();
    },
  });
  const onFocus = (): void => opts.onFocus?.();
  const onBlur = (event: FocusEvent): void => opts.onBlur?.(event);
  view.dom.addEventListener("focus", onFocus);
  view.dom.addEventListener("blur", onBlur);
  return {
    typeChar(char: string): void {
      const { state } = view;
      view.dispatch(state.tr.insertText(char, state.selection.from));
    },
    splitParagraph(): void {
      view.dispatch(splitTr(view.state));
    },
    erasePrev(): void {
      const tr = erasePrevTr(view.state);
      if (tr !== null) view.dispatch(tr);
    },
    caretToParagraph(n: number): void {
      view.dispatch(caretTr(view.state, n));
    },
    replaceDoc(input: DocInput): void {
      const next = schema.nodeFromJSON(docJsonFrom(input) as unknown as Record<string, unknown>);
      view.updateState(EditorState.create({ doc: next, plugins: editorPlugins() }));
      editSources.reset();
    },
    setEditable(next: boolean): void {
      editable = next;
      view.setProps({ editable: () => editable });
    },
    revealMatch(query: string): boolean {
      const at = locateFirstMatch(view.state.doc, query);
      if (at === null) return false;
      // scrollIntoView on the transaction, not an element scroll: the editor
      // may be inside a scrolling container and ProseMirror knows where the
      // position actually rendered.
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, at.from, at.to))
          .scrollIntoView(),
      );
      return true;
    },
    replaceMatch(query: string, replacement: string): boolean {
      const { state } = view;
      const hit = planSelected(state.doc, query, {
        from: state.selection.from,
        to: state.selection.to,
      });
      if (hit === null) {
        // Nothing to replace yet: select the next occurrence so the writer's
        // second press acts on something. Reported as `false` because no text
        // changed, which is the honest answer and the one the panel's count
        // depends on.
        const next = nextMatchAfter(state.doc, query, state.selection.from);
        if (next === null) return false;
        view.dispatch(
          state.tr.setSelection(TextSelection.create(state.doc, next.from, next.to)).scrollIntoView(),
        );
        return false;
      }
      const tr = state.tr.replaceWith(
        hit.from,
        hit.to,
        replacement.length === 0 ? [] : schema.text(replacement, [...hit.marks]),
      ).setMeta("wordSource", "unattributed");
      // The next occurrence, located in the document the replacement produced
      // rather than in the one it was planned against - the replacement may be
      // longer or shorter than what it replaced, so every later position moved.
      const after = hit.from + replacement.length;
      const next = nextMatchAfter(tr.doc, query, after);
      if (next !== null) {
        tr.setSelection(TextSelection.create(tr.doc, next.from, next.to)).scrollIntoView();
      }
      view.dispatch(tr);
      return true;
    },
    replaceAll(query: string, replacement: string): { replaced: number; spanning: number } {
      const { state } = view;
      const { replacements: plan, spanning } = planReplacements(state.doc, query);
      // A COST guard, not a correctness one, and stated as such so a reader does
      // not credit it for a refusal it never makes: dispatching a transaction
      // with no steps leaves docChanged false, fires no onChange, records no
      // history event and serializes identically. Removing it is unobservable
      // through this interface, which a mutation confirmed. What it buys is not
      // building and dispatching a transaction to do nothing.
      if (plan.length === 0) return { replaced: 0, spanning };
      const tr = state.tr.setMeta("wordSource", "unattributed");
      // BACK TO FRONT. Applied left to right, every replacement shifts the
      // positions of the ones after it by the length difference, and a
      // replacement longer than its query lands progressively further into the
      // prose - silently, in the writer's manuscript.
      for (let i = plan.length - 1; i >= 0; i--) {
        const hit = plan[i];
        if (hit === undefined) continue;
        tr.replaceWith(
          hit.from,
          hit.to,
          replacement.length === 0 ? [] : schema.text(replacement, [...hit.marks]),
        );
      }
      view.dispatch(tr);
      return { replaced: plan.length, spanning };
    },
    setCommentAnchors(anchors: readonly CommentAnchor[]): void {
      view.dispatch(view.state.tr.setMeta(commentsKey, anchors));
    },
    commentAnchors: () => commentsKey.getState(view.state)?.anchors ?? [],
    commentsCapped: () => commentsKey.getState(view.state)?.capped ?? false,
    setCastNames(names: readonly CastNamePair[]): void {
      view.dispatch(view.state.tr.setMeta(castMarksKey, { names }));
    },
    castMarkAtCaret(): { element: HTMLElement; memberId: string } | null {
      let dom: Node;
      try {
        ({ node: dom } = view.domAtPos(view.state.selection.from));
      } catch {
        return null;
      }
      const el = dom instanceof HTMLElement ? dom : dom.parentElement;
      const mark = el?.closest<HTMLElement>(`.${CAST_MARK_CLASS}`) ?? null;
      if (mark === null) return null;
      const memberId = mark.dataset.memberId;
      if (memberId === undefined) return null;
      return { element: mark, memberId };
    },
    wordAtCaret(): WordRange | null {
      const { from, to, $from } = view.state.selection;
      if (to > from) {
        const selected = view.state.doc.textBetween(from, to, " ");
        if (!isOneWord(selected)) return null;
        // The trimmed word's own positions, not the selection's: a
        // double-click in WebKit takes the trailing space along.
        const lead = selected.length - selected.trimStart().length;
        const text = selected.trim();
        return { from: from + lead, to: from + lead + text.length, text };
      }
      if (!$from.parent.isTextblock) return null;
      const inBlock = wordAround($from.parent.textContent, $from.parentOffset);
      if (inBlock === null) return null;
      const start = $from.start();
      return { from: start + inBlock.from, to: start + inBlock.to, text: inBlock.text };
    },
    redrawSpelling(from: number, to: number): void {
      view.dispatch(view.state.tr.setMeta(spellRedrawKey, { from, to }));
      view.dispatch(view.state.tr.setMeta(spellRedrawKey, { clear: true }));
    },
    textIn(from: number, to: number): string {
      const size = view.state.doc.content.size;
      if (from < 0 || to > size || from >= to) return "";
      return view.state.doc.textBetween(from, to, " ");
    },
    selectRange(from: number, to: number): boolean {
      const size = view.state.doc.content.size;
      if (from < 0 || to > size || from >= to) return false;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, from, to))
          .scrollIntoView(),
      );
      return true;
    },
    selection: () => ({ from: view.state.selection.from, to: view.state.selection.to }),
    selectionRect(): SelectionBox | null {
      const { from, to } = view.state.selection;
      return unionSelectionRect(from, to, (pos) => view.coordsAtPos(pos));
    },
    toggleBold(): void {
      toggleMark(schema.marks.strong)(view.state, view.dispatch);
    },
    toggleItalic(): void {
      toggleMark(schema.marks.em)(view.state, view.dispatch);
    },
    toggleUnderline(): void {
      toggleMark(schema.marks.underline)(view.state, view.dispatch);
    },
    activeMarks: () => activeMarksIn(view.state),
    undo(): void {
      undo(view.state, view.dispatch);
    },
    redo(): void {
      redo(view.state, view.dispatch);
    },
    focus: () => view.focus(),
    serialize: () => JSON.stringify(view.state.doc.toJSON()),
    wordCount: () => countWordsIn(view.state.doc),
    setHidden: (hidden: boolean) => {
      view.dom.hidden = hidden;
    },
    destroy: () => {
      view.dom.removeEventListener("focus", onFocus);
      view.dom.removeEventListener("blur", onBlur);
      view.destroy();
    },
  };
}
