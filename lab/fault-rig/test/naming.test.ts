// lab/fault-rig/test/naming.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDirBackend } from "../src/backend-dir";
import { makeSqliteBackend } from "../src/backend-sqlite";
import type { EditOp } from "../src/model";

const noop = () => {};

// NFC vs NFD "e-acute", plus case-variant ids, must round-trip as distinct
// scenes through both backends without collision or loss. Built from explicit
// escapes so the distinction survives file encoding/normalization.
const NFC = "scéne";       // e-acute as one codepoint (U+00E9)
const NFD = "scéne"; // e + combining acute (U+0301)
const ops: EditOp[] = [
  { seq: 0, kind: "type", sceneId: NFC, text: "nfc" },
  { seq: 1, kind: "type", sceneId: NFD, text: "nfd" },
  { seq: 2, kind: "type", sceneId: "CASE", text: "upper" },
  { seq: 3, kind: "type", sceneId: "case", text: "lower" },
];

describe("cross-platform naming", () => {
  for (const make of [makeDirBackend, makeSqliteBackend]) {
    test(`distinct unicode/case ids survive reopen`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "name-"));
      const b = make(dir);
      await b.open();
      for (const op of ops) await b.apply(op, noop);
      await b.close();

      const r = make(dir);
      await r.open();
      const state = await r.read();
      await r.close();
      expect(state.scenes[NFC]).toBe("nfc");
      expect(state.scenes[NFD]).toBe("nfd");
      expect(state.scenes["CASE"]).toBe("upper");
      expect(state.scenes["case"]).toBe("lower");
    });
  }
});
