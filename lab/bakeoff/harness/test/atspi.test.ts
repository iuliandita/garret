import { expect, test } from "bun:test";
import { parseAtspiDump } from "../src/atspi";

test("parses roles/names from a dump and detects required nodes", () => {
  const dump = [
    "application\tbakeoff editor\t",
    "frame\tbakeoff editor\t",
    "document web\tmanuscript\tediting",
    "list\tscene navigator\t",
    "dialog\tquick open\tmodal",
  ].join("\n");
  const p = parseAtspiDump(dump);
  expect(p.available).toBe(true);
  expect(p.hasEditor).toBe(true); // "document web" role
  expect(p.hasNavigator).toBe(true); // name contains "navigator"
  expect(p.hasDialog).toBe(true); // "dialog" role
  expect(p.roles).toContain("document web");
});

test("missing nodes reflected as false, still available", () => {
  const p = parseAtspiDump("application\tbakeoff editor\t\nframe\tbakeoff\t");
  expect(p.available).toBe(true);
  expect(p.hasEditor).toBe(false);
  expect(p.hasDialog).toBe(false);
});

test("empty dump reports unavailable", () => {
  const p = parseAtspiDump("");
  expect(p.available).toBe(false);
});
