// app/ui/src/spell-redraw.ts
// Make WebKit forget one word's spelling marker.
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

function numericDecorations(doc: PmNode, from = 0, to = doc.content.size): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, "\ufffc", "\ufffc");
    for (const token of text.matchAll(/\S+/gu)) {
      const bare = token[0].replace(/^\p{P}+|\p{P}+$/gu, "");
      if (/^\p{Nd}+$/u.test(bare)) {
        decorations.push(Decoration.inline(pos + 1 + token.index, pos + 1 + token.index + token[0].length, { spellcheck: "false" }));
      }
    }
    return false;
  });
  return decorations;
}

/** Native spelling stays enabled on words; numeric tokens opt out in the DOM only. */
export function numericSpellingPlugin(): Plugin<DecorationSet> {
  const key = new PluginKey<DecorationSet>("numeric-spelling");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => DecorationSet.create(state.doc, numericDecorations(state.doc)),
      apply(tr, previous) {
        if (!tr.docChanged) return previous;
        let next = previous.map(tr.mapping, tr.doc);
        const blocks = new Map<number, PmNode>();
        tr.mapping.maps.forEach((map, index) => {
          map.forEach((_oldFrom, _oldTo, from, to) => {
            const rest = tr.mapping.slice(index + 1);
            const start = Math.max(0, rest.map(from, -1) - 1);
            const end = Math.min(tr.doc.content.size, rest.map(to, 1) + 1);
            tr.doc.nodesBetween(start, end, (node, pos) => {
              if (!node.isTextblock) return true;
              blocks.set(pos, node);
              return false;
            });
          });
        });
        for (const [pos, node] of blocks) {
          next = next.remove(next.find(pos, pos + node.nodeSize));
          next = next.add(tr.doc, numericDecorations(tr.doc, pos, pos + node.nodeSize));
        }
        return next;
      },
    },
    props: { decorations: state => key.getState(state) },
  });
}
