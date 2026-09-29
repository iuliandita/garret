// app/harness/test/context-placement.test.ts
// Restates the type-aware placement rule against a fixed tree, in isolation
// from any rig.
import { expect, test } from "bun:test";
import { expectedPlacement, landedAsExpected, type PlacedRow } from "../src/context-placement";

// root > part P1 > chapter C1 > scenes S1, S2, S3
// root > part P2 (bare) > scene S4
// root > scene S5 (no part above it at all)
// Positions are real fractional-index keys (base-62, STRIDE 16): each
// sibling group has its own key space, so S1/S2/S3's keys reuse the same
// digits as P1/P2/S5's without meaning anything about relative order.
const P1: PlacedRow = { id: "P1", parent_id: null, type: "part", position: "000G" };
const P2: PlacedRow = { id: "P2", parent_id: null, type: "part", position: "000W" };
const S5: PlacedRow = { id: "S5", parent_id: null, type: "scene", position: "001C" };
const C1: PlacedRow = { id: "C1", parent_id: "P1", type: "chapter", position: "000G" };
const S1: PlacedRow = { id: "S1", parent_id: "C1", type: "scene", position: "000G" };
const S2: PlacedRow = { id: "S2", parent_id: "C1", type: "scene", position: "000W" };
const S3: PlacedRow = { id: "S3", parent_id: "C1", type: "scene", position: "001C" };
const S4: PlacedRow = { id: "S4", parent_id: "P2", type: "scene", position: "000G" };

const ROWS: PlacedRow[] = [P1, P2, S5, C1, S1, S2, S3, S4];

test("scene from a mid-chapter scene lands after that scene, under the chapter", () => {
  expect(expectedPlacement(ROWS, "S2", "scene")).toEqual({ parentId: "C1", afterId: "S2" });
});

test("scene from the chapter itself appends to the chapter", () => {
  expect(expectedPlacement(ROWS, "C1", "scene")).toEqual({ parentId: "C1", afterId: null });
});

test("chapter from a scene lands after that scene's chapter, under the part", () => {
  expect(expectedPlacement(ROWS, "S2", "chapter")).toEqual({ parentId: "P1", afterId: "C1" });
});

test("chapter from the chapter itself lands after itself, under the part", () => {
  expect(expectedPlacement(ROWS, "C1", "chapter")).toEqual({ parentId: "P1", afterId: "C1" });
});

test("part from a scene lands at the root, after the scene's top-level part", () => {
  expect(expectedPlacement(ROWS, "S2", "part")).toEqual({ parentId: null, afterId: "P1" });
});

test("scene from a scene in a bare part lands after it, under that part", () => {
  expect(expectedPlacement(ROWS, "S4", "scene")).toEqual({ parentId: "P2", afterId: "S4" });
});

test("scene from a bare part itself appends to that part", () => {
  expect(expectedPlacement(ROWS, "P2", "scene")).toEqual({ parentId: "P2", afterId: null });
});

test("an unknown type has no answer", () => {
  expect(expectedPlacement(ROWS, "S2", "trash")).toBeNull();
});

test("an unknown selection id has no answer", () => {
  expect(expectedPlacement(ROWS, "nope", "scene")).toBeNull();
});

test("a scene with no chapter or part above it has no answer", () => {
  expect(expectedPlacement(ROWS, "S5", "scene")).toBeNull();
});

test("a part whose chain stops on a missing parent row has no answer", () => {
  // GHOST's parent_id names a row that is not in `rows`: the chain never
  // reaches an actual root, so there is no top-level ancestor to name.
  const ghost: PlacedRow = { id: "GHOST", parent_id: "nowhere", type: "part", position: "000G" };
  expect(expectedPlacement([ghost], "GHOST", "part")).toBeNull();
});

test("a selection under a reserved root has no answer", () => {
  // FRONT is front matter, a reserved root; a scene living under it is no
  // more an anchor for the manuscript than one inside the bin.
  const front: PlacedRow = { id: "FRONT", parent_id: null, type: "front", position: "000A" };
  const sceneInFront: PlacedRow = { id: "SF", parent_id: "FRONT", type: "scene", position: "000G" };
  const rows = [...ROWS, front, sceneInFront];
  expect(expectedPlacement(rows, "SF", "scene")).toBeNull();
  // The part arm is the one that would otherwise get this wrong: with no
  // guard it would happily name FRONT as the row to file a new part after.
  expect(expectedPlacement(rows, "SF", "part")).toBeNull();
});

const EXPECTED = { parentId: "C1", afterId: "S2" };

test("landedAsExpected PASSes a create that sits right after the expected sibling", () => {
  // NEW's key ("000Z") sorts between S2's ("000W") and S3's ("001C").
  const created: PlacedRow = { id: "NEW", parent_id: "C1", type: "scene", position: "000Z" };
  // Deliberately NOT in key order: the sort inside landedAsExpected is what
  // must find NEW between S2 and S3, not the order this array happens to be
  // built in.
  const rows = [S3, created, P1, P2, S5, C1, S1, S2, S4];
  expect(landedAsExpected(rows, created, EXPECTED)).toBe(true);
});

test("landedAsExpected FAILs a create under the wrong parent", () => {
  const created: PlacedRow = { id: "NEW", parent_id: "P2", type: "scene", position: "000O" };
  const rows = [...ROWS, created];
  expect(landedAsExpected(rows, created, EXPECTED)).toBe(false);
});

test("landedAsExpected FAILs a create under the right parent but the wrong sibling order", () => {
  // NEW's key sorts BEFORE S1's, so it lands first among C1's children --
  // nowhere near "immediately after S2".
  const created: PlacedRow = { id: "NEW", parent_id: "C1", type: "scene", position: "0000" };
  const rows = [S3, S1, created, S2, C1, P2, S5, S4, P1];
  expect(landedAsExpected(rows, created, EXPECTED)).toBe(false);
});

test("landedAsExpected FAILs a create that is in the parent but after the WRONG sibling", () => {
  // Past S3 rather than right after S2: the row is among C1's children and
  // not first, so a check of "has a predecessor" would pass it.
  const created: PlacedRow = { id: "NEW", parent_id: "C1", type: "scene", position: "00zz" };
  const rows = [S3, S1, created, S2, C1, P2, S5, S4, P1];
  expect(landedAsExpected(rows, created, EXPECTED)).toBe(false);
});

test("landedAsExpected treats append (null afterId) as landing LAST among siblings", () => {
  const appendExpected = { parentId: "P2", afterId: null };
  const landedLast: PlacedRow = { id: "NEW", parent_id: "P2", type: "scene", position: "000W" };
  const rows = [...ROWS, landedLast];
  expect(landedAsExpected(rows, landedLast, appendExpected)).toBe(true);

  const landedFirst: PlacedRow = { id: "NEW2", parent_id: "P2", type: "scene", position: "0000" };
  const rows2 = [...ROWS, landedFirst];
  expect(landedAsExpected(rows2, landedFirst, appendExpected)).toBe(false);
});
