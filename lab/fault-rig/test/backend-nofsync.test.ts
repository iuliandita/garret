// lab/fault-rig/test/backend-nofsync.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNofsyncBackend } from "../src/backend-nofsync";
import { makeBackendFor } from "../src/backend";
import { buildWorkload } from "../src/workload";
import { refStates, hashState, emptyState } from "../src/refmodel";

const noop = () => {};

describe("nofsync control backend", () => {
  // It must be a CORRECT writer — otherwise a power-loss failure would prove
  // nothing about durability, only that the control is broken.
  test("reproduces the refmodel state like any real backend", async () => {
    const ops = buildWorkload("ctl", ["s1", "s2", "s3"], 30);
    const expected = refStates(emptyState(), ops).at(-1)!;
    const dir = mkdtempSync(join(tmpdir(), "nofsync-"));
    const b = makeNofsyncBackend(dir);
    await b.open();
    for (const op of ops) await b.apply(op, noop);
    const got = await b.read();
    await b.close();
    expect(hashState(got)).toBe(hashState(expected));
  });

  // The one thing that makes it a control: it writes in place with no fsync and
  // no atomic rename, so nothing it acks is guaranteed to be on the platter.
  test("leaves no temp file behind, having written in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nofsync2-"));
    const b = makeNofsyncBackend(dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "x" }, noop);
    await b.close();
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(parsed.state.scenes.s1).toBe("x");
  });

  test("is reachable through the shared factory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nofsync3-"));
    const b = makeBackendFor("nofsync-control", dir);
    await b.open();
    await b.apply({ seq: 0, kind: "type", sceneId: "s1", text: "y" }, noop);
    const state = await b.read();
    await b.close();
    expect(state.scenes.s1).toBe("y");
  });
});
