import { describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_RUN_PRESSES, parseFirstRun } from "../src/first-run";

describe("parseFirstRun", () => {
  test("undefined is the default two presses", () => {
    expect(parseFirstRun(undefined)).toEqual([...DEFAULT_FIRST_RUN_PRESSES]);
    expect([...DEFAULT_FIRST_RUN_PRESSES]).toEqual(["menu-new-chapter", "menu-new-scene"]);
  });

  test("undefined returns a COPY, not the default's own array", () => {
    const first = parseFirstRun(undefined);
    const second = parseFirstRun(undefined);
    expect(first).not.toBe(second);
    first.push("menu-new-part");
    expect([...DEFAULT_FIRST_RUN_PRESSES]).toEqual(["menu-new-chapter", "menu-new-scene"]);
  });

  test('"none" is no presses', () => {
    expect(parseFirstRun("none")).toEqual([]);
  });

  test("a comma list is the ids in order", () => {
    expect(parseFirstRun("menu-new-part,menu-new-chapter")).toEqual([
      "menu-new-part",
      "menu-new-chapter",
    ]);
  });

  test("a single id is a one-element list", () => {
    expect(parseFirstRun("menu-new-scene")).toEqual(["menu-new-scene"]);
  });

  test("empty segments are dropped", () => {
    expect(parseFirstRun("menu-new-chapter,,menu-new-scene,")).toEqual([
      "menu-new-chapter",
      "menu-new-scene",
    ]);
  });

  test("segments are trimmed", () => {
    expect(parseFirstRun("menu-new-chapter, menu-new-scene ,  menu-new-part")).toEqual([
      "menu-new-chapter",
      "menu-new-scene",
      "menu-new-part",
    ]);
  });

  test('"" throws naming "none"', () => {
    expect(() => parseFirstRun("")).toThrow(/none/);
  });
});
