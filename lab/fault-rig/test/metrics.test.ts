// lab/fault-rig/test/metrics.test.ts
import { describe, expect, test } from "bun:test";
import { percentiles, MirrorStub, dirSizeBytes } from "../src/metrics";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("percentiles", () => {
  test("computes p50/p95/p99 from samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const p = percentiles(samples);
    expect(p.p50).toBe(50);
    expect(p.p95).toBe(95);
    expect(p.p99).toBe(99);
  });

  test("empty samples yield zeros", () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });
});

describe("MirrorStub", () => {
  test("debounces bursts and counts amplified bytes", async () => {
    const m = new MirrorStub(10); // 10ms debounce window
    m.note(100);
    m.note(100);        // coalesced into one flush
    await new Promise((r) => setTimeout(r, 25));
    m.note(50);
    await new Promise((r) => setTimeout(r, 25));
    expect(m.flushes).toBe(2);
    expect(m.bytesWritten).toBe(250);
  });
});

describe("dirSizeBytes", () => {
  test("sums file sizes recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "sz-"));
    writeFileSync(join(dir, "a"), "12345");
    writeFileSync(join(dir, "b"), "678");
    expect(dirSizeBytes(dir)).toBe(8);
  });
});
