// lab/fault-rig/test/fsutil.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, writeAll, hashBytes } from "../src/fsutil";

describe("atomicWrite", () => {
  test("writes final file and leaves no temp behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsutil-"));
    const target = join(dir, "manifest.json");
    await atomicWrite(target, Buffer.from("payload"));
    expect(readFileSync(target, "utf8")).toBe("payload");
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("overwrites an existing file atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsutil2-"));
    const target = join(dir, "f");
    await atomicWrite(target, Buffer.from("one"));
    await atomicWrite(target, Buffer.from("two"));
    expect(readFileSync(target, "utf8")).toBe("two");
  });
});

describe("hashBytes", () => {
  test("stable content hash", () => {
    expect(hashBytes(Buffer.from("abc"))).toBe(hashBytes(Buffer.from("abc")));
    expect(hashBytes(Buffer.from("abc"))).not.toBe(hashBytes(Buffer.from("abd")));
  });
});

describe("writeAll", () => {
  // write(2) on a full filesystem returns a SHORT COUNT instead of throwing.
  // Ignoring it fsyncs and atomically renames a truncated file into place:
  // durable, atomic, and destroyed. Observed as a real dir-manifest failure
  // under the disk-full case.
  test("keeps writing until every byte is delivered", () => {
    const data = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const chunks: { offset: number; length: number }[] = [];
    writeAll(data, (buf, offset, length) => {
      const wrote = Math.min(7, length);      // short write every time
      chunks.push({ offset, length });
      return wrote;
    });
    const delivered = chunks.reduce((n, c) => Math.max(n, c.offset), 0);
    expect(delivered).toBe(21);               // last chunk started at 21
    expect(chunks.length).toBe(4);            // 7 + 7 + 7 + 5
  });

  test("throws rather than looping forever when no progress is made", () => {
    expect(() => writeAll(Buffer.from("abc"), () => 0)).toThrow(/no progress/i);
  });

  test("delivers a single full write unchanged", () => {
    let seen = 0;
    writeAll(Buffer.from("hello"), (_b, _o, length) => { seen += 1; return length; });
    expect(seen).toBe(1);
  });
});
