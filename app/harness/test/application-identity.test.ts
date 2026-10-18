import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchesShellWindowClass, SHELL_WINDOW_CLASS_PATTERN } from "../src/shell";

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

test("window lookup accepts the application identifier and legacy classes, without partial matches", () => {
  const { identifier } = JSON.parse(readFileSync(
    new URL("../../shell-tauri/src-tauri/tauri.conf.json", import.meta.url), "utf8",
  )) as { identifier: string };
  const pattern = new RegExp(SHELL_WINDOW_CLASS_PATTERN);
  for (const name of [identifier, "garret", "Garret"]) {
    expect(pattern.test(name)).toBe(true);
    expect(matchesShellWindowClass(name)).toBe(true);
  }
  for (const name of ["comXusegarretXapp", `${identifier}.other`, `other.${identifier}`, "garret-other", "App-shell-tauri", "app-shell-tauri", "cc.local.app", ""]) {
    expect(pattern.test(name)).toBe(false);
    expect(matchesShellWindowClass(name)).toBe(false);
  }
});
