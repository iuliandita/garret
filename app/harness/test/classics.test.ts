import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIC_FIXTURES, resolveFixtureDir } from "../src/fixture-name";
import { CLASSIC_VAULT, pinClassicBook, writeClassicVault } from "../src/classic-identities";
import { BIN } from "../src/shell";
import { parseTimeline } from "../../ui/src/timeline-model";

describe("classic sample books", () => {
  test("repin captures put the current stale author first", () => {
    const work = mkdtempSync(join(tmpdir(), "garret-classic-vault-"));
    try {
      for (const fixture of CLASSIC_FIXTURES) {
        writeClassicVault(work, fixture);
        const vault = JSON.parse(readFileSync(join(work, "cc.local.app", "identities.json"), "utf8"));
        expect(vault.identities[0].id).toBe(`classic-${fixture}`);
        expect(vault.identities[0].rev).toBe(2);
        expect(vault.identities.slice(1).every((identity: { rev: number }) => identity.rev === 1)).toBe(true);
      }
      expect(CLASSIC_VAULT.identities.every((identity) => identity.rev === 1)).toBe(true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  for (const fixture of CLASSIC_FIXTURES) {
    test(`${fixture} has three chapters, complete synopses, and a valid linked timeline`, () => {
      const dir = resolveFixtureDir(fixture);
      const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
        items: { id: string; type: string }[];
      };
      expect(project.items.filter((item) => item.type === "chapter")).toHaveLength(3);
      const sceneIds = project.items.filter((item) => item.type === "scene").map((item) => item.id).sort();
      const synopses = readFileSync(join(dir, "synopses.ndjson"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { itemId: string; body: string });
      expect(synopses.map((row) => row.itemId).sort()).toEqual(sceneIds);
      expect(synopses.every((row) => row.body.length > 40)).toBe(true);
      const timeline = JSON.parse(readFileSync(join(dir, "timelines.ndjson"), "utf8")) as { body: unknown };
      const parsed = parseTimeline(JSON.stringify(timeline.body));
      if ("invalid" in parsed || "newer" in parsed) throw new Error(`${fixture}: invalid timeline`);
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.events.every((event) => event.scene === null || sceneIds.includes(event.scene))).toBe(true);
    });

    test.skipIf(!existsSync(BIN))(`${fixture} rebuilds and seeds with its actual author`, () => {
      const dir = resolveFixtureDir(fixture);
      const work = mkdtempSync(join(tmpdir(), "garret-classic-test-"));
      try {
        const rebuilt = Bun.spawnSync(["bun", "app/harness/src/sample-build.ts", "--check", "--src", join(dir, "src"), "--out", dir], {
          env: { ...process.env, XDG_DATA_HOME: work }, stdout: "pipe", stderr: "pipe",
        });
        expect(rebuilt.exitCode).toBe(0);
        const path = join(work, "book.db");
        const seeded = Bun.spawnSync([BIN, "--seed", dir, path], { stdout: "pipe", stderr: "pipe" });
        expect(seeded.exitCode).toBe(0);
        pinClassicBook(path, fixture);
        writeClassicVault(work);
        const db = new Database(path, { readonly: true });
        try {
          const row = db.query("SELECT value FROM meta WHERE key='identity.pin'").get() as { value: string };
          const pin = JSON.parse(row.value) as { identity_id: string; public: { name: string }; private?: unknown };
          const author = CLASSIC_VAULT.identities.find((entry) => entry.id === pin.identity_id);
          if (author === undefined) throw new Error(`Missing author for ${fixture}`);
          expect(pin.public.name).toBe(author.public.name);
          expect(pin.private).toBeUndefined();
          const vault = JSON.parse(readFileSync(join(work, "cc.local.app", "identities.json"), "utf8"));
          expect(vault.identities).toHaveLength(3);
        } finally { db.close(); }
        const validation = Bun.spawnSync([BIN, "validate", path, "--json"], { stdout: "pipe", stderr: "pipe" });
        expect(validation.exitCode).toBe(0);
        expect(JSON.parse(validation.stdout.toString()).ok).toBe(true);
      } finally { rmSync(work, { recursive: true, force: true }); }
    });
  }

  test("Mrs. Long is a named cast entry without an invented on-page appearance", () => {
    const dir = resolveFixtureDir("pride-and-prejudice");
    const cast = JSON.parse(readFileSync(join(dir, "src/cast.json"), "utf8")) as { name: string; appears: string[] }[];
    expect(cast.find((entry) => entry.name === "Mrs. Long")?.appears).toEqual([]);
    expect(readFileSync(join(dir, "src/manuscript.md"), "utf8")).toContain("Mrs. Long");
  });
});
