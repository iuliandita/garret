// app/ui/test/comments.test.ts
// The anchor rule, tested as a pure function over a fake mapping.
//
// NO EDITOR, NO VIEW, NO LAYOUT. `mapAnchors` takes a mapping-shaped object, so
// each case below is three lines of arithmetic standing in for one transaction -
// which is the whole reason the rule lives in `comments.ts` rather than inside
// `dispatchTransaction`, where nothing could reach it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  COMMENT_CLASS,
  type CommentAnchor,
  MAX_MAPPED_COMMENTS,
  decoratedAnchors,
  flushAnchorsFor,
  isAddCommentChord,
  isOrphaned,
  mapAnchors,
  type PositionMapping,
} from "../src/comments";
import { SHORTCUTS } from "../src/help";

/** A mapping standing for ONE insertion of `length` characters at `at`.
 *
 *  ProseMirror's rule, restated for the test rather than imported: a position
 *  strictly after the insertion point moves by its length, a position before it
 *  does not, and a position exactly AT it is decided by `assoc` - -1 keeps it
 *  before the new text, 1 puts it after. */
function insertion(at: number, length: number): PositionMapping {
  return {
    map(pos: number, assoc = 1): number {
      if (pos > at) return pos + length;
      if (pos < at) return pos;
      return assoc < 0 ? pos : pos + length;
    },
  };
}

/** A mapping standing for ONE deletion of [from, to).
 *
 *  A position inside the deleted range collapses onto `from`, which is what
 *  makes an anchor whose whole passage was deleted come back with `from === to`.
 */
function deletion(from: number, to: number): PositionMapping {
  const length = to - from;
  return {
    map(pos: number): number {
      if (pos <= from) return pos;
      if (pos >= to) return pos - length;
      return from;
    },
  };
}

function anchor(from: number, to: number, resolved = false): CommentAnchor {
  return { id: 1, from, to, resolved };
}

describe("mapping an anchor through one transaction", () => {
  test("an insertion before the passage moves the whole note down", () => {
    const out = mapAnchors([anchor(10, 20)], insertion(4, 3));

    expect(out.mapped).toBe(true);
    expect(out.anchors[0]?.from).toBe(13);
    expect(out.anchors[0]?.to).toBe(23);
  });

  test("an insertion after the passage leaves it alone", () => {
    const out = mapAnchors([anchor(10, 20)], insertion(40, 5));

    expect(out.anchors[0]?.from).toBe(10);
    expect(out.anchors[0]?.to).toBe(20);
  });

  test("an insertion inside the passage grows it", () => {
    const out = mapAnchors([anchor(10, 20)], insertion(15, 4));

    expect(out.anchors[0]?.from).toBe(10);
    expect(out.anchors[0]?.to).toBe(24);
  });

  test("text typed at the very start of the passage lands outside it", () => {
    // `from` maps with assoc 1, so it moves PAST the insertion. What the writer
    // annotated is what was there; a note that swallowed whatever was typed
    // against its edge would quietly change what it is about.
    const out = mapAnchors([anchor(10, 20)], insertion(10, 3));

    expect(out.anchors[0]?.from).toBe(13);
    expect(out.anchors[0]?.to).toBe(23);
    // Same length: the note covers the same words it always did.
    expect((out.anchors[0]?.to ?? 0) - (out.anchors[0]?.from ?? 0)).toBe(10);
  });

  test("text typed at the very end of the passage lands outside it", () => {
    // `to` maps with assoc -1, so it stays before the insertion.
    const out = mapAnchors([anchor(10, 20)], insertion(20, 3));

    expect(out.anchors[0]?.from).toBe(10);
    expect(out.anchors[0]?.to).toBe(20);
  });

  test("a deletion overlapping the start shrinks the passage", () => {
    const out = mapAnchors([anchor(10, 20)], deletion(6, 14));

    // The surviving tail: what was 14..20 is now 6..12.
    expect(out.anchors[0]?.from).toBe(6);
    expect(out.anchors[0]?.to).toBe(12);
    expect(isOrphaned(out.anchors[0] as CommentAnchor)).toBe(false);
  });

  test("a deletion overlapping the end shrinks the passage", () => {
    const out = mapAnchors([anchor(10, 20)], deletion(16, 30));

    expect(out.anchors[0]?.from).toBe(10);
    expect(out.anchors[0]?.to).toBe(16);
    expect(isOrphaned(out.anchors[0] as CommentAnchor)).toBe(false);
  });

  test("a deletion of the whole passage ORPHANS the note", () => {
    // The case the whole design turns on. Both ends collapse onto the deletion
    // point, so from >= to - and nothing anywhere moves the note to a
    // neighbouring word.
    const out = mapAnchors([anchor(10, 20)], deletion(10, 20));

    expect(out.anchors[0]?.from).toBe(10);
    expect(out.anchors[0]?.to).toBe(10);
    expect(isOrphaned(out.anchors[0] as CommentAnchor)).toBe(true);
  });

  test("a deletion swallowing more than the passage orphans it too", () => {
    const out = mapAnchors([anchor(10, 20)], deletion(4, 30));

    expect(isOrphaned(out.anchors[0] as CommentAnchor)).toBe(true);
  });

  test("an orphan stays orphaned however much is typed at it", () => {
    // PERMANENT, and that is the point: a collapsed pair cannot grow, because
    // with these two associations an insertion at a point leaves both ends of it
    // where they were. Re-anchoring an orphan onto the prose that replaced it is
    // the single worst thing this feature could do.
    let anchors: readonly CommentAnchor[] = [anchor(10, 10)];

    anchors = mapAnchors(anchors, insertion(10, 12)).anchors;
    anchors = mapAnchors(anchors, insertion(10, 7)).anchors;

    expect(isOrphaned(anchors[0] as CommentAnchor)).toBe(true);
  });

  test("every anchor in the list is mapped, not only the first", () => {
    const out = mapAnchors(
      [
        { id: 1, from: 10, to: 20, resolved: false },
        { id: 2, from: 30, to: 40, resolved: true },
      ],
      insertion(4, 3),
    );

    expect(out.anchors.map((a) => [a.id, a.from, a.to])).toEqual([
      [1, 13, 23],
      [2, 33, 43],
    ]);
  });

  test("a resolved note is still mapped", () => {
    // Reopening one must not bring it back pointing where it never pointed.
    const out = mapAnchors([anchor(10, 20, true)], insertion(4, 3));

    expect(out.anchors[0]?.from).toBe(13);
    expect(out.anchors[0]?.resolved).toBe(true);
  });

  test("the input is not mutated", () => {
    const input = [anchor(10, 20)];

    mapAnchors(input, insertion(4, 3));

    expect(input[0]?.from).toBe(10);
  });
});

describe("the ceiling", () => {
  function many(n: number): CommentAnchor[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      from: i * 4 + 1,
      to: i * 4 + 3,
      resolved: false,
    }));
  }

  test("at the ceiling the anchors are still mapped", () => {
    // The boundary from the passing side. A threshold test far from its boundary
    // tests the arithmetic, not the comparison - the recorded gate lesson.
    const out = mapAnchors(many(4), insertion(0, 5), 4);

    expect(out.mapped).toBe(true);
    expect(out.anchors[0]?.from).toBe(6);
  });

  test("one past the ceiling nothing is mapped and it says so", () => {
    const input = many(5);

    const out = mapAnchors(input, insertion(0, 5), 4);

    expect(out.mapped).toBe(false);
    // UNCHANGED, not half-mapped: a set where some notes are right and some are
    // wrong with nothing distinguishing them is worse than one that has stopped.
    expect(out.anchors.map((a) => a.from)).toEqual(input.map((a) => a.from));
  });

  test("the default ceiling is the one the panel and the host name", () => {
    const out = mapAnchors(many(MAX_MAPPED_COMMENTS + 1), insertion(0, 5));

    expect(out.mapped).toBe(false);
  });

  test("the page's ceiling and the store's refusal are the same number", () => {
    // RESTATED in two languages that cannot import each other, exactly like the
    // word rule. A shared constant would hide a drift; two statements and this
    // test fail on it.
    const rust = readFileSync(
      new URL("../../shell-tauri/src-tauri/src/store/comments.rs", import.meta.url),
      "utf8",
    );
    // Comments FIRST. The doc comment above the constant names the page's
    // spelling of it, and a search over the raw text finds it in the prose -
    // the recorded theme.test.ts trap, hit three times in one slice already.
    const source = rust.replace(/\/\/.*$/gm, "");
    const found = source.match(/pub const MAX_COMMENTS_PER_DOCUMENT: i64 = (\d+);/);

    expect(found).not.toBeNull();
    expect(Number(found?.[1])).toBe(MAX_MAPPED_COMMENTS);
  });
});

describe("which anchors are drawn", () => {
  test("an open note with a live range is drawn", () => {
    expect(decoratedAnchors([anchor(10, 20)]).map((a) => a.id)).toEqual([1]);
  });

  test("a RESOLVED note is not drawn and is still in the list", () => {
    const rows = [
      { id: 1, from: 10, to: 20, resolved: true },
      { id: 2, from: 30, to: 40, resolved: false },
    ];

    expect(decoratedAnchors(rows).map((a) => a.id)).toEqual([2]);
    // Still listed: "kept, never deleted" is a claim about the list, and the
    // decoration filter is the only thing that hides a settled note.
    expect(rows).toHaveLength(2);
  });

  test("an ORPHAN is not drawn", () => {
    // There is no range to draw. Drawing a collapsed one would put a mark on
    // whatever prose happens to abut the point.
    expect(decoratedAnchors([anchor(10, 10)])).toHaveLength(0);
  });

  test("the class the stylesheet keys on is the one the plugin writes", () => {
    // happy-dom does no layout and loads no stylesheet, so a getComputedStyle
    // assertion here would be vacuous. The stylesheet's own selector is what is
    // checked instead - the recorded rule.
    const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");

    expect(css).toContain(`.${COMMENT_CLASS}`);
  });
});

describe("the add-comment chord", () => {
  function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
    return new KeyboardEvent("keydown", { cancelable: true, ...init });
  }

  test("Ctrl+Alt+M is the chord", () => {
    expect(isAddCommentChord(key({ key: "m", ctrlKey: true, altKey: true }))).toBe(true);
  });

  test("Cmd+Alt+M is the chord too", () => {
    expect(isAddCommentChord(key({ key: "m", metaKey: true, altKey: true }))).toBe(true);
  });

  test("the uppercase form is the same chord", () => {
    // A layout or a held Shift reports "M". Refusing it would mean a writer who
    // has not let go of Shift gets nothing and no explanation.
    expect(isAddCommentChord(key({ key: "M", ctrlKey: true, altKey: true }))).toBe(true);
  });

  test("Ctrl+M alone is not", () => {
    expect(isAddCommentChord(key({ key: "m", ctrlKey: true }))).toBe(false);
  });

  test("Alt+M alone is not", () => {
    expect(isAddCommentChord(key({ key: "m", altKey: true }))).toBe(false);
  });

  test("another letter with the same modifiers is not", () => {
    expect(isAddCommentChord(key({ key: "n", ctrlKey: true, altKey: true }))).toBe(false);
  });

  test("an event whose default is already prevented is refused", () => {
    // A surface that has already claimed this keystroke keeps it - the same rule
    // the navigation-history chord follows.
    const event = key({ key: "m", ctrlKey: true, altKey: true });
    event.preventDefault();

    expect(isAddCommentChord(event)).toBe(false);
  });

  test("the shortcuts panel names the chord this predicate accepts", () => {
    // The panel restates chords it cannot import, and a row that says one thing
    // while the code does another is a lie with no rendering difference and no
    // failing gate - the recorded help.ts exposure. This closes it for the one
    // chord this slice adds.
    const shown = SHORTCUTS.flatMap((group) => group.rows).map((row) => row.keys);

    expect(shown).toContain("Ctrl+Alt+M");
    const parts = "Ctrl+Alt+M".split("+");
    expect(
      isAddCommentChord(
        key({
          key: parts[parts.length - 1] ?? "",
          ctrlKey: parts.includes("Ctrl"),
          altKey: parts.includes("Alt"),
        }),
      ),
    ).toBe(true);
  });
});

describe("what a flush says about a document's notes", () => {
  const anchors = [{ id: 7, from: 10, to: 20, resolved: false }];

  test("the open document's anchors go with its body", () => {
    expect(flushAnchorsFor("scene-0", "scene-0", false, anchors)).toEqual([
      { id: 7, from: 10, to: 20 },
    ]);
  });

  test("another document is left alone", () => {
    // Nothing else can have been edited, so nothing else can have moved - and a
    // flush of scene A writing scene B's positions is the failure that would put
    // a note on prose it was never about.
    expect(flushAnchorsFor("scene-0", "scene-1", false, anchors)).toBeUndefined();
  });

  test("a CAPPED document is left alone", () => {
    // The positions the page holds are the ones it stopped maintaining. The last
    // ones written are the last ones known to be right.
    expect(flushAnchorsFor("scene-0", "scene-0", true, anchors)).toBeUndefined();
  });

  test("no notes is undefined, not an empty list", () => {
    // Different claims: `[]` would be the page saying this document holds no
    // notes, which it is not in a position to say - it knows what it was told,
    // not what the store holds.
    expect(flushAnchorsFor("scene-0", "scene-0", false, [])).toBeUndefined();
  });

  test("nothing open is left alone", () => {
    expect(flushAnchorsFor(undefined, "scene-0", false, anchors)).toBeUndefined();
  });

  test("the resolved flag does not cross the boundary", () => {
    // The host never learns from a flush whether a note is settled: resolving is
    // its own command, and a position write that also carried a state would be
    // two facts in one message with only one of them meant.
    const sent = flushAnchorsFor("scene-0", "scene-0", false, [
      { id: 7, from: 10, to: 20, resolved: true },
    ]);

    expect(Object.keys(sent?.[0] ?? {}).sort()).toEqual(["from", "id", "to"]);
  });
});
