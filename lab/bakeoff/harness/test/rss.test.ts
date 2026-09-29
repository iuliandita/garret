import { expect, test } from "bun:test";
import { readRssKb, sumTreeRssKb } from "../src/rss";

test("readRssKb returns positive resident memory for this process", () => {
  const kb = readRssKb(process.pid);
  expect(kb).toBeGreaterThan(0);
});

test("readRssKb returns 0 for a nonexistent pid", () => {
  expect(readRssKb(2_147_483_600)).toBe(0);
});

test("sumTreeRssKb over this process tree is at least this process RSS", () => {
  const self = readRssKb(process.pid);
  const tree = sumTreeRssKb(process.pid);
  expect(tree).toBeGreaterThanOrEqual(self);
});
