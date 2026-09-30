import { describe, expect, test } from "bun:test";
import { CLASSIC_FIXTURES, isClassicFixture, resolveFixtureDir } from "../src/fixture-name";

function diagnostic(result: ReturnType<typeof Bun.spawnSync>): string {
  return (result.stderr?.toString() ?? "")
    .split("\n")
    .filter((line) => line.startsWith("error: "))
    .join("\n");
}

describe("resolveFixtureDir", () => {
  test("sample resolves under app/fixtures, not lab/fixtures/out", () => {
    expect(resolveFixtureDir("sample")).toBe("app/fixtures/sample");
  });

  test("classic excerpts resolve to their own populated fixtures", () => {
    for (const name of CLASSIC_FIXTURES) {
      expect(resolveFixtureDir(name)).toBe(`app/fixtures/classics/${name}`);
      expect(isClassicFixture(name)).toBe(true);
    }
    expect(isClassicFixture("sample")).toBe(false);
    expect(isClassicFixture("../alice")).toBe(false);
  });

  test("graded fixtures resolve under lab/fixtures/out", () => {
    expect(resolveFixtureDir("tiny")).toBe("lab/fixtures/out/tiny");
    expect(resolveFixtureDir("normal")).toBe("lab/fixtures/out/normal");
    expect(resolveFixtureDir("stress")).toBe("lab/fixtures/out/stress");
  });

  test("an unknown name still resolves under lab/fixtures/out, for shot-cli's own existsSync to refuse", () => {
    expect(resolveFixtureDir("nope")).toBe("lab/fixtures/out/nope");
  });
});

describe("shot-cli locale flag", () => {
  test("accepts the default and German locale without starting a GUI run", () => {
    for (const args of [
      ["tiny"],
      ["tiny", "--locale", "de"],
    ]) {
      const run = Bun.spawnSync(["bun", "app/harness/src/shot-cli.ts", ...args], {
        env: { ...process.env, APP_GUI: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain("APP_GUI=1 not set; screenshot skipped");
    }
  });

  test("refuses an unsupported locale before it can start a capture", () => {
    const run = Bun.spawnSync(["bun", "app/harness/src/shot-cli.ts", "tiny", "--locale", "fr"], {
      env: { ...process.env, APP_GUI: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    expect(diagnostic(run)).toContain("--locale must be en or de, not fr");
  });

});

describe("shot-cli mirror route", () => {
  test("keeps the ordinary headless skip behavior", () => {
    const run = Bun.spawnSync(["bun", "app/harness/src/shot-cli.ts", "tiny", "--mirror-changes"], {
      env: { ...process.env, APP_GUI: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("APP_GUI=1 not set; screenshot skipped");
  });

  test("refuses invalid mirror arguments before a headless capture could skip", () => {
    const run = Bun.spawnSync(
      ["bun", "app/harness/src/shot-cli.ts", "tiny", "--mirror-changes", "--theme", "violet"],
      { env: { ...process.env, APP_GUI: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).not.toBe(0);
    expect(diagnostic(run)).toContain("--theme with --mirror-changes must be light or dark");
  });
});
