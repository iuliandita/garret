// lab/fault-rig/test/blockdev.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flakeyTable, sectorsFor, assertSafeImagePath } from "../src/blockdev";

describe("flakeyTable", () => {
  test("passes writes through in up mode", () => {
    expect(flakeyTable("/dev/loop7", 2048, "up"))
      .toBe("0 2048 flakey /dev/loop7 0 1 0");
  });

  // The whole power-loss simulation rides on this table: an always-down device
  // with drop_writes silently discards writes while reads still succeed, so
  // anything that was never fsynced is gone.
  test("drops writes permanently in drop mode", () => {
    expect(flakeyTable("/dev/loop7", 2048, "drop"))
      .toBe("0 2048 flakey /dev/loop7 0 0 60 1 drop_writes");
  });
});

describe("sectorsFor", () => {
  test("converts bytes to 512-byte sectors", () => {
    expect(sectorsFor(1024 * 1024)).toBe(2048);
  });

  test("truncates a partial trailing sector rather than overrunning", () => {
    expect(sectorsFor(1025)).toBe(2);
  });
});

describe("assertSafeImagePath", () => {
  // Guard rail: this module runs as root and hands paths to mkfs. It must only
  // ever accept a regular file we created, never a real block device.
  test("rejects anything under /dev", () => {
    expect(() => assertSafeImagePath("/dev/sda")).toThrow();
    expect(() => assertSafeImagePath("/dev/loop0")).toThrow();
  });

  test("rejects a relative path", () => {
    expect(() => assertSafeImagePath("image.img")).toThrow();
  });

  test("accepts an absolute path to a plain image file", () => {
    const img = join(mkdtempSync(join(tmpdir(), "imgchk-")), "disk.img");
    writeFileSync(img, "x");
    expect(() => assertSafeImagePath(img)).not.toThrow();
  });

  test("rejects a directory", () => {
    expect(() => assertSafeImagePath(mkdtempSync(join(tmpdir(), "imgdir-")))).toThrow();
  });
});
