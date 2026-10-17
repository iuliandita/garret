import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Android inherits the shared application identifier", () => {
  const config = (name: string): { identifier?: string } => JSON.parse(readFileSync(
    new URL(`../../shell-tauri/src-tauri/${name}`, import.meta.url), "utf8",
  ));
  const desktop = config("tauri.conf.json");
  const override = config("tauri.android.conf.json");
  const android = { ...desktop, ...override };
  expect(override.identifier).toBeUndefined();
  expect(desktop.identifier).toBe("com.usegarret.app");
  expect(android.identifier).toBe("com.usegarret.app");
});
