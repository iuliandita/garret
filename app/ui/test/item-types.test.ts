import { describe, expect, test } from "bun:test";
import { TIMELINE_TYPE } from "../src/item-types";

// THE WIRE CONTRACT, restated on both sides rather than shared, exactly as
// the cast kinds are (`cast-panel.test.ts`'s "the kinds" describe block) and
// for the identical reason: there is no build step joining the page and the
// host, so a type string that drifts between `item-types.ts` and
// `store/mod.rs` must break a test rather than pass silently.
describe("TIMELINE_TYPE", () => {
  test("the page's string is the host's string", async () => {
    const rust = await Bun.file(
      "app/shell-tauri/src-tauri/src/store/mod.rs",
    ).text();
    expect(rust).toContain(`pub const TIMELINE_TYPE: &str = "${TIMELINE_TYPE}";`);
    expect(TIMELINE_TYPE).toBe("timeline");
  });
});
