// lab/fixtures/gen/test/assets.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePrng } from "../src/prng";
import { writeAssets } from "../src/assets";

describe("writeAssets", () => {
  test("writes count files totaling requested bytes, deterministic", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "assets-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "assets-b-"));
    await writeAssets(makePrng("as1"), dirA, 4, 1024 * 64);
    await writeAssets(makePrng("as1"), dirB, 4, 1024 * 64);
    const filesA = readdirSync(dirA).sort();
    expect(filesA.length).toBe(4);
    let total = 0;
    for (const f of filesA) {
      const bytesA = readFileSync(join(dirA, f));
      const bytesB = readFileSync(join(dirB, f));
      expect(Buffer.compare(bytesA, bytesB)).toBe(0);
      total += bytesA.length;
    }
    expect(total).toBe(1024 * 64);
  });

  // Sparse assets exist so the spec's 20 GB stress noise fits on a nearly full
  // disk. The apparent size must be exact (it is the only property anything
  // observes) while the blocks actually allocated stay near zero.
  test("sparse assets have the full apparent size but allocate no blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assets-sparse-"));
    const size = 64 * 1024 * 1024; // 64 MiB apparent across 2 files
    const names = await writeAssets(makePrng("sp"), dir, 2, size, true);
    expect(names.length).toBe(2);
    let apparent = 0;
    let allocated = 0;
    for (const f of names) {
      const st = statSync(join(dir, f));
      apparent += st.size;
      allocated += st.blocks * 512;
    }
    expect(apparent).toBe(size);
    expect(allocated).toBeLessThan(1024 * 1024); // < 1 MiB of real blocks
  });

  test("multi-chunk asset with non-multiple-of-4 tail is exact and deterministic", async () => {
    const size = (1 << 16) + 3; // 64 KiB + 3: spans >1 chunk, exercises tail fill
    const dirA = mkdtempSync(join(tmpdir(), "assets-tail-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "assets-tail-b-"));
    await writeAssets(makePrng("tail"), dirA, 1, size);
    await writeAssets(makePrng("tail"), dirB, 1, size);
    const bytesA = readFileSync(join(dirA, "a0000.bin"));
    const bytesB = readFileSync(join(dirB, "a0000.bin"));
    expect(bytesA.length).toBe(size);
    expect(Buffer.compare(bytesA, bytesB)).toBe(0);
  });
});
