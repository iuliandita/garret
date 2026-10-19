// app/ui/src/trailing-block.ts
// A figure or scene break is an atom block, so a document that ends in one has
// no position after it for a caret. Keeping a textblock last is what lets a
// writer carry on past the figure. The paragraph is empty: every exporter
// already drops a blank paragraph, and it adds no words.
import { Fragment, type Node as PmNode } from "prosemirror-model";
import { Plugin, type Transaction } from "prosemirror-state";

export function endsInTextblock(doc: PmNode): boolean {
  return doc.lastChild?.isTextblock ?? true;
}

/** Appends the empty paragraph to `tr` when its document ends in an atom. */
export function appendTrailingTextblock(tr: Transaction): Transaction {
  if (endsInTextblock(tr.doc)) return tr;
  return tr.insert(tr.doc.content.size, tr.doc.type.schema.nodes.paragraph.create());
}

/** The same rule for a document that is about to become editor state. */
export function withTrailingTextblock(doc: PmNode): PmNode {
  if (endsInTextblock(doc)) return doc;
  return doc.type.create(doc.attrs, doc.content.append(Fragment.from(doc.type.schema.nodes.paragraph.create())), doc.marks);
}

/** Only a transaction that changed the document can leave it ending in an atom,
 *  so a caret move never edits the text. It joins the transaction that caused
 *  it, which keeps it in the same undo event and the same change callback. */
export function trailingTextblockPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some(tr => tr.docChanged)) return null;
      const tr = appendTrailingTextblock(state.tr);
      return tr.docChanged ? tr : null;
    },
  });
}
