// app/ui/src/cast-kinds.ts
// The three kinds of thing a book is about, in the order the panel shows them.
//
// DELIBERATELY RESTATED from the host's `store::cast::CAST_KINDS` rather than
// shared, exactly as `item-types.ts` restates the item types and for the same
// reason: there is no build step joining the page and the host, and these
// strings are the wire contract between them. A fourth kind added on one side
// only must break a test rather than pass silently, and `cast-panel.test.ts`
// parses the Rust source to make it one.
//
// THEIR OWN MODULE for `item-types.ts`'s reason as well: the panel needs them
// and so does the catalog lookup that names each group, and a re-export from
// whichever unit happened to own them first is an import cycle written as a
// convenience.
import type { IconName } from "./icons";

/** Somebody in the book. */
export const KIND_CHARACTER = "character";
/** Somewhere in the book. */
export const KIND_PLACE = "place";
/** Something in the book that is neither: a ship, a sword, a treaty, a scar.
 *  The word for the drawer everything else goes in. */
export const KIND_POI = "poi";

/** The closed set, IN THE ORDER A WRITER READS IT.
 *
 *  This order is the page's and the file's is not: `cast_list` orders by kind
 *  and name so two reads of an unchanged project agree, and the grouping here is
 *  what a writer actually sees. Keeping the two separate is what lets either
 *  change without the other. */
export const CAST_KINDS: readonly string[] = [KIND_CHARACTER, KIND_PLACE, KIND_POI];

/** The catalog key naming a GROUP of one kind ("Characters").
 *
 *  A FUNCTION rather than a table of keys, so an unknown kind arriving from a
 *  newer build's file cannot index into `undefined` and paint a group headed by
 *  a missing-key marker. It returns the key for the kinds this build knows and
 *  null for anything else, and the panel simply does not group what it cannot
 *  name. */
export function groupKeyFor(kind: string): string | null {
  return CAST_KINDS.includes(kind) ? `cast.group.${kind}` : null;
}

/** The catalog key naming ONE of a kind ("Character"), which is what a select
 *  option says. Its own key rather than a `.one`/`.other` pair on the group key,
 *  because those two suffixes mean CLDR plural categories everywhere else in
 *  this catalog and a base that looked like a plural but was not would be the
 *  one the plural guard cannot check. */
export function kindKeyFor(kind: string): string | null {
  return CAST_KINDS.includes(kind) ? `cast.kind.${kind}` : null;
}

/** The glyph naming ONE kind (096, W3): `user` for a character, `globe` for a
 *  place, `map-pin` for a point of interest. Null for a kind this build does
 *  not know, `kindKeyFor`'s own reason: a newer host's fourth kind must not
 *  index into `undefined` and paint a row with a missing icon where a glyph
 *  was expected. */
export function kindIconFor(kind: string): IconName | null {
  if (kind === KIND_CHARACTER) return "user";
  if (kind === KIND_PLACE) return "globe";
  if (kind === KIND_POI) return "map-pin";
  return null;
}
