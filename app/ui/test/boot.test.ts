import { describe, expect, test } from "bun:test";
import { buildReadyPayload } from "../src/boot";

describe("buildReadyPayload", () => {
  test("reports readiness with the candidate and seed the host injected", () => {
    const payload = buildReadyPayload({ candidate: "tauri", seed: "app-v1" });
    expect(payload.ready).toBe(true);
    expect(payload.candidate).toBe("tauri");
    expect(payload.seed).toBe("app-v1");
  });

  test("missing host injection is reported, not silently defaulted", () => {
    const payload = buildReadyPayload({});
    expect(payload.ready).toBe(true);
    expect(payload.candidate).toBe("unknown");
    expect(payload.seed).toBe("unknown");
  });
});
