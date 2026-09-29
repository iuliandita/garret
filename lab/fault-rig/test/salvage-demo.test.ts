// lab/fault-rig/test/salvage-demo.test.ts
import { describe, expect, test } from "bun:test";
import { runSalvageDemo, DEMO_OFFSETS } from "../src/salvage-demo";
import type { BackendId } from "../src/model";

const SCENES = ["s1", "s2", "s3"];

describe("runSalvageDemo", () => {
  for (const backendId of ["dir-manifest", "sqlite"] as BackendId[]) {
    test(`sweeps damage sites across the artifact for ${backendId}`, async () => {
      const evidence = await runSalvageDemo({
        backendId, seed: "demo-test", scenes: SCENES, opCount: 10,
      });

      expect(evidence.length).toBe(DEMO_OFFSETS.length);
      for (const ev of evidence) {
        expect(ev.candidate).toBe(backendId);
        expect(ev.case).toStartWith("demo@flip-");
        // The whole point of the salvage path: it never writes to the source.
        expect(ev.source_unmodified).toBe(true);
        expect(ev.sidecars).toBeArray();
      }
    }, 20_000);
  }

  test("is reproducible for a given seed", async () => {
    const spec = {
      backendId: "dir-manifest" as BackendId,
      seed: "stable", scenes: SCENES, opCount: 10,
    };
    const a = await runSalvageDemo(spec);
    const b = await runSalvageDemo(spec);
    expect(a.map((e) => e.recovered_scenes)).toEqual(b.map((e) => e.recovered_scenes));
  }, 20_000);
});
