// app/ui/src/diff-view.ts
// How a diff is PAINTED. `diff.ts` decides what changed; this decides what a
// reader sees.
//
// ONE RENDERER, for the same reason there is one `diff.ts`: a second one drifts
// from the first, and the two surfaces that show a diff here -- version history
// and the readable mirror's change set -- must not disagree about which side of
// a comparison is which. The design's own words are that a diff whose direction
// a reader has to guess is a diff they will read backwards, and reading a review
// surface backwards is how someone accepts the wrong side.
//
// Extracted from `history.ts` when the change set needed it. Nothing about the
// rule changed in the move.
import type { DiffPiece } from "./diff";

/** Paint the pieces into `target`, replacing whatever was there.
 *
 *  `<del>` and `<ins>`, not two styled spans, because the distinction has to
 *  reach a reader who is not looking at the colours. Those elements carry it in
 *  the markup itself - an assistive client is told a run is a deletion rather
 *  than being handed the same anonymous text twice - and the stylesheet then
 *  adds a strike and an underline, so the difference is carried by SHAPE as
 *  well as by hue. Colour alone fails every reader who cannot separate the two,
 *  and a diff read with the two sides confused is worse than none.
 */
export function renderPieces(target: Element, pieces: readonly DiffPiece[]): void {
  const frag = document.createDocumentFragment();
  for (const piece of pieces) {
    if (piece.op === "same") {
      frag.append(document.createTextNode(piece.text));
      continue;
    }
    const el = document.createElement(piece.op === "removed" ? "del" : "ins");
    el.className = piece.op === "removed" ? "diff-removed" : "diff-added";
    el.textContent = piece.text;
    frag.append(el);
  }
  target.replaceChildren(frag);
}
