import { describe, expect, test } from "bun:test";
import { parseMirrorChangesRoute } from "../src/mirror-shot-route";

describe("parseMirrorChangesRoute", () => {
  test("leaves ordinary shot-cli arguments for its existing parser", () => {
    expect(parseMirrorChangesRoute(["normal", "--locale", "de"])).toBeNull();
  });

  test("uses the dark tiny default", () => {
    expect(parseMirrorChangesRoute(["tiny", "--mirror-changes"])).toEqual({
      theme: "dark",
      out: "app/results/screenshots/change-set-dark-tiny.png",
    });
  });

  test("accepts light and an explicit output path", () => {
    expect(
      parseMirrorChangesRoute(["tiny", "--out", "tmp/change.png", "--mirror-changes", "--theme", "light"]),
    ).toEqual({ theme: "light", out: "tmp/change.png" });
  });

  test.each(
    [
      ["normal", "--mirror-changes"],
      ["tiny", "--mirror-changes", "--mirror-changes"],
      ["tiny", "--mirror-changes", "--theme", "light", "--theme", "dark"],
      ["tiny", "--mirror-changes", "--out", "one.png", "--out", "two.png"],
      ["tiny", "--mirror-changes", "--theme"],
      ["tiny", "--mirror-changes", "--theme", "system"],
      ["tiny", "--mirror-changes", "--out"],
      ["tiny", "--mirror-changes", "--out", ""],
      ["tiny", "--mirror-changes", "--locale", "de"],
      ["tiny", "--mirror-changes", "extra"],
    ].map((argv) => [argv]),
  )("refuses an unsupported mirror route: %p", (argv) => {
    expect(() => parseMirrorChangesRoute(argv)).toThrow();
  });
});
