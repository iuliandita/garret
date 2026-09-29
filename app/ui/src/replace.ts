// app/ui/src/replace.ts
// Planning a replacement, as a pure function of a document.
//
// SCOPED TO THE OPEN SCENE, and that is a safety decision rather than a
// limitation nobody got round to lifting. Replace-all across a manuscript is the
// most destructive single action a writing application offers, and this
// application cannot yet undo one: ProseMirror's history is per open document,
// so scenes that were never opened have no entry to reverse, and the store keeps
// current state only - automatic history and named snapshots are unbuilt. A
// manuscript-wide replace today would be an operation with no inverse performed
// on the thing the application exists to protect.
//
// Inside one scene every replacement is an ordinary transaction: it lands in the
// undo history that is already there, Ctrl+Z reverses it, and the flush
// scheduler persists it by the same path as typing. No new durability claim, no
// new recovery claim, no schema change.
//
// Nothing here touches the view. `plan` returns positions and text; applying
// them is `editor.ts`'s job, which is what makes the marks rule below testable
// without an EditorView.
import type { Mark, Node as PmNode } from "prosemirror-model";
import { locateMatches, type MatchRange } from "./find-locate";

export interface Replacement extends MatchRange {
  /** The marks the replacement text carries. */
  marks: readonly Mark[];
}

/** The marks at the START of a match.
 *
 *  A match can span a mark boundary - "bewitched" with only "witch" italicised
 *  is three text nodes - and there is no answer that is right for every case.
 *  Taking the start's marks means a replacement inherits the run it began in,
 *  which is what a writer replacing a word inside an italicised phrase expects.
 *
 *  NOT the marks at the caret, and not `storedMarks`: text typed adjacent to a
 *  marked run inherits that run's marks, which is a recorded hazard that has
 *  already broken one rig's persistence gate. A replacement is not typing.
 */
function marksAt(doc: PmNode, from: number): readonly Mark[] {
  // `from + 1`, NOT `from`, and the difference is the whole rule.
  //
  // `ResolvedPos.marks()` reports the marks that would apply to text INSERTED at
  // the position, which it takes from the node BEFORE it. At `from` - the
  // boundary where the match begins - that node is whatever run the match is
  // leaving, so "plain |storm| plain" with storm emphasised reports NO marks and
  // the replacement loses the emphasis the writer put there. Resolving one unit
  // in puts the position inside the match's own first character, so the node
  // before it is the run the match actually sits in.
  //
  // `from + 1` is always within the document: a match has from < to <= size.
  return doc.resolve(from + 1).marks();
}

/** Whether a match sits entirely inside ONE text block.
 *
 *  It need not. `locateMatches` projects the document the way the host does,
 *  with a synthetic separator between blocks, so "cat sat" matches across the
 *  end of one paragraph and the start of the next. That is right for FIND - the
 *  phrase is there, and the panel should say so.
 *
 *  It is wrong for REPLACE. `tr.replaceWith` over a range spanning two blocks
 *  MERGES them, so a writer who typed a two-word phrase into the replace field
 *  would lose a paragraph break they never touched, in prose they had already
 *  written. Search and replace do not get to share a match rule here.
 */
function withinOneBlock(doc: PmNode, range: MatchRange): boolean {
  return doc.resolve(range.from).sameParent(doc.resolve(range.to));
}

/** What a replace-all would do, and what it deliberately would not. */
export interface ReplacePlan {
  /** The replacements to apply, in document order. */
  replacements: Replacement[];
  /** Matches left alone because they span a paragraph break. Reported rather
   *  than dropped in silence: "replace all" that quietly left some behind is a
   *  worse promise than one that says how many and why. */
  spanning: number;
}

/** Every replacement `query` implies in `doc`, in document order.
 *
 *  Callers apply these BACK TO FRONT. Replacing left to right shifts every
 *  later position by the length difference, and a replacement longer than its
 *  query then lands progressively further into the prose - silently, and in the
 *  writer's manuscript. Returning document order and stating the rule is
 *  deliberate: the reverse iteration belongs at the call site where the
 *  transaction is built, and a `planReversed` here would only move the trap.
 */
export function planReplacements(doc: PmNode, query: string): ReplacePlan {
  const plan: ReplacePlan = { replacements: [], spanning: 0 };
  for (const range of locateMatches(doc, query)) {
    if (!withinOneBlock(doc, range)) {
      plan.spanning += 1;
      continue;
    }
    plan.replacements.push({ ...range, marks: marksAt(doc, range.from) });
  }
  return plan;
}

/** The replacement for the range currently selected, if that range is a match.
 *
 *  Returns null when the selection is not exactly an occurrence of `query`,
 *  which is the ordinary case on the first press of Replace: the writer has
 *  opened a result and the panel has selected the match for them, but a writer
 *  who then clicked elsewhere has a selection that means something else. The
 *  caller's answer to null is to find and select the next match rather than to
 *  report a failure - "Replace" on a fresh panel means "find one and replace it".
 */
export function planSelected(
  doc: PmNode,
  query: string,
  selection: { from: number; to: number },
): Replacement | null {
  // NO EMPTY-SELECTION GUARD. There was one; a mutation deleting it survived,
  // because a match of a non-empty needle always spans at least one unit, so no
  // range in `matches` can ever have from === to and the equality below refuses
  // an empty selection on its own. A guard no input can reach is worse than
  // none - a reader credits it for a refusal it never makes.
  const matches = locateMatches(doc, query);
  const hit = matches.find((m) => m.from === selection.from && m.to === selection.to);
  if (hit === undefined) return null;
  // Same rule as replace-all, and it has to be here too: the selection the panel
  // put on a match can itself span a paragraph break, and replacing it would
  // merge the two blocks.
  if (!withinOneBlock(doc, hit)) return null;
  return { ...hit, marks: marksAt(doc, hit.from) };
}

/** The first match strictly after `pos`, wrapping to the top of the document.
 *
 *  Wrapping, because a writer working down a scene and reaching the end has not
 *  finished with the scene - they have finished with the part after their
 *  caret. Returns null only when the document holds no match at all, so the
 *  caller can tell "nothing here" from "nothing more here", which are different
 *  things to tell someone.
 */
export function nextMatchAfter(doc: PmNode, query: string, pos: number): MatchRange | null {
  const matches = locateMatches(doc, query);
  return matches.find((m) => m.from >= pos) ?? matches[0] ?? null;
}
