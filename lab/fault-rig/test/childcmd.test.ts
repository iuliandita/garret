// lab/fault-rig/test/childcmd.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { childCommand, isRustCandidate, RUST_CHILD } from "../src/childcmd";

describe("childCommand", () => {
  test("runs the TypeScript child for the TypeScript backends", () => {
    const cmd = childCommand("sqlite", "/tmp/p", "/tmp/wl.json");
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toEndWith("child.ts");
    expect(cmd.slice(2)).toEqual(["sqlite", "/tmp/p", "/tmp/wl.json"]);
  });

  // sudo resets PATH, so the durability path passes an absolute interpreter.
  test("honours an explicit runtime path", () => {
    const cmd = childCommand("dir-manifest", "/tmp/p", "/tmp/wl.json", "/usr/bin/bun");
    expect(cmd[0]).toBe("/usr/bin/bun");
  });

  test("identifies the rust candidate", () => {
    expect(isRustCandidate("sqlite-rs")).toBe(true);
    expect(isRustCandidate("sqlite")).toBe(false);
    expect(isRustCandidate("nofsync-control")).toBe(false);
  });

  // Guard against the failure that would invalidate the whole hedge: a results
  // file claiming candidate `sqlite-rs` produced by the TypeScript writer.
  test("never routes the rust candidate through the TypeScript child", () => {
    if (!existsSync(RUST_CHILD)) {
      expect(() => childCommand("sqlite-rs", "/tmp/p", "/tmp/wl.json")).toThrow(
        /rust child binary missing/,
      );
      return;
    }
    const cmd = childCommand("sqlite-rs", "/tmp/p", "/tmp/wl.json");
    expect(cmd).toEqual([RUST_CHILD, "/tmp/p", "/tmp/wl.json"]);
    expect(cmd.join(" ")).not.toContain("child.ts");
  });
});
