import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveIfPresent, archiveStamp } from "../src/archive";

describe("archiveIfPresent", () => {
  test("returns null when there is nothing to displace", () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-"));
    expect(archiveIfPresent(join(dir, "absent.json"))).toBeNull();
  });

  test("moves an existing file into superseded/ and frees the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-"));
    const path = join(dir, "run.json");
    writeFileSync(path, `{"first":true}`);

    const moved = archiveIfPresent(path);

    expect(moved).not.toBeNull();
    expect(moved!).toContain("superseded");
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(moved!, "utf8"))).toEqual({ first: true });
  });

  test("two displacements in the same second do not collapse into one entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-"));
    const path = join(dir, "run.json");

    writeFileSync(path, `{"n":1}`);
    const first = archiveIfPresent(path)!;
    writeFileSync(path, `{"n":2}`);
    const second = archiveIfPresent(path)!;

    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ n: 1 });
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({ n: 2 });
  });

  test("stamp is filesystem-safe and drops milliseconds", () => {
    expect(archiveStamp(new Date("2026-07-29T10:20:30.456Z"))).toBe("2026-07-29T10-20-30Z");
  });
});
