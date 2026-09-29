// app/ui/src/comments.ts
// Where a note points, kept true while the writer keeps typing.
//
// A comment is anchored to a RANGE of a scene, and the scene goes on changing
// under it. Every other way of holding that anchor is worse:
//
//  - A character OFFSET goes stale on the first insertion above it, silently,
//    and the note ends up on a different sentence with nothing saying so.
//  - A COPY OF THE TEXT re-found by searching is the same failure with an extra
//    step, because a passage that occurs twice is found in the wrong place and a
//    passage that was edited is not found at all.
//  - A MARK stored in the document makes a note part of the prose: it would be
//    exported, counted, diffed and restored along with it, and the schema would
//    have to migrate.
//
// So: ProseMirror positions, mapped through `tr.mapping` on every transaction.
// That is exact -- it is the same machinery the editor uses to keep the caret
// where the writer left it -- and it costs O(comments) per document change,
// which is ON THE KEYSTROKE PATH and therefore bounded. See MAX_MAPPED_COMMENTS.
//
// THE MAPPING IS A PURE FUNCTION AND IT LIVES HERE, not inside
// `dispatchTransaction`. Logic in an unimportable place goes uncovered, which is
// a recorded failure of this repo twice over (`main.ts`, and the mutation that
// survived until `loading.ts` was extracted). `mapAnchors` takes a mapping-
// shaped object, so every rule below is testable with no editor, no view and no
// layout.
import { isCompositionKey } from "./composition-key";
import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** One note, as the host lists it. Field names are the host's, snake_case by
 *  the recorded rule: command ARGUMENTS are camelCase, returned struct fields
 *  are not. */
export interface CommentRow {
  readonly id: number;
  readonly item_id: string;
  readonly body: string;
  readonly anchor_from: number;
  readonly anchor_to: number;
  /** The passage as it read when the note was made. The only thing an orphan
   *  has left to name its subject with. */
  readonly quote: string;
  readonly orphaned: boolean;
  readonly resolved: boolean;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Where one note sits in the live document. */
export interface CommentAnchor {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  /** Settled notes are still mapped -- reopening one must not bring it back
   *  pointing somewhere it never pointed -- and are not drawn. */
  readonly resolved: boolean;
}

/** The most notes on one document this build will map while the writer types.
 *
 *  RESTATED in `app/shell-tauri/src-tauri/src/store/comments.rs` as
 *  `MAX_COMMENTS_PER_DOCUMENT`, which refuses to write past the same number.
 *  The two cannot import each other; `test/comments.test.ts` parses the Rust and
 *  fails when they disagree. Same shape as the word rule, stated in both
 *  languages on purpose: a shared constant would hide a drift, two statements
 *  and a test fail on it.
 *
 *  WHY THERE IS A CEILING AT ALL. Mapping runs inside `apply`, i.e. once per
 *  document-changing transaction, i.e. once per typed character. Each comment
 *  costs two `mapping.map` calls and one object, so the whole job is a few
 *  hundred nanoseconds at the tens of notes a heavily annotated scene carries.
 *  It is linear in a number that lives in a FILE, though, and a file is not
 *  something this application gets to assume anything about -- the store is not
 *  the only thing that can write one. An unbounded loop on the typing path is
 *  the shape of the recorded per-flush rescan, which cost measurable latency
 *  while every scalar gate stayed green.
 *
 *  WHAT HAPPENS PAST IT. Mapping stops for that document and says so: the
 *  anchors are returned UNCHANGED, `mapped` is false, the page stops decorating
 *  and stops sending positions with the flush, and the panel prints a sentence
 *  saying the positions are no longer being tracked. Not "map some of them" --
 *  a half-mapped set is a set where some notes are right and some are wrong with
 *  nothing distinguishing them. Not "keep going anyway" -- that is the cost this
 *  ceiling exists to refuse. The last positions written are the last ones known
 *  to be correct, so closing and reopening the scene shows them where they were.
 */
export const MAX_MAPPED_COMMENTS = 500;

/** The part of a ProseMirror `Mapping` this module uses.
 *
 *  Structural rather than the imported type, so a test can hand it three lines
 *  of arithmetic instead of building a document and a transform. `assoc` is
 *  ProseMirror's: -1 associates the position with the content BEFORE it, 1 with
 *  the content after. */
export interface PositionMapping {
  map(pos: number, assoc?: number): number;
}

export interface MapResult {
  readonly anchors: readonly CommentAnchor[];
  /** False when the ceiling refused the job. The anchors are then the ones that
   *  went in, untouched. */
  readonly mapped: boolean;
}

/** Move every anchor through one transaction's mapping.
 *
 *  THE TWO ENDS TAKE OPPOSITE ASSOCIATIONS, and that is the rule that decides
 *  what a comment covers:
 *
 *    - `from` maps with assoc 1, so text typed at the very start of the passage
 *      lands OUTSIDE the note.
 *    - `to` maps with assoc -1, so text typed at the very end lands outside it
 *      too.
 *
 *  Together: an insertion strictly INSIDE the passage grows the note, an
 *  insertion at either edge does not. That is what a writer means by "this
 *  sentence" -- they annotated what was there, and a note that swallowed
 *  whatever was typed against its edge would quietly change what it is about.
 *
 *  A DELETION THAT TAKES THE WHOLE PASSAGE COLLAPSES BOTH ENDS onto the same
 *  position, so `from >= to` and the note is ORPHANED. That is derived here and
 *  in the store from the same pair, never stored as a flag, and it is
 *  PERMANENT: a collapsed pair cannot grow again, because with these two
 *  associations an insertion at a point leaves both ends of it where they were.
 *  Which is the intended answer. Re-anchoring an orphan onto neighbouring prose
 *  is the single worst thing this feature could do -- the writer would read a
 *  note about prose that is gone as though it were about the prose that is
 *  there, and nothing on screen would tell them otherwise.
 */
export function mapAnchors(
  anchors: readonly CommentAnchor[],
  mapping: PositionMapping,
  ceiling: number = MAX_MAPPED_COMMENTS,
): MapResult {
  if (anchors.length > ceiling) return { anchors, mapped: false };
  const out: CommentAnchor[] = [];
  for (const anchor of anchors) {
    out.push({
      id: anchor.id,
      from: mapping.map(anchor.from, 1),
      to: mapping.map(anchor.to, -1),
      resolved: anchor.resolved,
    });
  }
  return { anchors: out, mapped: true };
}

/** Whether an anchor still points at a passage. Stated once, here, because the
 *  decoration rule, the panel and the flush all ask it and a second spelling is
 *  a second answer. */
export function isOrphaned(anchor: { from: number; to: number }): boolean {
  return anchor.from >= anchor.to;
}

/** The class the stylesheet marks a commented passage with. */
export const COMMENT_CLASS = "comment-anchor";

/** Which anchors are drawn.
 *
 *  An ORPHAN is not drawn because it has no range to draw. A RESOLVED note is
 *  not drawn because it is settled and the prose it was about should read as
 *  prose again -- it is still listed, under the panel's toggle, which is what
 *  "kept, never deleted" means in practice.
 *
 *  Separate from the decoration builder so the rule is assertable without
 *  prosemirror-view: happy-dom does no layout, and a DecorationSet is not
 *  something a test can read positions back out of usefully. */
export function decoratedAnchors(
  anchors: readonly CommentAnchor[],
): readonly CommentAnchor[] {
  return anchors.filter((a) => !a.resolved && !isOrphaned(a));
}

export interface CommentPluginState {
  readonly anchors: readonly CommentAnchor[];
  /** Latched once the ceiling refuses a mapping. Latched rather than recomputed
   *  because the positions are stale from that moment on: dropping back under
   *  the ceiling later would not make the ones we stopped mapping correct
   *  again. Reopening the scene is what clears it, by rebuilding the state from
   *  what the store holds. */
  readonly capped: boolean;
  /** DERIVED from the two above, and a cache rather than a second fact: it is
   *  rebuilt in `apply` on the same line the anchors move, so the two cannot
   *  disagree. Held because `props.decorations` runs on every view update,
   *  including ones that changed nothing, and rebuilding a set of up to
   *  MAX_MAPPED_COMMENTS there would put that work on a repaint. */
  readonly decorations: DecorationSet;
}

/** Replace the whole anchor list. Carried as transaction meta rather than as a
 *  setter on the plugin, because plugin state may only change through a
 *  transaction -- and a transaction is also what makes the change visible to
 *  the view in one place. */
export const commentsKey = new PluginKey<CommentPluginState>("comments");

function buildDecorations(doc: PmNode, anchors: readonly CommentAnchor[]): DecorationSet {
  const decorations = decoratedAnchors(anchors).map((anchor) =>
    Decoration.inline(anchor.from, anchor.to, {
      class: COMMENT_CLASS,
      // So a capture and a rig can tell WHICH note a mark belongs to. Not an
      // accessibility channel: the panel is where a note is read.
      "data-comment-id": String(anchor.id),
    }),
  );
  return DecorationSet.create(doc, decorations);
}

/** Underline the passages that carry a note.
 *
 *  A DECORATION, not a class written onto the rendered paragraph, for the reason
 *  `focusPlugin` records: ProseMirror owns the DOM it renders and a hand-set
 *  class is removed the next time that node is redrawn -- silently, and only for
 *  the paragraph being edited, which is the one the writer is looking at.
 *
 *  Its state is the anchor list, and `apply` is the ONE place positions move.
 */
export function commentsPlugin(): Plugin<CommentPluginState> {
  return new Plugin<CommentPluginState>({
    key: commentsKey,
    state: {
      init: (_config, state) => ({
        anchors: [],
        capped: false,
        decorations: buildDecorations(state.doc, []),
      }),
      apply(tr, value, _old, next) {
        const replacement = tr.getMeta(commentsKey) as readonly CommentAnchor[] | undefined;
        if (replacement !== undefined) {
          // A fresh list from the store. It describes the document as it now is,
          // so nothing is mapped and the cap starts clean.
          return {
            anchors: replacement,
            capped: false,
            decorations: buildDecorations(next.doc, replacement),
          };
        }
        if (!tr.docChanged) return value;
        if (value.anchors.length === 0) return value;
        // NO `if (value.capped) return value` here, deliberately, and the
        // mutation that deleted one is what settled it: the anchor list only
        // changes through the meta above (which clears the cap) or through this
        // mapping (which preserves its length), so a capped document is capped
        // again on the next call and the early return could not be told from
        // its absence by any input. A guard nothing can reach is worse than no
        // guard, because a reader credits it - the recorded `import_name_ok`
        // precedent. The cost of leaving it out is one length comparison per
        // keystroke, which is what the ceiling is for.
        const result = mapAnchors(value.anchors, tr.mapping);
        if (!result.mapped) {
          // Stop, and keep the anchors as they last were. Drawing them after
          // this point would underline prose they are no longer about.
          return {
            anchors: value.anchors,
            capped: true,
            decorations: DecorationSet.empty,
          };
        }
        return {
          anchors: result.anchors,
          capped: false,
          decorations: buildDecorations(next.doc, result.anchors),
        };
      },
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.decorations,
    },
  });
}

/** Ctrl+Alt+M (Cmd+Alt+M), or null.
 *
 *  A pure predicate rather than a condition inside a listener, for the reason
 *  every chord in this application is one: the listener is on the document and
 *  cannot be reached by a test without a page, and a chord that is nearly right
 *  is a chord that fires on the wrong keystroke.
 *
 *  `event.key` is compared case-insensitively because a keyboard with Shift
 *  held, or a layout that reports the uppercase form, is still the same chord -
 *  and refusing Shift outright would mean a writer who has not let go of it
 *  gets nothing and no explanation.
 *
 *  REFUSES AN ALREADY-PREVENTED EVENT, the same rule the navigation-history
 *  chord follows: a surface that has already claimed this keystroke keeps it. */
export function isAddCommentChord(event: KeyboardEvent): boolean {
  if (isCompositionKey(event)) return false;
  if (event.defaultPrevented) return false;
  if (event.key.toLowerCase() !== "m") return false;
  if (!event.altKey) return false;
  return event.ctrlKey || event.metaKey;
}

/** What a flush should say about one document's notes.
 *
 *  EXTRACTED rather than written inline in the flush closure, for the recorded
 *  reason: logic in `project.ts`'s assembly cannot be reached by a test, and
 *  three mutations of this rule survived the whole suite while it lived there.
 *
 *  `undefined` means "leave them alone" and is not the same answer as an empty
 *  list. Three cases return it and each is a different sentence:
 *
 *   - The document is not the open one. Nothing else can have been edited, so
 *     nothing else can have moved, and a flush of scene A must never write
 *     scene B's positions.
 *   - Mapping has been capped. The positions the page holds are the ones it
 *     stopped maintaining, so the last ones written are the last ones known to
 *     be right - writing what we know is stale over them would be the one thing
 *     the ceiling exists to prevent.
 *   - There are none. Sending `[]` would be the page claiming this document
 *     holds no notes, which it is not in a position to say: it knows what it was
 *     told, not what the store holds.
 */
export function flushAnchorsFor(
  activeDocId: string | undefined,
  itemId: string,
  capped: boolean,
  anchors: readonly CommentAnchor[],
): { id: number; from: number; to: number }[] | undefined {
  if (activeDocId !== itemId) return undefined;
  if (capped) return undefined;
  if (anchors.length === 0) return undefined;
  return anchors.map((a) => ({ id: a.id, from: a.from, to: a.to }));
}
