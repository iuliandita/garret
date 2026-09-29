// lab/shared/archive.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveIfPresent, archiveStamp, SUPERSEDED_DIR } from "./archive";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "archive-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, body: string, mtime?: Date): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe("archiveIfPresent", () => {
  test("does nothing when there is no previous run", () => {
    expect(archiveIfPresent(join(dir, "absent.json"))).toBeNull();
    expect(existsSync(join(dir, SUPERSEDED_DIR))).toBe(false);
  });

  // The whole point: the earlier run's bytes must still exist afterwards.
  test("moves the previous run aside instead of destroying it", () => {
    const path = write("run.json", '{"run":"first"}');
    const archived = archiveIfPresent(path)!;

    expect(existsSync(path)).toBe(false);          // freed for the new write
    expect(readFileSync(archived, "utf8")).toBe('{"run":"first"}');
    expect(archived).toContain(SUPERSEDED_DIR);
  });

  test("stamps the archive with the displaced run's own mtime", () => {
    const when = new Date("2026-07-24T09:15:30.000Z");
    const archived = archiveIfPresent(write("run.json", "x", when))!;
    expect(archived).toContain(archiveStamp(when));
    expect(archived.endsWith(".json")).toBe(true);
  });

  // Two runs displaced inside the same second must not collapse into one entry.
  // That would reproduce the original bug one directory down.
  test("keeps every displaced run when stamps collide", () => {
    const when = new Date("2026-07-24T09:15:30.000Z");
    const bodies = ["first", "second", "third"];
    for (const body of bodies) {
      archiveIfPresent(write("run.json", body, when));
    }

    const kept = readdirSync(join(dir, SUPERSEDED_DIR))
      .map((f) => readFileSync(join(dir, SUPERSEDED_DIR, f), "utf8"))
      .sort();
    expect(kept).toEqual([...bodies].sort());
  });

  test("reuses an existing superseded directory", () => {
    mkdirSync(join(dir, SUPERSEDED_DIR), { recursive: true });
    expect(archiveIfPresent(write("run.json", "x"))).toContain(SUPERSEDED_DIR);
  });
});

describe("archiveStamp", () => {
  // Colons are legal on ext4 but hostile on other filesystems and in shell
  // arguments; results are meant to be copyable off this machine.
  test("produces a filesystem-safe stamp", () => {
    const stamp = archiveStamp(new Date("2026-07-24T09:15:30.123Z"));
    expect(stamp).toBe("2026-07-24T09-15-30Z");
    expect(stamp).not.toContain(":");
  });
});
