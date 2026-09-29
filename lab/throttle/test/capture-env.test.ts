// lab/throttle/test/capture-env.test.ts
import { describe, expect, test } from "bun:test";
import { captureEnv } from "../capture-env";

describe("captureEnv", () => {
  test("captures kernel, cpu, memory, and throttle fields", () => {
    const env = captureEnv({ allowedCpus: "0-3", memoryMax: "8G" });
    expect(env.kernel.length).toBeGreaterThan(0);
    expect(env.cpuModel.length).toBeGreaterThan(0);
    expect(env.hostTotalMemBytes).toBeGreaterThan(0);
    expect(env.throttle).toEqual({ allowedCpus: "0-3", memoryMax: "8G" });
    expect(env.biasNotes).toContain("modern single-core");
    expect(env.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
