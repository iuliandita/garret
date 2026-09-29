import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DE } from "../src/i18n/de";
import { EN } from "../src/i18n/en";

const HOST = readFileSync(
  join(import.meta.dir, "..", "..", "shell-tauri", "src-tauri", "src", "strings.rs"),
  "utf8",
);

const STARTER_KEYS = ["item.numbered.chapter", "item.numbered.scene"] as const;

function hostValue(locale: "en" | "de", key: (typeof STARTER_KEYS)[number]): string {
  const catalog = locale === "en" ? "EN_ENTRIES" : "DE_ENTRIES";
  const section = HOST.match(new RegExp(`const ${catalog}[^=]*= &\\[([\\s\\S]*?)\\n\\];`));
  expect(section, `${catalog} must exist`).not.toBeNull();
  const matched = [...section![1]!.matchAll(new RegExp(`\\("${key.replaceAll(".", "\\.")}", "([^"]+)"\\)`, "g"))];
  expect(matched.length, `${catalog} must hold ${key} exactly once`).toBe(1);
  return matched[0]![1]!;
}

describe("starter titles stay in the page and host catalogs together", () => {
  test("English literals name the first chapter and scene", () => {
    expect(EN["item.numbered.chapter"]).toBe("Chapter {n}");
    expect(EN["item.numbered.scene"]).toBe("Scene {n}");
    for (const key of STARTER_KEYS) expect(hostValue("en", key)).toBe(EN[key]);
  });

  test("German literals name the first chapter and scene", () => {
    expect(DE["item.numbered.chapter"]).toBe("Kapitel {n}");
    expect(DE["item.numbered.scene"]).toBe("Szene {n}");
    for (const key of STARTER_KEYS) expect(hostValue("de", key)).toBe(DE[key]);
  });
});
