import { describe, expect, test } from "bun:test";
import {
  MARGIN_AXES,
  UM_PER_INCH,
  UM_PER_MM,
  designName,
  editableInches,
  inches,
  marginOf,
  micrometresFromInches,
  micrometresFromMillimetres,
  millimetres,
  pageReadout,
  withMargin,
  type DesignMargins,
} from "../src/book-design";
import { EN, t } from "../src/i18n";

/** Four DIFFERENT values, so a reader that took the wrong one is visible. A
 *  fixture whose margins were all equal would agree with every mapping. */
const MARGINS: DesignMargins = {
  inner_um: 1000,
  outer_um: 2000,
  top_um: 3000,
  bottom_um: 4000,
};

describe("micrometres", () => {
  test("an inch is exactly 25400 of them, which is why they are the unit", () => {
    // The whole argument for the unit: every trim size and margin quoted in
    // inch fractions is an exact integer here, where tenths of a millimetre
    // cannot hold 0.75 in (19.05 mm) at all.
    expect(UM_PER_INCH).toBe(25400);
    expect(UM_PER_MM).toBe(1000);
    expect(UM_PER_INCH % 8).toBe(0);
  });

  test("a millimetre reading carries no trailing zeros", () => {
    expect(millimetres(152_400)).toBe("152.4");
    expect(millimetres(148_000)).toBe("148");
    expect(millimetres(19_050)).toBe("19.05");
    // Micrometres are thousandths of a millimetre, so nothing is rounded away.
    expect(millimetres(1)).toBe("0.001");
  });

  test("an inch reading is two decimals and is not always exact", () => {
    expect(inches(152_400)).toBe("6");
    expect(inches(139_700)).toBe("5.5");
    // A5. The millimetre reading beside it is the exact one, which is why the
    // readout carries both.
    expect(inches(148_000)).toBe("5.83");
  });

  test("an editable inch reading preserves integer micrometres", () => {
    for (const um of [1, 19_050, 25_400, 158_751]) {
      expect(micrometresFromInches(editableInches(um))).toBe(um);
    }
    expect(editableInches(19_050)).toBe("0.75");
  });
});

describe("the page readout", () => {
  test("it names both readings, for a size with a name and for one without", () => {
    const named = pageReadout({ width_um: 152_400, height_um: 228_600, name: "trade" });
    const bare = pageReadout({ width_um: 152_400, height_um: 228_600, name: null });
    // The NAME is not in it: the buttons carry the name, and this line exists
    // so a size no button matches still says what it measures.
    expect(named).toBe(bare);
    expect(named).toContain("152.4");
    expect(named).toContain("228.6");
    expect(named).toContain("6");
    expect(named).toContain("9");
    expect(named).not.toContain("{");
  });
});

describe("reading millimetres a writer typed", () => {
  test("a number of millimetres becomes micrometres", () => {
    expect(micrometresFromMillimetres("19.05")).toBe(19_050);
    expect(micrometresFromMillimetres("15")).toBe(15_000);
    expect(micrometresFromMillimetres("  15  ")).toBe(15_000);
  });

  test("anything that is not a positive number of millimetres is nothing", () => {
    for (const bad of ["", "  ", "0", "-15", "1e3", "15mm", "15,5", ".5", "15.", "NaN", "Infinity"]) {
      expect({ bad, um: micrometresFromMillimetres(bad) }).toEqual({ bad, um: null });
    }
  });

  test("it answers only about the number, never about whether the design fits", () => {
    // A margin wider than any page is a perfectly good measurement, and
    // refusing it here would be a second statement of `design::check` -- the
    // recorded way two statements of one rule end up disagreeing is that nobody
    // notices which one refused.
    expect(micrometresFromMillimetres("100000")).toBe(100_000_000);
  });
});

describe("reading inches a writer typed", () => {
  test("familiar fractions become micrometres", () => {
    expect(micrometresFromInches("0.75")).toBe(19_050);
    expect(micrometresFromInches("1.25")).toBe(31_750);
  });

  test("invalid inches are refused by the same numeric rule", () => {
    for (const bad of ["", "0", "-1", ".5", "1in"]) expect(micrometresFromInches(bad)).toBeNull();
  });
});

describe("the four margin axes", () => {
  test("each axis reads its own field", () => {
    expect(MARGIN_AXES.map((axis) => marginOf(MARGINS, axis))).toEqual([1000, 2000, 3000, 4000]);
  });

  test("the order is inner, outer, top, bottom", () => {
    // Inner and outer rather than left and right: facing pages mirror. A list
    // in any other order would still satisfy the test above.
    expect([...MARGIN_AXES]).toEqual(["inner", "outer", "top", "bottom"]);
  });

  test("changing one axis leaves the other three alone", () => {
    expect(withMargin(MARGINS, "top", 9000)).toEqual({
      inner_um: 1000,
      outer_um: 2000,
      top_um: 9000,
      bottom_um: 4000,
    });
  });
});

describe("naming what the host offers", () => {
  test("the shared margin label remains complete without a unit argument", () => {
    expect(t("design.margin.label", { axis: "Top" })).toBe("Top margin, in millimetres");
  });

  test("a name this catalog has renders as prose", () => {
    expect(designName("page", "trade")).toBe(EN["design.page.trade"] ?? "");
    expect(designName("preset", "fiction")).toBe(EN["design.preset.fiction"] ?? "");
    expect(designName("page", "trade")).not.toBe("trade");
  });

  test("a name this catalog has not renders as the name", () => {
    // A host one version ahead. `royal` is a true label; a button with the
    // missing-key marker on it, or with no name at all, is not.
    expect(designName("page", "royal")).toBe("royal");
    expect(designName("preset", "poetry")).toBe("poetry");
  });

  test("every page size and preset the catalog names is named in both areas' own key space", () => {
    // Vacuity guard on the two tests above: a catalog with no design.page.* key
    // at all would satisfy the second and make the first unreachable.
    const keys = Object.keys(EN).filter((k) => k.startsWith("design.page.") || k.startsWith("design.preset."));
    expect(keys.length).toBeGreaterThan(4);
  });
});
