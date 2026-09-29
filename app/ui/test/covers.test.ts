import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  COVER_SIDES,
  coverAlt,
  coverFindings,
  coverPageLine,
  coverSentence,
  sideName,
  type CoverCheck,
} from "../src/covers";
import { EN } from "../src/i18n";

function check(over: Partial<CoverCheck> = {}): CoverCheck {
  // The fiction preset's page at print resolution: 6 x 9 in at 300 dpi is
  // exactly 1800 x 2700, which is the cover this application asks for. Every
  // fixture below moves ONE thing off it.
  return {
    width_px: 1800,
    height_px: 2700,
    dpi: 300,
    dpi_wanted: 300,
    wanted_width_px: 1800,
    wanted_height_px: 2700,
    low_resolution: false,
    wrong_shape: false,
    fit: "contain",
    ...over,
  };
}

describe("the two sides", () => {
  test("the page restates the host's sides and a test says when they part", async () => {
    // `cast-kinds.ts` and `item-types.ts`'s rule: the page holds its own copy of
    // a small closed set the host owns, and what stops the two drifting is a
    // test that reads the host. A third side added on one side only fails here
    // rather than shipping a panel that cannot paint it.
    const source = await Bun.file(
      join(import.meta.dir, "..", "..", "shell-tauri", "src-tauri", "src", "covers.rs"),
    ).text();
    const declared = [...source.matchAll(/pub const SIDE_[A-Z]+: &str = "([a-z]+)";/g)].map(
      (m) => m[1],
    );
    // Vacuity guard: a pattern that found nothing would pass the comparison
    // against an empty page-side list and prove nothing at all.
    expect(declared.length).toBe(2);
    expect([...COVER_SIDES] as string[]).toEqual(declared as string[]);
  });

  test("a side this build has no word for renders as the id", () => {
    // `designName`'s rule: the sides come from the host, so a host one version
    // ahead is exactly the case, and showing `spine` is a true label where
    // showing nothing is a block with no name at all.
    expect(sideName("front")).toBe("Front");
    expect(sideName("back")).toBe("Back");
    expect(sideName("spine")).toBe("spine");
    expect(coverAlt("spine")).toBe("spine");
  });

  test("each side's picture is named by its side and not by its file", () => {
    // A uuid is not a description of anything, and the filename is the one
    // thing about a cover the writer never chose.
    expect(coverAlt("front")).toBe(EN["covers.alt.front"]);
    expect(coverAlt("back")).toBe(EN["covers.alt.back"]);
    expect(coverAlt("front")).not.toBe(coverAlt("back"));
  });
});

describe("the sentence for a picture state", () => {
  test("the three states this build knows are three different sentences", () => {
    // The cast panel's four-states-four-sentences rule: "there is no cover",
    // "the file is not where this book keeps it" and "it is there and I cannot
    // read it" send a writer to three different places.
    const said = [coverSentence("none"), coverSentence("missing"), coverSentence("unreadable")];
    expect(new Set(said).size).toBe(3);
    expect(said[0]).toBe(EN["covers.none"]);
    expect(said[1]).toBe(EN["covers.missing"]);
  });

  test("a state this build does not know falls through to could not be read", () => {
    // `kindKeyFor`'s rule: a newer host's fifth word must not index into
    // `undefined` and paint a sentence made of a missing-key marker.
    expect(coverSentence("scorched")).toBe(EN["covers.unreadable"]);
  });
});

describe("what the panel says about a cover it can measure", () => {
  test("a cover that suits the page is SAID to suit it", () => {
    // ALWAYS SOMETHING, INCLUDING WHEN NOTHING IS WRONG. A surface that speaks
    // only when it disapproves leaves a writer unable to tell "checked and
    // fine" from "not checked", and the moment they need to tell them apart is
    // the moment before they send the book to a printer.
    const said = coverFindings(check());
    expect(said.length).toBe(1);
    expect(said[0]).toContain("1800");
    expect(said[0]).toContain("300");
    expect(said[0]).toBe(
      EN["covers.check.ok"]
        .replace("{width}", "1800")
        .replace("{height}", "2700")
        .replace("{dpi}", "300"),
    );
  });

  test("a soft cover is told its own figure and what the page wants instead", () => {
    const said = coverFindings(
      check({ width_px: 900, height_px: 1350, dpi: 150, low_resolution: true }),
    );
    expect(said.length).toBe(1);
    // THE FOUR NUMBERS A WRITER CAN ACT ON: what they have, what it works out
    // to, what is wanted, and what to ask their designer for.
    expect(said[0]).toContain("900");
    expect(said[0]).toContain("150");
    expect(said[0]).toContain("300");
    expect(said[0]).toContain("1800");
  });

  test("a wrong-shaped cover is a DIFFERENT sentence, not the same one", () => {
    // TWO FINDINGS AND NOT ONE. A cover can be sharp and the wrong shape, or
    // the right shape and far too soft, and the two have different repairs.
    const soft = coverFindings(check({ dpi: 150, low_resolution: true }));
    const wrong = coverFindings(check({ wrong_shape: true }));
    expect(soft[0]).not.toBe(wrong[0]);
    expect(wrong[0]).toContain("blank bands");
    expect(coverFindings(check({ wrong_shape: true, fit: "fill" }))[0]).toContain("crop image edges");
  });

  test("a cover that is both gets both, in resolution-then-shape order", () => {
    // The fixture that tells a check with two flags from one with a combined
    // one: neither sentence alone satisfies this.
    const said = coverFindings(
      check({ dpi: 120, low_resolution: true, wrong_shape: true }),
    );
    expect(said.length).toBe(2);
    expect(said[0]).toContain("120");
    expect(said[1]).toBe(
      EN["covers.check.shape.contain"],
    );
  });

  test("the ok sentence is not said when something IS wrong", () => {
    // The other direction, which a mutation appending the ok line
    // unconditionally would otherwise survive.
    for (const over of [{ low_resolution: true }, { wrong_shape: true }]) {
      const said = coverFindings(check(over));
      expect(said.some((line) => line === EN["covers.check.ok"])).toBe(false);
      expect(said.length).toBe(1);
    }
  });
});

describe("the line that says what the covers are judged against", () => {
  test("it states the page in millimetres and in inches", () => {
    // `pageReadout`'s rule: it is the only thing on the panel that says where
    // every figure below it came from, and a writer who disagrees with a
    // verdict needs to know which page produced it.
    const line = coverPageLine({ width_um: 152400, height_um: 228600, name: "trade" });
    expect(line).toContain("152.4");
    expect(line).toContain("228.6");
    expect(line).toContain("6");
    expect(line).toContain("9");
  });

  test("a page no preset names still reads its measurements", () => {
    // A design can hold measurements no preset has a word for, and this line
    // is painted unconditionally for exactly that case.
    const line = coverPageLine({ width_um: 160000, height_um: 240000, name: null });
    expect(line).toContain("160");
    expect(line).toContain("240");
  });
});
