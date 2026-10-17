import { describe, expect, test } from "bun:test";

import {
  DAILY_TARGETS,
  DEFAULT_DAILY_TARGET,
  dailyTargetFrom,
  isDailyTarget,
  localDate,
  progressDisplay,
  progressSpoken,
  targetWords,
} from "../src/goals";

describe("the daily target", () => {
  test("every offered target's name is the number it stands for", () => {
    // The whole reason no table maps one to the other. If this ever fails, the
    // list has gained a value whose spelling is not its count, and the panel
    // and the bar are about to disagree silently.
    for (const target of DAILY_TARGETS) {
      if (target === "off") continue;
      expect(targetWords(target)).toBe(Number(target));
      expect(Number.isInteger(targetWords(target))).toBe(true);
    }
  });

  test("off is a target of nothing, not a target of zero", () => {
    // null rather than 0: `320 of 0 today` is arithmetic nobody asked for.
    expect(targetWords("off")).toBeNull();
  });

  test("noncanonical or out-of-range values read as off", () => {
    for (const bad of ["", "500 ", " 500", "500\n", "0500", "+500", "0", "-1", "1.5", "1e3", "1000001", "Infinity", "OFF", 500, null, undefined, {}]) {
      expect(isDailyTarget(bad)).toBe(false);
      expect(dailyTargetFrom(bad)).toBe(DEFAULT_DAILY_TARGET);
    }
    // The control: without this, a narrowing that refused EVERYTHING would
    // satisfy the loop above.
    expect(dailyTargetFrom("1000")).toBe("1000");
  });

  test("custom goals accept canonical integer strings including both boundaries", () => {
    for (const target of ["1", "750", "999999", "1000000"] as const) {
      expect(isDailyTarget(target)).toBe(true);
      expect(dailyTargetFrom(target)).toBe(target);
      expect(targetWords(target)).toBe(Number(target));
    }
    expect(progressDisplay(320, "750")).toBe("320 of 750 typed today");
    expect(progressSpoken(320, "750")).toBe("320 words typed today of a 750 word target");
  });
});

describe("what the bar reads", () => {
  test("with no target, the figure stands alone", () => {
    expect(progressDisplay(320, "off")).toBe("320 typed today");
    expect(progressDisplay(1234, "off")).toBe("1,234 typed today");
  });

  test("with a target, both numbers and no punctuation to decode", () => {
    expect(progressDisplay(320, "500")).toBe("320 of 500 typed today");
    expect(progressDisplay(1400, "2000")).toBe("1,400 of 2,000 typed today");
  });

  test("a day spent cutting reads as a loss rather than as zero", () => {
    // U+2212 MINUS SIGN, not a hyphen: this is a negative quantity, and the
    // hyphen-minus renders visibly short beside the digits it belongs to.
    expect(progressDisplay(-900, "off")).toBe("−900 typed today");
    expect(progressDisplay(-900, "500")).toBe("−900 of 500 typed today");
    expect(progressDisplay(-1234, "off")).toBe("−1,234 typed today");
  });

  test("zero is a reading, and it is the one every day starts on", () => {
    expect(progressDisplay(0, "500")).toBe("0 of 500 typed today");
  });
});

describe("what a screen reader hears", () => {
  test("the figures are the same and the sentence is not", () => {
    // The recorded rule: two independent renderings of one pair of numbers.
    // The bar is compact because it sits beside five controls; a screen reader
    // has no bar, no adjacency and no layout, and needs the words.
    expect(progressSpoken(320, "500")).toBe("320 words typed today of a 500 word target");
    expect(progressSpoken(320, "off")).toBe("320 words typed today");
  });

  test("cutting is said, not signed", () => {
    // A minus sign read aloud is "minus" at best and silence at worst.
    expect(progressSpoken(-900, "off")).toBe("900 words cut today");
    expect(progressSpoken(-900, "500")).toBe("900 words cut today of a 500 word target");
    expect(progressSpoken(-900, "off")).not.toContain("−");
  });

  test("one word is not '1 words', in either direction", () => {
    expect(progressSpoken(1, "off")).toBe("1 word typed today");
    expect(progressSpoken(-1, "off")).toBe("1 word cut today");
  });
});

describe("the writer's own date", () => {
  test("months and days are padded", () => {
    expect(localDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("the date is the writer's, not Greenwich's", () => {
    // TWO fixtures, and both are needed. `toISOString().slice(0, 10)` -- the
    // obvious wrong implementation -- is wrong at local midnight in every
    // timezone EAST of UTC and wrong late in the evening in every timezone WEST
    // of it. One fixture would leave half the world's clocks untested and would
    // pass on this machine or the other, depending on where it was run.
    expect(localDate(new Date(2026, 7, 16, 0, 0))).toBe("2026-08-16");
    expect(localDate(new Date(2026, 7, 16, 23, 0))).toBe("2026-08-16");
  });

  test("the shape is the one the host will accept", () => {
    // The host refuses anything that is not ten characters of this shape, and
    // the refusal surfaces as an em dash with no explanation.
    expect(localDate(new Date(2026, 7, 16))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
