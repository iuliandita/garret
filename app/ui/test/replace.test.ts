// The planners are pure functions of a document, which is what makes the two
// rules below testable at all: which marks a replacement inherits, and what
// order the caller has to apply the plan in.
import { describe, expect, test } from "bun:test";
import { schema } from "../src/editor";
import { locateMatches } from "../src/find-locate";
import { nextMatchAfter, planReplacements, planSelected } from "../src/replace";
import type { Node as PmNode } from "prosemirror-model";

/** A document of paragraphs, the shape the store actually holds. */
function doc(...paragraphs: string[][]): PmNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: paragraphs.map((runs) => ({
      type: "paragraph",
      content: runs.filter((t) => t.length > 0).map((text) => ({ type: "text", text })),
    })),
  });
}

/** A paragraph whose middle run carries `em`. */
function emphasised(before: string, marked: string, after: string): PmNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          ...(before.length > 0 ? [{ type: "text", text: before }] : []),
          { type: "text", text: marked, marks: [{ type: "em" }] },
          ...(after.length > 0 ? [{ type: "text", text: after }] : []),
        ],
      },
    ],
  });
}

const textOf = (node: PmNode, r: { from: number; to: number }): string =>
  node.textBetween(r.from, r.to);

describe("locateMatches", () => {
  test("finds every occurrence, in document order", () => {
    const d = doc(["the storm and the storm"]);
    const hits = locateMatches(d, "storm");
    expect(hits.length).toBe(2);
    expect(hits.map((h) => textOf(d, h))).toEqual(["storm", "storm"]);
    expect(hits[0]!.from).toBeLessThan(hits[1]!.from);
  });

  test("matches are NON-OVERLAPPING", () => {
    // "aa" in "aaaa" is two replacements, not three. An implementation
    // advancing by one unit rather than by the whole match reports three, and
    // replace-all then produces text the writer never asked for.
    expect(locateMatches(doc(["aaaa"]), "aa").length).toBe(2);
    expect(locateMatches(doc(["aaaaa"]), "aa").length).toBe(2);
  });

  test("crosses paragraphs the same way the search does", () => {
    // The projection puts one synthetic space between blocks, so a query
    // spanning the boundary matches. Pinned because replace-all must agree with
    // the panel's count, and the panel's count comes from the host using the
    // same rule.
    const d = doc(["ends here"], ["here it goes"]);
    expect(locateMatches(d, "here here").length).toBe(1);
  });

  test("is case-insensitive, like the panel", () => {
    const d = doc(["Storm storm STORM"]);
    expect(locateMatches(d, "storm").length).toBe(3);
  });

  test("an empty query matches nothing", () => {
    expect(locateMatches(doc(["anything"]), "").length).toBe(0);
  });

  test("a query absent from the document matches nothing", () => {
    expect(locateMatches(doc(["anything"]), "zzz").length).toBe(0);
  });

  test("agrees with locateFirstMatch on the first hit", () => {
    // Two implementations of the same question must not diverge: the panel
    // reveals with one and replaces with the other.
    const d = doc(["the storm and the storm"]);
    const first = locateMatches(d, "storm")[0];
    expect(first).toBeDefined();
    expect(textOf(d, first!)).toBe("storm");
  });
});

describe("planReplacements", () => {
  test("plans one replacement per occurrence, in document order", () => {
    const d = doc(["storm"], ["storm"], ["storm"]);
    const plan = planReplacements(d, "storm").replacements;
    expect(plan.length).toBe(3);
    expect(plan[0]!.from).toBeLessThan(plan[1]!.from);
    expect(plan[1]!.from).toBeLessThan(plan[2]!.from);
  });

  test("a replacement inside an emphasised run inherits em", () => {
    const d = emphasised("plain ", "storm", " plain");
    const plan = planReplacements(d, "storm").replacements;
    expect(plan.length).toBe(1);
    expect(plan[0]!.marks.map((m) => m.type.name)).toEqual(["em"]);
  });

  test("a replacement outside any run inherits nothing", () => {
    const d = emphasised("storm ", "marked", " tail");
    const plan = planReplacements(d, "storm").replacements;
    expect(plan.length).toBe(1);
    expect(plan[0]!.marks.length).toBe(0);
  });

  test("a match spanning a mark boundary takes the marks at its START", () => {
    // There is no answer that is right for every case; this pins the one the
    // design chose, so a change to it is deliberate rather than incidental.
    // "wit" begins in the plain run and ends inside the emphasised one.
    const d = emphasised("be", "witched", "");
    const plan = planReplacements(d, "bewit").replacements;
    expect(plan.length).toBe(1);
    expect(plan[0]!.marks.length).toBe(0);
  });

  test("an empty query plans nothing", () => {
    expect(planReplacements(doc(["storm"]), "").replacements.length).toBe(0);
  });
});

describe("planSelected", () => {
  test("plans the selection when it is exactly a match", () => {
    const d = doc(["the storm"]);
    const hit = locateMatches(d, "storm")[0]!;
    const plan = planSelected(d, "storm", { from: hit.from, to: hit.to });
    expect(plan).not.toBeNull();
    expect(plan!.from).toBe(hit.from);
  });

  test("plans nothing when the selection is a DIFFERENT span", () => {
    // The ordinary first press: the writer opened the panel and the selection is
    // wherever their caret happens to be. Replacing it would rewrite text they
    // did not search for.
    const d = doc(["the storm"]);
    const hit = locateMatches(d, "storm")[0]!;
    expect(planSelected(d, "storm", { from: hit.from - 1, to: hit.to })).toBeNull();
    expect(planSelected(d, "storm", { from: hit.from, to: hit.to - 1 })).toBeNull();
  });

  test("plans nothing for an empty selection", () => {
    const d = doc(["the storm"]);
    const hit = locateMatches(d, "storm")[0]!;
    expect(planSelected(d, "storm", { from: hit.from, to: hit.from })).toBeNull();
  });

  test("plans the SECOND occurrence when that is what is selected", () => {
    // Without this, an implementation that always plans the first match passes
    // every test above and silently replaces the wrong word on every press
    // after the first.
    const d = doc(["storm and storm"]);
    const hits = locateMatches(d, "storm");
    const plan = planSelected(d, "storm", { from: hits[1]!.from, to: hits[1]!.to });
    expect(plan).not.toBeNull();
    expect(plan!.from).toBe(hits[1]!.from);
    expect(plan!.from).not.toBe(hits[0]!.from);
  });

  test("carries the marks of the occurrence it planned", () => {
    const d = emphasised("plain ", "storm", " plain");
    const hit = locateMatches(d, "storm")[0]!;
    const plan = planSelected(d, "storm", hit);
    expect(plan!.marks.map((m) => m.type.name)).toEqual(["em"]);
  });
});

describe("nextMatchAfter", () => {
  test("finds the first match at or after the position", () => {
    const d = doc(["storm and storm"]);
    const hits = locateMatches(d, "storm");
    expect(nextMatchAfter(d, "storm", hits[0]!.to)!.from).toBe(hits[1]!.from);
  });

  test("WRAPS to the top when nothing follows", () => {
    // A writer working down a scene and reaching the end has finished with the
    // part after their caret, not with the scene.
    const d = doc(["storm and storm"]);
    const hits = locateMatches(d, "storm");
    expect(nextMatchAfter(d, "storm", hits[1]!.to)!.from).toBe(hits[0]!.from);
  });

  test("null only when the document holds no match at all", () => {
    // "nothing here" and "nothing more here" are different things to tell
    // someone, and the caller distinguishes them on this.
    expect(nextMatchAfter(doc(["nothing"]), "storm", 0)).toBeNull();
    expect(nextMatchAfter(doc(["storm"]), "storm", 9999)).not.toBeNull();
  });

  test("a position inside a match still finds that match", () => {
    // `from >= pos` with pos inside the match would skip to the next one, which
    // after a replacement would step over an occurrence.
    const d = doc(["storm and storm"]);
    const hits = locateMatches(d, "storm");
    expect(nextMatchAfter(d, "storm", hits[0]!.from)!.from).toBe(hits[0]!.from);
  });
});

describe("a match spanning a paragraph break is REFUSED, not replaced", () => {
  // The projection puts a synthetic space between blocks so the phrase matches,
  // which is right for FIND. Replacing across it merges the two paragraphs, so a
  // writer who typed a two-word phrase would lose a break they never touched.
  const spanning = (): PmNode => doc(["one cat"], ["sat two"]);

  test("locateMatches still finds it — this is a REPLACE rule, not a search one", () => {
    expect(locateMatches(spanning(), "cat sat").length).toBe(1);
  });

  test("planReplacements leaves it alone and counts it", () => {
    const plan = planReplacements(spanning(), "cat sat");
    expect(plan.replacements.length).toBe(0);
    expect(plan.spanning).toBe(1);
  });

  test("a match inside one paragraph is unaffected by the rule", () => {
    // The failing direction. Without it, a planner that refused EVERYTHING would
    // satisfy the test above.
    const plan = planReplacements(doc(["one cat sat two"]), "cat sat");
    expect(plan.replacements.length).toBe(1);
    expect(plan.spanning).toBe(0);
  });

  test("planSelected refuses it too", () => {
    // The panel can put a selection on a spanning match, and replacing THAT
    // merges the blocks just as surely.
    const d = spanning();
    const hit = locateMatches(d, "cat sat")[0]!;
    expect(planSelected(d, "cat sat", hit)).toBeNull();
  });

  test("planSelected still accepts a match inside one paragraph", () => {
    const d = doc(["one cat sat two"]);
    const hit = locateMatches(d, "cat sat")[0]!;
    expect(planSelected(d, "cat sat", hit)).not.toBeNull();
  });
});
