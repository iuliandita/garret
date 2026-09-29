import { expect, test } from "bun:test";
import { groupsOf, selectSummary } from "../src/library-summary";
import type { LibraryBook } from "../src/library";

function book(path: string, extras: Partial<LibraryBook> = {}): LibraryBook {
  return {
    path, name: path, modified_at: 0, opened_at: null, identity_id: null, identity_name: null,
    book_id: path, series: null, universe: null, membership_error: null,
    cover: { state: "none", data_uri: null }, error: null, missing: false, ...extras,
  };
}

const all = { identity: null, series: null, universe: null };

test("same-name IDs stay distinct and conflicting snapshots of one ID stay visible", () => {
  const books = [
    book("a", { series: { id: "1", name: "Harbour" } }),
    book("b", { series: { id: "2", name: "Harbour" } }),
    book("c", { series: { id: "1", name: "Port" } }),
  ];
  expect(groupsOf(books, "series")).toEqual([
    { id: "1", labels: ["Harbour", "Port"], sameNameId: true },
    { id: "2", labels: ["Harbour"], sameNameId: true },
  ]);
});

test("series, universe and pen scope combine by AND while missing scope remains unknown", () => {
  const books = [
    book("a", { identity_id: "pen", series: { id: "s", name: "S" }, universe: { id: "u", name: "U" } }),
    book("b", { identity_id: "pen", series: { id: "s", name: "S" } }),
    book("c", { missing: true }),
  ];
  const selected = selectSummary(books, { identity: "pen", series: "s", universe: "u" }, new Map());
  expect(selected.candidates.map((item) => item.path)).toEqual(["a"]);
  expect(selected.outsideScope).toBe(1);
  expect(selected.missingUnknown).toBe(1);
});

test("copies are all excluded until the writer chooses one, even when memberships differ", () => {
  const books = [
    book("original", { book_id: "same", series: { id: "s1", name: "One" } }),
    book("copy", { book_id: "same", series: { id: "s2", name: "Two" } }),
  ];
  const unresolved = selectSummary(books, all, new Map());
  expect(unresolved.candidates).toEqual([]);
  expect(unresolved.duplicateUnresolved[0].map((item) => item.path)).toEqual(["original", "copy"]);
  const selected = selectSummary(books, { ...all, series: "s2" }, new Map([["same", "copy"]]));
  expect(selected.candidates.map((item) => item.path)).toEqual(["copy"]);
});

test("a damaged membership does not turn into an ungrouped book", () => {
  const selected = selectSummary([book("bad", { membership_error: "version unsupported" })], all, new Map());
  expect(selected.candidates).toEqual([]);
  expect(selected.membershipUnknown).toBe(1);
});
