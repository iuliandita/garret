// app/harness/test/context-gates.test.ts
// The context rig's gates, exercised in BOTH directions.
//
// Five of `evaluateGates`'s older gates were found with untested boundaries and
// `evaluateFindGates` had none at all, so a gate here is written with its
// failing case first. A gate whose FAIL branch no test has ever reached is a
// gate nobody has seen work.
import { expect, test } from "bun:test";
import { expectedPlacement, landedAsExpected, type PlacedRow } from "../src/context-placement";
import { type ContextMetrics, evaluateContextGates } from "../src/gates";

/** A run in which everything went right. Each test spoils exactly one field. */
const GOOD: ContextMetrics = {
  baseline_item_nodes: 0,
  open_item_nodes: 6,
  open_item_names: ["New part", "New chapter", "New scene", "Rename…", "Delete", "Revision state…"],
  unnamed_item_nodes: 0,
  panel_role: "menu",
  item_role: "menu item",
  boot_selection_title: "Winter Nocturne 978",
  clicked_row_title: "River Ombré 479",
  clicked_row_id: "it-000013",
  binned_row_ids: ["it-000013"],
  create_clicked_row_id: "it-000013",
  created_row_id: "it-000100",
  created_row_parent_id: "it-000005",
  created_row_type: "scene",
  expected_parent_id: "it-000005",
  expected_after_id: "it-000013",
  created_row_landed_as_expected: true,
  store_rows_before_create: 40,
  store_rows_after_create: 41,
  label_when_live: "Delete",
  label_when_trashed: "Restore",
  live_row_trashed_in_store: false,
  trashed_row_trashed_in_store: true,
  keyboard_item_nodes: 6,
  items_after_escape: 0,
  editor_windows_before: 1,
  editor_windows_after: 2,
  peak_rss_mb: 420,
};

function verdictOf(m: ContextMetrics, gate: string): string {
  const found = evaluateContextGates(m).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate ${gate}`);
  return found.verdict;
}

test("a good run passes every gate", () => {
  expect(evaluateContextGates(GOOD).every((v) => v.verdict === "PASS")).toBe(true);
});

test("context_opens fails when the right-click exposed nothing new", () => {
  expect(verdictOf({ ...GOOD, open_item_nodes: 0 }, "context_opens")).toBe("FAIL");
  // And when the items were already there before it: a page that painted its
  // menu at boot would otherwise be credited with opening one.
  expect(
    verdictOf({ ...GOOD, baseline_item_nodes: 6, open_item_nodes: 6 }, "context_opens"),
  ).toBe("FAIL");
});

test("context_items_named is UNKNOWN with no items and FAILs on an unnamed one", () => {
  expect(verdictOf({ ...GOOD, open_item_nodes: 0 }, "context_items_named")).toBe("UNKNOWN");
  expect(verdictOf({ ...GOOD, unnamed_item_nodes: 1 }, "context_items_named")).toBe("FAIL");
});

test("context_selects_the_row FAILs when some OTHER row went into the bin", () => {
  // The defect this rig exists for: the menu acting on the selection rather than
  // on the row it was opened on.
  expect(verdictOf({ ...GOOD, binned_row_ids: ["it-000011"] }, "context_selects_the_row")).toBe(
    "FAIL",
  );
  expect(
    verdictOf({ ...GOOD, binned_row_ids: ["it-000011", "it-000013"] }, "context_selects_the_row"),
  ).toBe("FAIL");
  expect(verdictOf({ ...GOOD, binned_row_ids: [] }, "context_selects_the_row")).toBe("FAIL");
});

test("context_selects_the_row is UNKNOWN when the clicked row WAS the boot selection", () => {
  // Not a pass. A click on the row already selected makes the delete succeed
  // whether or not the pointer ever landed, so the run has tested nothing and
  // must not be allowed to say otherwise.
  expect(
    verdictOf(
      { ...GOOD, clicked_row_title: GOOD.boot_selection_title },
      "context_selects_the_row",
    ),
  ).toBe("UNKNOWN");
});

// A minimal store for the create gate: root > part P1 > chapter C1 > scenes
// S1, S2. S2 is the row the rig clicked. Building real PlacedRow-shaped rows
// and deriving the verdict through expectedPlacement/landedAsExpected -- the
// same code the rig runs -- means a test here can only pass by matching what
// the module actually computes, not by asserting a hand-typed boolean.
const P1: PlacedRow = { id: "p-1", parent_id: null, type: "part", position: "000G" };
const C1: PlacedRow = { id: "c-1", parent_id: "p-1", type: "chapter", position: "000G" };
const S1: PlacedRow = { id: "s-1", parent_id: "c-1", type: "scene", position: "000G" };
const S2: PlacedRow = { id: "s-2", parent_id: "c-1", type: "scene", position: "000W" };
const ROWS_BEFORE: PlacedRow[] = [P1, C1, S1, S2];
const CLICKED = S2.id;
const expectedOrNull = expectedPlacement(ROWS_BEFORE, CLICKED, "scene");
if (expectedOrNull === null) throw new Error("fixture setup: 027's rule found no answer for S2");
const EXPECTED: NonNullable<typeof expectedOrNull> = expectedOrNull;

/** GOOD's metrics, with the create fields replaced by what an actual store
 *  walk containing `created` says, per context-placement.ts. */
function metricsFor(created: PlacedRow, rowsAfter: readonly PlacedRow[]): ContextMetrics {
  return {
    ...GOOD,
    create_clicked_row_id: CLICKED,
    created_row_id: created.id,
    created_row_parent_id: created.parent_id,
    created_row_type: created.type,
    expected_parent_id: EXPECTED.parentId,
    expected_after_id: EXPECTED.afterId,
    created_row_landed_as_expected: landedAsExpected(rowsAfter, created, EXPECTED),
  };
}

test("context_creates_where_027_places_it FAILs on a create that landed under the OLD rule (the clicked row itself)", () => {
  // Before 027, a scene from a scene row landed AS ITS CHILD. That is exactly
  // the shape this gate must now reject.
  const created: PlacedRow = { id: "new", parent_id: S2.id, type: "scene", position: "000G" };
  const metrics = metricsFor(created, [...ROWS_BEFORE, created]);
  expect(metrics.created_row_landed_as_expected).toBe(false);
  expect(verdictOf(metrics, "context_creates_where_027_places_it")).toBe("FAIL");
});

test("context_creates_where_027_places_it PASSes a create that landed beside the clicked row, under 027's target parent", () => {
  const created: PlacedRow = { id: "new", parent_id: C1.id, type: "scene", position: "000Z" };
  const metrics = metricsFor(created, [...ROWS_BEFORE, created]);
  expect(metrics.created_row_landed_as_expected).toBe(true);
  expect(verdictOf(metrics, "context_creates_where_027_places_it")).toBe("PASS");
});

test("context_creates_where_027_places_it FAILs when the row count or type is wrong even if the placement matched", () => {
  const created: PlacedRow = { id: "new", parent_id: C1.id, type: "scene", position: "000Z" };
  const passMetrics = metricsFor(created, [...ROWS_BEFORE, created]);
  expect(passMetrics.created_row_landed_as_expected).toBe(true); // sanity: the placement itself is right
  expect(
    verdictOf(
      { ...passMetrics, store_rows_after_create: passMetrics.store_rows_before_create },
      "context_creates_where_027_places_it",
    ),
  ).toBe("FAIL");
  expect(
    verdictOf({ ...passMetrics, created_row_type: "part" }, "context_creates_where_027_places_it"),
  ).toBe("FAIL");
  // A create at the ROOT is the shape a lost parent argument produces, and a
  // missing `parentId` is silently `None` at the command boundary.
  const rootCreated: PlacedRow = { ...created, parent_id: null };
  const rootMetrics = metricsFor(rootCreated, [...ROWS_BEFORE, rootCreated]);
  expect(rootMetrics.created_row_landed_as_expected).toBe(false);
  expect(verdictOf(rootMetrics, "context_creates_where_027_places_it")).toBe("FAIL");
});

test("context_label_tracks_the_row FAILs when the label and the store disagree", () => {
  expect(verdictOf({ ...GOOD, label_when_trashed: "Delete" }, "context_label_tracks_the_row")).toBe(
    "FAIL",
  );
  expect(verdictOf({ ...GOOD, label_when_live: "Restore" }, "context_label_tracks_the_row")).toBe(
    "FAIL",
  );
  // The store's half: a row the label calls binned that the store does not.
  expect(
    verdictOf({ ...GOOD, trashed_row_trashed_in_store: false }, "context_label_tracks_the_row"),
  ).toBe("FAIL");
});

test("context_keyboard_opens FAILs on a truncated menu and on an Escape that left one", () => {
  expect(verdictOf({ ...GOOD, keyboard_item_nodes: 0 }, "context_keyboard_opens")).toBe("FAIL");
  // More than nothing is not the bar: the chord must open THE SAME menu the
  // pointer does.
  expect(verdictOf({ ...GOOD, keyboard_item_nodes: 3 }, "context_keyboard_opens")).toBe("FAIL");
  expect(verdictOf({ ...GOOD, items_after_escape: 6 }, "context_keyboard_opens")).toBe("FAIL");
});

test("context_editor_menu_survives FAILs when no window appeared", () => {
  // The suppression escaping #nav is the failure this catches: a document-level
  // contextmenu handler removes the engine's menu everywhere, and with it the
  // spelling suggestions that are the whole of what this scoping delivers.
  expect(
    verdictOf({ ...GOOD, editor_windows_after: 1 }, "context_editor_menu_survives"),
  ).toBe("FAIL");
  // And is UNKNOWN rather than PASS when the probe could not even see the app's
  // own window, which is a broken probe rather than a broken suppression.
  expect(
    verdictOf({ ...GOOD, editor_windows_before: -1 }, "context_editor_menu_survives"),
  ).toBe("UNKNOWN");
});

test("peak_rss_mb is compared at the boundary, not merely arithmetically", () => {
  expect(verdictOf({ ...GOOD, peak_rss_mb: 749 }, "peak_rss_mb")).toBe("PASS");
  expect(verdictOf({ ...GOOD, peak_rss_mb: 750 }, "peak_rss_mb")).toBe("FAIL");
});
