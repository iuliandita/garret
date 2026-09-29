import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE = join(ROOT, "app", "ui", "test", "fixtures", "german-menu.ts");

test("German Alt menu chords use the module-scope German catalog", () => {
  const result = Bun.spawnSync([process.execPath, FIXTURE], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  expect(result.exitCode, `fixture failed\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
  expect(stderr, `fixture reported stderr:\n${stderr}`).toBe("");
  expect(stdout.trim()).toBe('{"ok":true,"locale":"de","chords":["Alt+D","Alt+B","Alt+G","Alt+H"]}');
});
