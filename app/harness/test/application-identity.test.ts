import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the Android override keeps its package when the desktop identifier changes", () => {
  const config = (name: string): { identifier?: string } => JSON.parse(readFileSync(
    new URL(`../../shell-tauri/src-tauri/${name}`, import.meta.url), "utf8",
  ));
  const desktop = config("tauri.conf.json");
  const android = { ...desktop, ...config("tauri.android.conf.json") };
  expect(desktop.identifier).toBe("com.usegarret.app");
  expect(android.identifier).toBe("cc.local.app");
});
