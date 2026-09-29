// app/harness/test/mirror-gates.test.ts
// The mirror rig's gates, exercised in both directions -- in the style of
// context-gates.test.ts.
//
// 080 ADDS THE PAIR THAT GRADES A ROW'S OWN ACCEPT FOR THE FIRST TIME.
// Before this, only the batch control (`#mirror-changes-accept-all`) was ever
// pressed by any rig; the per-row accept moved with every row's own state
// sentence and nothing pressed it. One gate alone -- "the pressed row's words
// reached the book" -- would also PASS a build that pressed the BATCH control
// in the per-row press's place, because the batch takes every comparable row
// too. The pair is what a batch-in-disguise cannot satisfy: the SECOND file's
// words must stay OUT of the book at the same moment the first file's are in
// it.
//
// THE PAIR IS COMPUTED FROM THE RIGHT ROWS in the rig, never from "any body in
// the store" -- `row_accept_took_its_file` and `row_accept_left_the_other_file`
// stay booleans here because that check lives in mirror-cli.ts's own read
// (`doc.item_id === targetId` / `=== otherId`), where a GUI run and not this
// suite is what can fail it; nothing below asserts on raw store rows for that
// reason.
//
// THE FIRST SABOTAGE RUN PROVED A SECOND CLASS OF DEFECT: fewer per-row accept
// controls than this rig needs used to THROW, killing the run and its other
// nine gates with it. `row_accepts_offered` and `row_accept_pressed` are the
// review that followed -- a skip is now a red gate with a result behind it,
// never a stack trace with none.
import { expect, test } from "bun:test";
import { evaluateMirrorGates, type MirrorMetrics } from "../src/gates";

const BEFORE_ACCEPTING_ONE = "Before accepting 1 change from the readable folder";

/** A run in which everything went right: the per-row press landed, then the
 *  batch, each leaving its own "Before accepting" snapshot. Each test spoils
 *  exactly one field. */
const GOOD: MirrorMetrics = {
  fixture: "tiny",
  files_written: 6,
  store_documents: 5,
  file_holds_the_typed_sentence: true,
  file_holds_the_second_sentence: true,
  external_edit_survived_the_reopen: true,
  rows_offered: 2,
  accepted_body_in_the_store: true,
  snapshot_labels: [BEFORE_ACCEPTING_ONE, BEFORE_ACCEPTING_ONE],
  comments_planted: 1,
  comments_orphaned: 1,
  file_unchanged_after_accept: true,
  manifest_matches_the_file: true,
  row_accepts_offered: 2,
  row_accept_pressed: true,
  row_accept_took_its_file: true,
  row_accept_left_the_other_file: true,
  row_accept_file_unchanged: true,
  row_accept_manifest_matches_the_file: true,
  peak_rss_mb: 420,
};

/** GOOD, but the per-row press was skipped -- the batch is the only accept
 *  that ran, so exactly one "Before accepting" snapshot is owed and both
 *  per-row gates read false. */
const SKIPPED: MirrorMetrics = {
  ...GOOD,
  row_accepts_offered: 1,
  row_accept_pressed: false,
  row_accept_took_its_file: false,
  row_accept_left_the_other_file: false,
  row_accept_file_unchanged: false,
  row_accept_manifest_matches_the_file: false,
  snapshot_labels: [BEFORE_ACCEPTING_ONE],
};

function verdictOf(m: MirrorMetrics, gate: string): string {
  const found = evaluateMirrorGates(m).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate ${gate}`);
  return found.verdict;
}

function valueOf(m: MirrorMetrics, gate: string): string {
  const found = evaluateMirrorGates(m).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate ${gate}`);
  return String(found.value);
}

test("a good run passes every gate", () => {
  expect(evaluateMirrorGates(GOOD).every((v) => v.verdict === "PASS")).toBe(true);
});

test("mirror_row_accept_takes_that_file FAILs when the pressed row's words never reached the store", () => {
  expect(verdictOf({ ...GOOD, row_accept_took_its_file: false }, "mirror_row_accept_takes_that_file")).toBe(
    "FAIL",
  );
});

test("mirror_row_accept_leaves_the_other_row FAILs when the second file's words reached the book too", () => {
  // The defect this pair exists to catch: a per-row press wired to the BATCH
  // control instead of the row's own -- it would take every comparable row,
  // this one included.
  expect(
    verdictOf({ ...GOOD, row_accept_left_the_other_file: false }, "mirror_row_accept_leaves_the_other_row"),
  ).toBe("FAIL");
});

test("a per-row accept that took BOTH files fails only the second gate, not the first", () => {
  // One gate alone would already PASS here -- the pressed row's words did
  // reach the store. It is the pair that says the press was a row's own
  // accept and not the batch pressed in its place.
  const tookBoth: MirrorMetrics = {
    ...GOOD,
    row_accept_took_its_file: true,
    row_accept_left_the_other_file: false,
  };
  expect(verdictOf(tookBoth, "mirror_row_accept_takes_that_file")).toBe("PASS");
  expect(verdictOf(tookBoth, "mirror_row_accept_leaves_the_other_row")).toBe("FAIL");
  expect(evaluateMirrorGates(tookBoth).some((v) => v.verdict === "FAIL")).toBe(true);
});

test("a per-row accept that took NEITHER file fails only the first gate, not the second", () => {
  const tookNeither: MirrorMetrics = {
    ...GOOD,
    row_accept_took_its_file: false,
    row_accept_left_the_other_file: true,
  };
  expect(verdictOf(tookNeither, "mirror_row_accept_takes_that_file")).toBe("FAIL");
  expect(verdictOf(tookNeither, "mirror_row_accept_leaves_the_other_row")).toBe("PASS");
});

test("a skipped per-row press FAILs both per-row gates and NAMES the offered count", () => {
  // The sabotage this rig actually hit: a walk that found only ONE per-row
  // accept control. Before this review the rig THREW here, and these nine
  // other gates never got a verdict at all.
  expect(verdictOf(SKIPPED, "mirror_row_accept_takes_that_file")).toBe("FAIL");
  expect(verdictOf(SKIPPED, "mirror_row_accept_leaves_the_other_row")).toBe("FAIL");
  expect(valueOf(SKIPPED, "mirror_row_accept_takes_that_file")).toContain("1");
  expect(valueOf(SKIPPED, "mirror_row_accept_leaves_the_other_row")).toContain("1");
});

test("mirror_accept_is_undoable wants TWO \"Before accepting\" snapshots when the per-row press happened", () => {
  expect(verdictOf(GOOD, "mirror_accept_is_undoable")).toBe("PASS");
  // Only the batch's own snapshot landed -- the per-row press's is missing.
  expect(
    verdictOf({ ...GOOD, snapshot_labels: [BEFORE_ACCEPTING_ONE] }, "mirror_accept_is_undoable"),
  ).toBe("FAIL");
  expect(verdictOf({ ...GOOD, snapshot_labels: [] }, "mirror_accept_is_undoable")).toBe("FAIL");
});

test("mirror_accept_is_undoable wants only ONE snapshot when the per-row press was skipped", () => {
  expect(verdictOf(SKIPPED, "mirror_accept_is_undoable")).toBe("PASS");
  expect(verdictOf({ ...SKIPPED, snapshot_labels: [] }, "mirror_accept_is_undoable")).toBe("FAIL");
  // TWO snapshots when only the batch ran is also wrong -- a stray accept
  // nobody pressed would satisfy the old ">= 1" shape of this gate.
  expect(
    verdictOf(
      { ...SKIPPED, snapshot_labels: [BEFORE_ACCEPTING_ONE, BEFORE_ACCEPTING_ONE] },
      "mirror_accept_is_undoable",
    ),
  ).toBe("FAIL");
});

test("mirror_row_accept_settles is UNKNOWN when the press was skipped, and graded when it ran", () => {
  expect(verdictOf(SKIPPED, "mirror_row_accept_settles")).toBe("UNKNOWN");
  expect(verdictOf(GOOD, "mirror_row_accept_settles")).toBe("PASS");
  expect(verdictOf({ ...GOOD, row_accept_file_unchanged: false }, "mirror_row_accept_settles")).toBe(
    "FAIL",
  );
  expect(
    verdictOf({ ...GOOD, row_accept_manifest_matches_the_file: false }, "mirror_row_accept_settles"),
  ).toBe("FAIL");
});
