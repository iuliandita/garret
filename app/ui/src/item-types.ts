// app/ui/src/item-types.ts
// The item type strings the page and the host both know, in one place.
//
// DELIBERATELY RESTATED from the store's constants rather than shared, in the
// same spirit as the word-count rule stated in both `words.ts` and `words.rs`:
// there is no build step joining the page and the host, and these strings are
// the wire contract between them. A change to either side without the other
// must break a test rather than pass silently.
//
// THEIR OWN MODULE, and not `outline.ts`, because `placement.ts` needs them and
// `outline.ts` imports `placement.ts`. A re-export from the unit that happens to
// have owned `TRASH_TYPE` first would be an import cycle written as a
// convenience.

/** The item type of the bin deleted items are moved into.
 *
 *  Identified by TYPE and never by title: a writer may legitimately name a
 *  chapter "Trash", and this type is not something the outline can produce. */
export const TRASH_TYPE = "trash";

/** The item type of the section holding what belongs to the project and is not
 *  the book: the synopsis, the world building, the notes.
 *
 *  TRASH WITH THE SIGN FLIPPED. It is a root item with its own type in the same
 *  tree, and every consumer that asks "what is the book" excludes its subtree by
 *  walking from that root -- which is the shape the bin already proves end to
 *  end. Visible and editable rather than inert is the whole of the difference.
 *
 *  NOT A SECOND TREE. A second tree costs a second walk command, a second
 *  navigator, a second `base_rev` discipline and a duplicate of `item_move`'s
 *  position arithmetic, to express a distinction the type string already
 *  carries. */
export const BIBLE_TYPE = "bible";

/** A free-form document inside the bible.
 *
 *  ITS OWN TYPE, not a scene the writer parked somewhere. Two things depend on
 *  it: the store gives it a `doc` row (so it is written, flushed, versioned and
 *  snapshotted exactly like prose), and search LABELS a hit with the item's
 *  type -- so a `note` hit tells the writer they are looking at the bible while
 *  a `scene` hit would be indistinguishable from a chapter of the book. */
export const NOTE_TYPE = "note";

/** A container under the bible root. It has no document body; its children
 *  remain ordinary item rows with their existing ids and prose. */
export const BIBLE_FOLDER_TYPE = "bible-folder";

/** A story clock under the bible: tracks, branches and events, held as one
 *  opaque JSON body the page mints and the host never parses. It carries a
 *  `doc` row exactly like a bible note -- rename, bin, restore, snapshots
 *  and history all apply with no new store command -- but its body is not
 *  prose: it never reaches the word index, `project_find`'s corpus or a
 *  ProseMirror parse, which `open.ts`'s activation guard is what enforces on
 *  this side. */
export const TIMELINE_TYPE = "timeline";

/** The root types that are NOT the manuscript.
 *
 *  A LIST, and read as one everywhere, because the two behave identically in
 *  every rule that asks "is this row part of the book?" -- they differ only in
 *  the surfaces that deliberately keep one and not the other (search keeps the
 *  bible; nothing keeps the bin). Those surfaces name the type they mean.
 *
 *  THE MATTER SECTIONS ARE NOT IN THIS LIST AND MUST NEVER BE ADDED TO IT.
 *  Front matter is IN the book -- exported, mirrored, counted -- and this list
 *  is what "not the book" means. That is the whole of this third state, and
 *  `RESERVED_ROOT_TYPES` below is the other half of it. */
export const NON_MANUSCRIPT_ROOT_TYPES: readonly string[] = [TRASH_TYPE, BIBLE_TYPE];

/** The item type of the section whose documents print BEFORE the chapters: the
 *  dedication, the foreword, the epigraph.
 *
 *  `"front"`, not `"front-matter"`, because the host already spells
 *  `"front-matter"` for the YAML block at the top of a mirror file
 *  (`mirror::FRONT_MATTER`) and two unrelated concepts spelled the same way in
 *  one project is how a reader learns the wrong thing from a search. */
export const FRONT_MATTER_TYPE = "front";

/** The item type of the section whose documents print AFTER the chapters: the
 *  acknowledgements, the afterword.
 *
 *  TWO SECTIONS RATHER THAN ONE WITH A FLAG. Where a document prints is a
 *  property of the SECTION it is in, which the writer can see in the outline and
 *  change with the moves they already have -- and it costs nothing new, because
 *  both sections are the bin's shape for the third and fourth time. */
export const BACK_MATTER_TYPE = "back";

/** A document inside either matter section.
 *
 *  ONE TYPE FOR ALL FOUR KINDS. A dedication, a foreword, an
 *  afterword and an acknowledgements page differ in their TITLE and in which
 *  section they sit in, and in nothing any rule here can see. Four types would
 *  be four numbering series, four placement rules and four answers to what
 *  containment means -- which is the reach the design already warns against while
 *  adding types. */
export const MATTER_TYPE = "matter";

/** The two matter sections, read as one list wherever the question is "which
 *  section is this row in?". */
export const MATTER_ROOT_TYPES: readonly string[] = [FRONT_MATTER_TYPE, BACK_MATTER_TYPE];

/** Every root the writer did not make as a chapter of their book.
 *
 *  THE OTHER HALF OF THE THIRD STATE. `NON_MANUSCRIPT_ROOT_TYPES` answers "is
 *  this row part of the book?"; this answers "is this row a SECTION rather than
 *  part of the chapter sequence?", and the two disagree exactly on the matter
 *  sections. A rule about placement, adoption or the chapter sequence wants
 *  this one; a rule about what the book CONTAINS wants the other. */
export const RESERVED_ROOT_TYPES: readonly string[] = [
  ...NON_MANUSCRIPT_ROOT_TYPES,
  ...MATTER_ROOT_TYPES,
];
