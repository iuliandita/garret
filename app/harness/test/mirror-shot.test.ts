import { describe, expect, test } from "bun:test";

function diagnostic(result: ReturnType<typeof Bun.spawnSync>): string {
  return (result.stderr?.toString() ?? "")
    .split("\n")
    .filter((line) => line.startsWith("error: "))
    .join("\n");
}

describe("mirror-shot preflight", () => {
  test("can be imported without starting a standalone capture", async () => {
    const module = await import("../src/mirror-shot");
    expect(typeof module.captureMirrorChanges).toBe("function");
  });

  test("refuses a headless caller of the exported workflow before setup", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "-e",
        'const { captureMirrorChanges } = await import("./app/harness/src/mirror-shot.ts"); await captureMirrorChanges({ theme: "dark", out: "unused.png" });',
      ],
      { env: { ...process.env, APP_GUI: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(diagnostic(result)).toContain("APP_GUI=1 is required");
  });

  test.each(["light", "dark"])("accepts %s before refusing a headless launch", (theme) => {
    const result = Bun.spawnSync(["bun", "app/harness/src/mirror-shot.ts", theme], {
      env: { ...process.env, APP_GUI: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(diagnostic(result)).toContain("APP_GUI=1 is required");
  });

  test("refuses an unsupported theme before GUI setup", () => {
    const result = Bun.spawnSync(["bun", "app/harness/src/mirror-shot.ts", "violet"], {
      env: { ...process.env, APP_GUI: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(diagnostic(result)).toContain("[light|dark]");
  });
});
