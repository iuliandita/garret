import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { readDocument, readLegacyDocument, proseText, proseWords, legacyText, legacyMarkedRuns, legacyBodyHash } from "../src/document-read";
import corpus from "../fixtures/document-format.json";

const expected: Record<string, [string, number]> = {
  "legacy-empty-paragraph": ["", 0],
  "legacy-marks-unicode": ["Prose 😀 Second paragraph.", 4],
  endnote: ["Prosetail", 1],
  figure: ["", 0],
  "scene-break": ["", 0],
  mixed: ["Prose   ", 1],
  "figure-half": ["", 0],
  "figure-page": ["", 0],
  "figure-draft-empty-text": ["", 0],
  "empty-document": ["", 0],
  "legacy-mark-order-em-strong-underline": ["Marked prose", 2],
  "legacy-mark-order-underline-strong-em": ["Marked prose", 2],
  "legacy-mark-order-strong-underline-em": ["Marked prose", 2],
  "legacy-empty-paragraph-array": ["Before   After", 2],
  "legacy-empty-paragraph-content": ["", 0],
};

test("shared validation corpus and independent text/count expectations", () => {
  for (const row of corpus) {
    const body = JSON.stringify(row.body);
    const assets = new Set(row.assets);
    if (!row.valid) {
      expect(() => readDocument(body, assets), row.id).toThrow();
      expect(() => proseText(body, assets), row.id).toThrow();
      expect(() => proseWords(body, assets), row.id).toThrow();
    } else {
      expect(readDocument(body, assets), row.id).toEqual(row.body);
      // Every accepted corpus row needs an explicit independent oracle.
      expect(expected[row.id], row.id).toBeDefined();
      expect([proseText(body, assets), proseWords(body, assets)], row.id).toEqual(expected[row.id]!);
    }
    if (row.valid && row.legacy) {
      expect<unknown>(readLegacyDocument(body), row.id).toEqual(row.body);
      expect(legacyText(body), row.id).toBe(expected[row.id]![0]);
    } else {
      expect(() => readLegacyDocument(body), row.id).toThrow();
    }
  }
});

const note = { type: "endnote", attrs: { id: "0199ed16-8c00-7000-8000-000000000001", fmt: "text", body: "Excluded source words 😀" } };
const paragraph = (content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const document = (content: unknown[]) => JSON.stringify({ type: "doc", content });

test("astral text beside atoms, block boundaries, attributes, and Unicode whitespace", () => {
  const body = document([
    paragraph([text("😀left"), note, text("right𐐀")]),
    { type: "scene_break" },
    { type: "figure", attrs: { id: "0199ed16-8c00-7000-8000-000000000002", asset_id: "0199ed16-8c00-7000-8000-000000000003", width: "half", caption: "Excluded caption", alt: "Excluded alternative" } },
    paragraph([text("next\u0085last\ufeffword")]),
  ]);
  const assets = new Set(["0199ed16-8c00-7000-8000-000000000003"]);
  expect(proseText(body, assets)).toBe("😀leftright𐐀   next\u0085last\ufeffword");
  expect(proseWords(body, assets)).toBe(3);
  expect(() => legacyText(body)).toThrow();
  expect(proseWords(document([{ type: "scene_break" }]))).toBe(0);
});

test("mark runs remain exact across adjacent text and empty legacy blocks", () => {
  const body = document([paragraph([{ ...text("be"), marks: [{ type: "em" }] }, { ...text("witched😀"), marks: [{ type: "strong" }] }]), paragraph([])]);
  expect(legacyText(body)).toBe("bewitched😀 ");
  expect(proseWords(body)).toBe(1);
  expect(legacyMarkedRuns(body)).toEqual(["be", "witched😀"]);
  expect(legacyMarkedRuns(body, "em")).toEqual(["be"]);
  expect(legacyBodyHash(document([paragraph([text("😀")])]))).toBe("60b0cfb8");
});

test("malformed JSON, duplicate identities, unknown fields and formats cannot produce partial prose", () => {
  for (const body of ["{", "null", document([paragraph([text("visible"), note, note])]),
    document([paragraph([text("visible"), { ...note, attrs: { ...note.attrs, fmt: "future" } }])]),
    document([paragraph([text("visible"), { ...note, future: true }])])]) {
    expect(() => proseText(body)).toThrow();
    expect(() => legacyMarkedRuns(body)).toThrow();
  }
});

// Runnable rigs have module-level side effects. Keep their reader wiring visible without booting them.
const readers: Record<string, string[]> = {
  "replace-cli": ["legacyText(body)", "readLegacyDocument(body)"],
  "mreplace-cli": ["legacyText(body)"],
  "find-cli": ["legacyText(body)"],
  "history-cli": ["legacyText(body)"],
  "first-cli": ["legacyText(body)"],
  "export-cli": ["legacyText(body)", "legacyMarkedRuns(body, mark)"],
  "import-cli": ["legacyText(body)", "legacyMarkedRuns(body)"],
  "preview-cli": ["legacyText(body)"],
  "sample-build": ["legacyText(body)", "readLegacyDocument(row.body)", "readLegacyDocument(note.body)"],
  "prefs-input": ["readLegacyDocument(body)"],
  "preflight-cli": ["readLegacyDocument(row.body)", "readLegacyDocument(originalBody)"],
  "shot-cli": ["readLegacyDocument(body)", "readLegacyDocument(row.body)"],
  "words-cli": ["proseWords(body)", "legacyMarkedRuns(body, mark)"],
  "goals-cli": ["proseWords(row.body)"],
};
test("direct manuscript readers use the independent strict oracle", () => {
  for (const [file, calls] of Object.entries(readers)) {
    const source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    expect(source, file).toContain('from "./document-read"');
    for (const call of calls) expect(source, file).toContain(call);
    expect(source, file).not.toMatch(/JSON\.parse\((?:row\.)?body\)/);
    expect(source, file).not.toContain("countWordsIn(schema.nodeFromJSON");
    expect(source, file).not.toMatch(/from ["'][^"']*ui\/src\/(?:editor|store)/);
  }
  const oracle = readFileSync(new URL("../src/document-read.ts", import.meta.url), "utf8");
  expect(oracle).not.toMatch(/from\s+["'][^"']*(?:ui|store)/);
});

// The checked-in scene fixtures remain usable by the paragraph-only rigs.
test("legacy scene fixtures retain every text run and mark", () => {
  let documents = 0;
  for (const path of new Glob("**/scenes.ndjson").scanSync("app/fixtures")) {
    const lines = readFileSync(`app/fixtures/${path}`, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line) as { body: unknown };
      expect<unknown>(readLegacyDocument(JSON.stringify(row.body))).toEqual(row.body);
      documents++;
    }
  }
  expect(documents).toBeGreaterThan(0);
});
