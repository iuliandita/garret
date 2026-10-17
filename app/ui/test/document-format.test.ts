import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { MAX_ATTRIBUTE_BYTES, validDocument } from "../src/document-format";
import { readableBody } from "../src/editor";

type Case = { id: string; body: unknown; assets: string[]; valid: boolean; legacy: boolean };
const cases = JSON.parse(readFileSync(new URL("../../harness/fixtures/document-format.json", import.meta.url), "utf8")) as Case[];

test("format corpus agrees on strict future validation and current refusal", () => {
  expect(cases.length).toBeGreaterThan(40);
  for (const fixture of cases) {
    expect(validDocument(fixture.body, true, new Set(fixture.assets)), fixture.id).toBe(fixture.valid);
    expect(validDocument(fixture.body), fixture.id).toBe(fixture.legacy);
    expect(readableBody(JSON.stringify(fixture.body)) !== null, fixture.id).toBe(fixture.legacy);
  }
});

test("attribute bounds count UTF-8 bytes", () => {
  const source = cases.find((fixture) => fixture.id === "endnote")!;
  for (const [text, valid] of [["é".repeat(MAX_ATTRIBUTE_BYTES / 2), true], ["é".repeat(MAX_ATTRIBUTE_BYTES / 2) + "a", false]] as const) {
    const body = structuredClone(source.body) as { content: { content: { attrs?: { body: string } }[] }[] };
    body.content[0].content[1].attrs!.body = text;
    expect(validDocument(body, true)).toBe(valid);
  }
});
