// app/ui/src/numbering.ts
// What a new part, chapter or scene is called before the writer names it.
//
// `Untitled part` three times over is a tree a writer cannot read, and it was
// a reported defect. The replacement is
// `Part 1`, `Chapter 2`, `Scene 7` -- the LOWEST POSITIVE INTEGER not already in
// use by an item of that type.
//
// LOWEST FREE, not a count, and the difference is the whole feature. With
// `Chapter 1` and `Chapter 3` in the manuscript, a count answers 3 -- a title
// that already exists. And renaming `Chapter 1` to a real title FREES the 1,
// which is what "next free available number" means and what a count can never
// do.
//
// THE CATALOG CARRIES THE PATTERN, not the word. `item.numbered.chapter` is
// `"Chapter {n}"`, and the parser below is built from that same string with
// `{n}` as its capture -- so a translated build reads back exactly what it
// wrote, instead of scanning a German manuscript for the English word
// "Chapter". This is the only place in the page where a message pattern is used
// in both directions, and it is why the pattern is passed in rather than
// resolved here: a rule that reaches for the catalog itself cannot be tested
// without pinning a language.
import type { ProjectItem } from "./store/source";

/** The `{n}` slot, as the catalog writes it. */
const SLOT = "{n}";

/** Everything in a translated string that a regex would otherwise read as
 *  syntax. A catalog is text a person wrote, not a pattern: a locale whose word
 *  for a part ends in a period would match every character in that position, and
 *  the numbering would then consume titles it never produced. */
function escapeRegExp(literal: string): string {
  // BOTH sides of the slot go through this, and both are mutated separately in
  // the pass: a build that escaped only the prefix passed every test written
  // for the prefix.
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The number in `title`, if `pattern` is what produced it. `null` otherwise.
 *
 *  Anchored at both ends: without that, "Chapter 4 revisited" would consume the
 *  number 4 while not being a title this rule ever wrote, and a writer who
 *  annotated a title would silently lose a number.
 *
 *  Only positive integers. `Chapter 0` and `Chapter -2` are titles a writer may
 *  type and are not values this rule produces, so they free nothing and consume
 *  nothing.
 */
export function numberIn(pattern: string, title: string): number | null {
  const slot = pattern.indexOf(SLOT);
  if (slot === -1) return null;
  const before = escapeRegExp(pattern.slice(0, slot));
  const after = escapeRegExp(pattern.slice(slot + SLOT.length));
  const match = new RegExp(`^${before}(\\d+)${after}$`).exec(title);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The title a new `itemType` should carry.
 *
 *  TRASHED ITEMS STILL HOLD THEIR NUMBERS. Deliberate, and the argument is
 *  recoverability rather than tidiness: a deleted chapter can be restored, and
 *  restoring it beside a live chapter of the same name is a collision the writer
 *  did not create. The walk this is handed includes the bin, and nothing here
 *  filters it.
 */
export function nextNumberedTitle(
  items: readonly ProjectItem[],
  itemType: string,
  pattern: string,
): string {
  // NO GUARD FOR A PATTERN WITH NO PLACEHOLDER, and its absence is deliberate.
  // The first draft had one -- an early return of the pattern itself -- and the
  // mutation deleting it SURVIVED, because the rest already answers correctly:
  // `numberIn` returns null with no slot, so nothing is used, and `replace` on
  // a string that does not contain SLOT returns it unchanged. A guard no input
  // can reach is worse than none, because a reader credits it for a refusal
  // that never happens. Same ruling as `import_name_ok` in the host.
  const used = new Set<number>();
  for (const item of items) {
    if (item.type !== itemType) continue;
    const n = numberIn(pattern, item.title);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return pattern.replace(SLOT, String(n));
}
