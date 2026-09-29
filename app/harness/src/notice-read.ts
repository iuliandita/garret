// app/harness/src/notice-read.ts
// Reading a figure back out of a sentence the application showed a writer.
//
// A MODULE RATHER THAN A FUNCTION IN export-cli.ts, and that is a recorded rule
// in this repo rather than tidiness: a `*-cli.ts` aborts at module scope, so
// nothing can import one and no test can reach a rule written inside it.
// `expectedHeadingLevel` moved into markdown-read.ts for exactly this reason.
// A restated rule no test can reach is the "instrument nobody can falsify"
// shape.
//
// RESTATED FROM THE CATALOG, NEVER IMPORTED. The page and the harness are two
// programs, the same way the gate thresholds are restated from the spec rather
// than imported from either implementation. What is asserted by a graded run is
// that a WRITER WAS TOLD, so the figure has to come out of the sentence they
// were shown; a number the rig computed for itself would be the rig telling
// itself. What keeps the two from drifting silently is this module's TEST,
// which builds the sentence out of the catalog the page ships and hands it to
// the parser: a reworded notice fails the build instead of failing a graded run
// three hours later.

/** The number of dropped underlined runs the export notice reports, or null.
 *
 *  null is a THIRD STATE and never a zero. There is no notice when the banner
 *  had already removed itself (an info banner lives six seconds), and a notice
 *  that says nothing about underlining is what an export that dropped nothing
 *  produces -- neither is the application reporting a loss of none.
 *
 *  The digits are taken from the clause that mentions underlining, not from the
 *  whole sentence: the written path sits in the same sentence and routinely
 *  carries digits of its own (`my-novel-2.md`). */
export function reportedUnderlinesIn(notice: string | null): number | null {
  if (notice === null) return null;
  // NO SEPARATE "does this sentence mention underlining" CHECK. One stood here
  // and a mutation deleting it SURVIVED, correctly: the pattern below already
  // requires the word, so nothing could tell the two versions apart. Deleted
  // rather than kept on the `import_name_ok` precedent -- a guard nothing can
  // reach is worse than none, because a reader credits it for a refusal it
  // never makes.
  const match = /(?:so|and)\s+(\d[\d,]*)\s+underlined/i.exec(notice);
  if (match === null) return null;
  return Number((match[1] ?? "").replace(/,/g, ""));
}
