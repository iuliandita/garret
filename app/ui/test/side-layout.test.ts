import { expect, test } from "bun:test";
import { decideSideLayout, type SideLayout } from "../src/side-layout";

// windowWidth is CSS pixels, so a 1400px window at 200% interface zoom is 700.
test.each<[string, number, number, boolean, boolean, SideLayout]>([
  ["nothing open", 1000, 0, true, false, "beside"],
  ["inspector beside navigator at 1400", 1400, 360, true, false, "beside"],
  ["inspector at exactly 1120 still fits", 1120, 360, true, false, "beside"],
  ["inspector at 1100 yields the navigator", 1100, 360, true, false, "yield"],
  ["writer reopened the navigator", 1100, 360, true, true, "beside"],
  ["writer had hidden the navigator", 1100, 360, false, false, "beside"],
  ["inspector at 780 takes the workspace", 780, 360, false, false, "full"],
  ["rail at 900 docks beside the prose", 900, 420, false, false, "beside"],
  ["rail dragged to half of 1400 yields", 1400, 700, true, false, "yield"],
  ["rail at 200% zoom takes the workspace", 700, 420, false, false, "full"],
  ["a kept navigator does not keep a split that cannot fit", 780, 360, true, true, "full"],
])("%s", (_, windowWidth, sideWidth, navColumn, navKept, expected) => {
  expect(decideSideLayout({ windowWidth, sideWidth, navColumn, navKept })).toBe(expected);
});
