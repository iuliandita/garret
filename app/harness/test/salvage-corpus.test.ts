// app/harness/test/salvage-corpus.test.ts
// The corpus of genuinely damaged SQLite files, and the one property that makes
// it evidence rather than an anecdote: it is BYTE-EXACT on every run.
//
// Everything here is pure. The fixtures are hand-built page images, not files
// taken from a run: a generator checked against its own output agrees with
// itself about anything, including a defect.
import { describe, expect, test } from "bun:test";
import {
  btreePages,
  corpusPlan,
  changeCounter,
  digest,
  distrustHeaderPageCount,
  headerPageCount,
  overwritePage,
  pageSize,
  setChildPointer,
  setPageSizeField,
  truncateTo,
  versionValidFor,
  zeroPage,
  type CorpusTargets,
} from "../src/salvage-corpus";

/** A hand-built SQLite-shaped image: 512-byte pages, page 1 the file header,
 *  page 2 an interior INDEX page with two cells and a rightmost pointer, pages
 *  3/4/5 its leaves, page 6 a leaf table page nothing points at.
 *
 *  Built here rather than read from a fixture so every offset this module reads
 *  is a number this test chose. */
const PS = 1024;
const PAGES = 6;
const HEADER = 100;
function image(): Uint8Array {
  const b = new Uint8Array(PS * PAGES);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode("SQLite format 3\0"), 0);
  dv.setUint16(16, PS);
  dv.setUint32(28, PAGES); // in-header database size
  dv.setUint32(24, 7); // change counter
  dv.setUint32(92, 7); // version-valid-for: equal, so the size is trusted
  // page 2: interior INDEX, 2 cells, rightmost -> page 5
  const h = PS;
  b[h] = 2;
  dv.setUint16(h + 3, 2);
  dv.setUint32(h + 8, 5);
  dv.setUint16(h + 12, 200); // cell 0 at offset 200 within the page
  dv.setUint16(h + 14, 240); // cell 1 at offset 240
  dv.setUint32(h + 200, 3);
  dv.setUint32(h + 240, 4);
  for (const p of [3, 4, 5]) b[(p - 1) * PS] = 10; // leaf index pages
  b[(6 - 1) * PS] = 13; // an unreferenced leaf table page
  // PAGE 1 IS A B-TREE ROOT TOO -- it is `sqlite_schema`'s -- and its page
  // header starts AFTER the hundred-byte file header. A walk that forgot that
  // reads the magic as a page type. Interior TABLE here, and not a second
  // interior index, because the two type bytes are different numbers and a
  // fixture holding only one cannot tell a walk that knows both from one that
  // knows one.
  b[HEADER] = 5;
  dv.setUint16(HEADER + 3, 1);
  dv.setUint32(HEADER + 8, 6); // rightmost -> the otherwise unreferenced page 6
  dv.setUint16(HEADER + 12, 300);
  dv.setUint32(300, 2); // cell 0 -> page 2, the interior index above
  // Something to notice in every page, so a zeroed page is distinguishable.
  for (let i = 0; i < b.length; i++) if (b[i] === 0 && i % 97 === 0) b[i] = 0x5a;
  return b;
}

const TARGETS: CorpusTargets = { enumerationIndexRoot: 2, documentTableRoot: 2 };

describe("the header readers", () => {
  test("page size 1 in the header means 65536", () => {
    const b = image();
    new DataView(b.buffer).setUint16(16, 1);
    expect(pageSize(b)).toBe(65536);
  });
  test("page size is read from bytes 16..18", () => {
    expect(pageSize(image())).toBe(PS);
  });
  test("the header's page count is bytes 28..32 and not the file's length", () => {
    const b = image();
    new DataView(b.buffer).setUint32(28, 999);
    expect(headerPageCount(b)).toBe(999);
    expect(b.length / PS).toBe(PAGES);
  });
  test("the change counter and the version-valid-for number are read separately", () => {
    const b = image();
    new DataView(b.buffer).setUint32(92, 4242);
    expect(changeCounter(b)).toBe(7);
    expect(versionValidFor(b)).toBe(4242);
  });
  test("bytes that are not a SQLite file are refused rather than guessed at", () => {
    expect(() => pageSize(new Uint8Array(200))).toThrow(/not a SQLite/);
  });
  test("a file shorter than the header is refused", () => {
    expect(() => pageSize(image().slice(0, 60))).toThrow(/not a SQLite/);
  });
});

describe("btreePages", () => {
  test("returns the root first and its leaves in scan order", () => {
    expect(btreePages(image(), 2)).toEqual([2, 3, 4, 5]);
  });
  test("a leaf root is the whole tree", () => {
    expect(btreePages(image(), 6)).toEqual([6]);
  });
  test("does not wander into pages nothing points at", () => {
    expect(btreePages(image(), 2)).not.toContain(6);
  });
  test("walks an interior TABLE page as well as an interior index one", () => {
    // From page 1, which is an interior TABLE page: a walk that only recognised
    // the index type would stop at page 1 and call it the whole tree.
    expect(btreePages(image(), 1)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  test("reads page 1's b-tree header AFTER the hundred-byte file header", () => {
    // The magic at offset 0 begins with 'S' (0x53), which is not a page type,
    // so a walk reading the type at offset 0 finds a leaf and stops.
    expect(btreePages(image(), 1).length).toBeGreaterThan(1);
  });
  test("refuses a cycle rather than looping forever", () => {
    const b = image();
    setChildPointerInPlace(b, 2, 0, 2);
    expect(btreePages(b, 2)).toEqual([2, 4, 5]);
  });
});

function setChildPointerInPlace(b: Uint8Array, page: number, cell: number, child: number): void {
  const out = setChildPointer(b, page, cell, child);
  b.set(out);
}

describe("the transforms are pure", () => {
  test("zeroPage does not touch the input", () => {
    const b = image();
    const before = digest(b);
    zeroPage(b, 3);
    expect(digest(b)).toBe(before);
  });
  test("zeroPage zeroes exactly one page and nothing either side", () => {
    const b = image();
    const out = zeroPage(b, 3);
    expect(out.slice(2 * PS, 3 * PS).every((x) => x === 0)).toBe(true);
    expect(out.slice(0, 2 * PS)).toEqual(b.slice(0, 2 * PS));
    expect(out.slice(3 * PS)).toEqual(b.slice(3 * PS));
  });
  test("overwritePage fills exactly one page with the byte given", () => {
    const out = overwritePage(image(), 4, 0xa5);
    expect(out.slice(3 * PS, 4 * PS).every((x) => x === 0xa5)).toBe(true);
    expect(out[3 * PS - 1]).not.toBe(0xa5);
  });
  test("truncateTo keeps a prefix and nothing more", () => {
    const b = image();
    const out = truncateTo(b, 3 * PS + 17);
    expect(out.length).toBe(3 * PS + 17);
    expect(out).toEqual(b.slice(0, 3 * PS + 17));
  });
  test("setPageSizeField changes two bytes and only those two", () => {
    const b = image();
    const out = setPageSizeField(b, 2048);
    expect(pageSize(out)).toBe(2048);
    let differing = 0;
    for (let i = 0; i < b.length; i++) if (b[i] !== out[i]) differing++;
    expect(differing).toBeLessThanOrEqual(2);
    expect(differing).toBeGreaterThan(0);
  });
  test("setChildPointer rewrites the cell's four-byte left child and nothing else", () => {
    const b = image();
    const out = setChildPointer(b, 2, 1, 999999);
    expect(new DataView(out.buffer).getUint32(PS + 240)).toBe(999999);
    let differing = 0;
    for (let i = 0; i < b.length; i++) if (b[i] !== out[i]) differing++;
    expect(differing).toBeLessThanOrEqual(4);
    expect(differing).toBeGreaterThan(0);
  });
  test("a page number outside the file is refused rather than silently ignored", () => {
    expect(() => zeroPage(image(), PAGES + 1)).toThrow(/page/);
    expect(() => zeroPage(image(), 0)).toThrow(/page/);
  });
});

describe("distrustHeaderPageCount", () => {
  test("is the repair the corpus expects salvage to make, restated", () => {
    const short = truncateTo(image(), 4 * PS);
    const fixed = distrustHeaderPageCount(short);
    expect(fixed).not.toBeNull();
    expect(versionValidFor(fixed!)).not.toBe(changeCounter(fixed!));
    expect(headerPageCount(fixed!)).toBe(PAGES);
  });
  test("declines a file whose header does not overclaim", () => {
    expect(distrustHeaderPageCount(image())).toBeNull();
  });
  test("declines a file whose header is already distrusted", () => {
    const short = truncateTo(image(), 4 * PS);
    new DataView(short.buffer).setUint32(92, 1);
    expect(distrustHeaderPageCount(short)).toBeNull();
  });
});

describe("corpusPlan", () => {
  const plan = corpusPlan(image(), TARGETS);

  test("every entry names an injury, what it represents and the exits it allows", () => {
    expect(plan.length).toBeGreaterThanOrEqual(7);
    for (const e of plan) {
      expect(e.name.length).toBeGreaterThan(3);
      expect(e.injury.length).toBeGreaterThan(20);
      expect(e.represents.length).toBeGreaterThan(20);
      expect(e.allowedExits.length).toBeGreaterThan(0);
      for (const code of e.allowedExits) expect([0, 2, 3]).toContain(code);
    }
  });

  test("no two entries share a name", () => {
    expect(new Set(plan.map((e) => e.name)).size).toBe(plan.length);
  });

  test("no two entries produce the same bytes", () => {
    const digests = plan.map((e) => digest(e.db));
    expect(new Set(digests).size).toBe(digests.length);
  });

  test("every entry differs from the healthy file it was made from", () => {
    const healthy = digest(image());
    for (const e of plan) {
      if (e.wal !== null) continue;
      expect(digest(e.db)).not.toBe(healthy);
    }
  });

  test("the one entry whose database is untouched carries a sidecar instead", () => {
    const withWal = plan.filter((e) => e.wal !== null);
    expect(withWal).toHaveLength(1);
    expect(digest(withWal[0]!.db)).toBe(digest(image()));
    expect(withWal[0]!.wal!.length).toBeGreaterThan(0);
  });

  test("is byte-identical across two independent generations", () => {
    const again = corpusPlan(image(), TARGETS);
    expect(again.map((e) => `${e.name}:${digest(e.db)}`)).toEqual(
      plan.map((e) => `${e.name}:${digest(e.db)}`),
    );
    expect(again.map((e) => (e.wal === null ? "-" : digest(e.wal)))).toEqual(
      plan.map((e) => (e.wal === null ? "-" : digest(e.wal))),
    );
  });

  test("is a function of the base: one byte moved in the base moves the corpus", () => {
    const other = image();
    other[3 * PS + 40] = (other[3 * PS + 40]! ^ 0xff) & 0xff;
    const moved = corpusPlan(other, TARGETS).map((e) => digest(e.db));
    const same = plan.map((e) => digest(e.db));
    expect(moved.filter((d, at) => d !== same[at]).length).toBeGreaterThan(0);
  });

  test("the truncation entries are the prefixes this test computes itself", () => {
    const base = image();
    const boundary = plan.find((e) => e.name === "tail_lost_at_page_boundary")!;
    const midPage = plan.find((e) => e.name === "tail_lost_mid_page")!;
    const header = plan.find((e) => e.name === "header_torn")!;
    const keep = Math.max(1, Math.floor(PAGES * 0.9));
    expect(boundary.db).toEqual(base.slice(0, keep * PS));
    expect(midPage.db).toEqual(base.slice(0, keep * PS + Math.floor(PS / 3)));
    expect(header.db).toEqual(base.slice(0, 60));
  });

  test("the torn page is a page of the enumeration index and not any page at all", () => {
    const torn = plan.find((e) => e.name === "torn_page_zeroed")!;
    const tree = btreePages(image(), TARGETS.enumerationIndexRoot);
    const zeroed: number[] = [];
    for (let p = 1; p <= PAGES; p++) {
      if (torn.db.slice((p - 1) * PS, p * PS).every((x) => x === 0)) zeroed.push(p);
    }
    expect(zeroed).toHaveLength(1);
    expect(tree).toContain(zeroed[0]!);
  });

  test("a base whose pages are already the size the lying header claims is refused", () => {
    const b = image();
    new DataView(b.buffer).setUint16(16, 512);
    expect(() => corpusPlan(b, TARGETS)).toThrow(/pages are already/);
  });

  test("the overwritten page is the LAST page of the doc tree and never its root", () => {
    // The root of a table's b-tree is the tree: overwriting it destroys every
    // page below it at once and grades "the file is gone", not "one page of the
    // prose is gone", which is the injury this entry is named for.
    const over = plan.find((e) => e.name === "torn_page_overwritten")!;
    const tree = btreePages(image(), TARGETS.documentTableRoot);
    const filled: number[] = [];
    for (let p = 1; p <= PAGES; p++) {
      if (over.db.slice((p - 1) * PS, p * PS).every((x) => x === 0xa5)) filled.push(p);
    }
    expect(filled).toEqual([tree[tree.length - 1]!]);
    expect(filled[0]).not.toBe(tree[0]);
  });

  test("the torn page is a LEAF when the tree has one, so enumeration reaches rows first", () => {
    const torn = plan.find((e) => e.name === "torn_page_zeroed")!;
    const tree = btreePages(image(), TARGETS.enumerationIndexRoot);
    let zeroed = 0;
    for (let p = 1; p <= PAGES; p++) {
      if (torn.db.slice((p - 1) * PS, p * PS).every((x) => x === 0)) zeroed = p;
    }
    expect(zeroed).not.toBe(tree[0]);
  });
});
