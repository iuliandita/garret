// lab/fault-rig/test/backend-conformance.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDirBackend } from "../src/backend-dir";
import { makeSqliteBackend } from "../src/backend-sqlite";
import { buildWorkload } from "../src/workload";
import { refStates, hashState, emptyState } from "../src/refmodel";

const noop = () => {};
const scenes = ["s1", "s2", "s3"];

describe("backend conformance", () => {
  test("both backends reproduce the final refmodel state", async () => {
    const ops = buildWorkload("conf", scenes, 50);
    const expected = refStates(emptyState(), ops).at(-1)!;

    for (const make of [makeDirBackend, makeSqliteBackend]) {
      const dir = mkdtempSync(join(tmpdir(), "conf-"));
      const b = make(dir);
      await b.open();
      for (const op of ops) await b.apply(op, noop);
      const got = await b.read();
      await b.close();
      expect(hashState(got)).toBe(hashState(expected));
    }
  });
});
