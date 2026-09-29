// lab/fault-rig/test/child.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkload } from "../src/workload";
import { makeDirBackend } from "../src/backend-dir";
import { refStates, hashState, emptyState } from "../src/refmodel";

const CHILD = join(import.meta.dir, "..", "src", "child.ts");
const scenes = ["s1", "s2", "s3"];

describe("child writer", () => {
  test("clean run persists final state and emits ACKs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "child-"));
    const projectDir = join(dir, "proj");
    const ops = buildWorkload("child", scenes, 15);
    const wlPath = join(dir, "wl.json");
    writeFileSync(wlPath, JSON.stringify(ops));

    const proc = Bun.spawn(["bun", CHILD, "dir-manifest", projectDir, wlPath], {
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const acks = out.split("\n").filter((l) => l.startsWith("ACK "));
    expect(acks.length).toBe(15);

    const b = makeDirBackend(projectDir);
    await b.open();
    const state = await b.read();
    await b.close();
    const expected = refStates(emptyState(), ops).at(-1)!;
    expect(hashState(state)).toBe(hashState(expected));
  });
});
