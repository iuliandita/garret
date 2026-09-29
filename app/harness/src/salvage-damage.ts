// app/harness/src/salvage-damage.ts
// The scripted damage `salvage-cli` inflicts, as DATA.
//
// THIS IS WHY THIS RIG'S ORACLE IS FREE. 046 specified it in one sentence --
// "damage the file in a fixed scripted way ... its ORACLE IS FREE because the
// damage is scripted, which is exactly what grading an EPUB or a PDF proof
// lacks". Every step below breaks exactly one thing and names the loss kinds
// salvage owes for it, by the constant names `salvage.rs` publishes. Nothing
// here is derived from `salvage.rs`; the kinds and their meanings are 046's,
// 048's, 049's and 050's loss tables, restated as the harness restates every
// threshold.
//
// It lives outside `salvage-cli.ts` because a rule written inside a `*-cli.ts`
// is unmutatable: those files abort at module scope, so no test can import them.

/** Salvage's loss kinds, restated. The strings are the machine contract a script
 *  reading `manifest.json` keys off, so a rig that misspelt one would report a
 *  missing loss on a correct recovery. */
export const KIND_UNREADABLE_BODY = "unreadable_body";
export const KIND_ORPHAN_DOC = "orphan_doc";
export const KIND_ORPHAN_SYNOPSIS = "orphan_synopsis";
export const KIND_ORPHAN_COMMENT = "orphan_comment";
export const KIND_ORPHAN_APPEARANCE = "orphan_appearance";
export const KIND_ORPHAN_CAST_FIELD = "orphan_cast_field";
export const KIND_MISSING_BLOB = "missing_blob";
export const KIND_MISSING_COVER = "missing_cover";
export const KIND_UNREADABLE_DESIGN_ROW = "unreadable_design_row";

/** A SQL string literal. Item ids are generated and hold no quote today, so this
 *  is a habit and not a fix -- but a rig that interpolates a title, or a fixture
 *  generator that ever emits one, turns a missing escape into a damage step that
 *  silently does nothing and a gate that reports the recovery as broken. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface DamageTargets {
  /** The scene whose stored body is replaced with bytes no document parser can
   *  read. Its item row SURVIVES, so the loss is the body and not the row. */
  corruptedScene: string;
  /** The item row that is deleted outright, orphaning its document, its
   *  synopsis, its notes and the tag pointing at it. */
  deletedItem: string;
  /** The cast member deleted out from under its own detail rows. */
  deletedMember: string;
  /** The `meta` key whose value is replaced with bytes that are not UTF-8. */
  designKey: string;
  /** The cover file removed from the project's picture directory. */
  removedCover: string;
}

export interface DamageStep {
  name: string;
  /** Statements run against a COPY of the seeded project. */
  sql: string[];
  /** Bare filenames removed from `<stem>.pictures/`. */
  removeFiles: string[];
  /** The loss kinds this step alone owes. */
  expects: string[];
}

/** The corrupted body is written as this. It is not JSON, so `serde_json`
 *  refuses it and the bytes go out verbatim as `<id>.raw` -- 046's
 *  `KIND_UNREADABLE_BODY`, "a row that READ and did not PARSE". A body that
 *  would not READ is a different kind and needs a different injury. */
export const CORRUPT_BODY = "not a document at all {";

/** X'ff' is a one-byte BLOB and not valid UTF-8, so the column reads as the
 *  wrong type and the row fails at the fetch. It is the smallest injury that
 *  reaches a row-level read failure through SQL alone: page-level corruption is
 *  the only other route and no test or rig in this repo constructs one. */
const UNREADABLE_VALUE = "X'ff'";

export function damagePlan(t: DamageTargets): DamageStep[] {
  assertDistinctTargets(t);
  return [
    {
      name: "an item row is gone and its document, summary, notes and tag are not",
      sql: [`DELETE FROM item WHERE id = ${sqlString(t.deletedItem)}`],
      removeFiles: [],
      expects: [
        KIND_ORPHAN_DOC,
        KIND_ORPHAN_SYNOPSIS,
        KIND_ORPHAN_COMMENT,
        KIND_ORPHAN_APPEARANCE,
      ],
    },
    {
      name: "a stored body no longer parses as a document",
      sql: [
        `UPDATE doc SET body = ${sqlString(CORRUPT_BODY)} ` +
          `WHERE item_id = ${sqlString(t.corruptedScene)}`,
      ],
      removeFiles: [],
      expects: [KIND_UNREADABLE_BODY],
    },
    {
      name: "a cast member is gone and its details and tag are not",
      sql: [`DELETE FROM cast_member WHERE id = ${sqlString(t.deletedMember)}`],
      removeFiles: [],
      expects: [KIND_ORPHAN_CAST_FIELD, KIND_ORPHAN_APPEARANCE],
    },
    {
      name: "the bytes every stored version names are gone",
      sql: ["DELETE FROM blob"],
      removeFiles: [],
      expects: [KIND_MISSING_BLOB],
    },
    {
      name: "one design row will not read",
      sql: [`UPDATE meta SET value = ${UNREADABLE_VALUE} WHERE key = ${sqlString(t.designKey)}`],
      removeFiles: [],
      expects: [KIND_UNREADABLE_DESIGN_ROW],
    },
    {
      name: "the front cover the book still names is not on disk",
      sql: [],
      removeFiles: [t.removedCover],
      expects: [KIND_MISSING_COVER],
    },
  ];
}

/** Every kind the plan owes, deduplicated and ordered.
 *
 *  ORDERED because the rig compares this against the recovery's own kinds and a
 *  verdict line that changed with the plan's writing order would be evidence
 *  about the plan. DEDUPLICATED because two steps can owe one kind --
 *  `orphan_appearance` has an end at each of them -- and a kind demanded twice
 *  would never be satisfied by a recovery that reports each kind once. */
export function expectedLossKinds(plan: DamageStep[]): string[] {
  return [...new Set(plan.flatMap((step) => step.expects))].sort();
}

/** Refuse a plan whose steps land on one row.
 *
 *  Deleting the item whose body is corrupted, or corrupting the body of the item
 *  that is deleted, collapses two steps into one damage: the `unreadable_body`
 *  the second step owes never appears, and `salvage_damage_is_reported` reports
 *  a correct recovery as having missed a loss. Reachable by one wrong argument
 *  at the call site, which is exactly how a rig's targets are chosen. */
export function assertDistinctTargets(t: DamageTargets): void {
  if (t.corruptedScene === t.deletedItem) {
    throw new Error(
      `damage targets collide: ${t.corruptedScene} is both the item deleted and the item whose ` +
        "body is corrupted, so one of the two losses can never be reported.",
    );
  }
}
