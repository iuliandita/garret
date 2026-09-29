// app/ui/src/spell-redraw.ts
// Make WebKit forget one word's spelling marker (111).
//
// THE CHECKER IS WEBKIT'S AND ITS MARKERS LIVE ON DOM TEXT NODES. Adding a word
// to the dictionary changes what the NEXT check answers; it does not revisit a
// marker already drawn, and no editing command runs when a word is added, so
// the underline the writer just asked to remove would stay until they typed
// into that paragraph. This plugin puts an inline decoration over the word for
// one transaction and takes it off in the next: ProseMirror redraws the text
// under a changed decoration set from fresh text nodes, and a fresh node
// carries no marker. Nothing in the document changes, so nothing flushes and
// the undo history gains no step -- a transaction re-inserting the same text
// would have been a document change, and ProseMirror reuses the DOM text node
// for identical text anyway, which leaves the marker exactly where it was.
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PmNode } from "prosemirror-model";

export const spellRedrawKey = new PluginKey<DecorationSet>("spell-redraw");

/** The class the passing decoration carries. Styled by nothing: it exists
 *  to make the decoration set differ, not to paint. */
export const SPELL_REDRAW_CLASS = "spell-redraw";

export type SpellRedrawMeta = { from: number; to: number } | { clear: true };

export function spellRedrawPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: spellRedrawKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, value, _old, next) {
        const meta = tr.getMeta(spellRedrawKey) as SpellRedrawMeta | undefined;
        if (meta !== undefined && "clear" in meta) return DecorationSet.empty;
        if (meta !== undefined) return decorationOver(next.doc, meta.from, meta.to);
        if (!tr.docChanged) return value;
        return value.map(tr.mapping, next.doc);
      },
    },
    props: {
      decorations: (state) => spellRedrawKey.getState(state),
    },
  });
}

function decorationOver(doc: PmNode, from: number, to: number): DecorationSet {
  if (from < 0 || to > doc.content.size || from >= to) return DecorationSet.empty;
  return DecorationSet.create(doc, [Decoration.inline(from, to, { class: SPELL_REDRAW_CLASS })]);
}
