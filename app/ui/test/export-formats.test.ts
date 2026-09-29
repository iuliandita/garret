import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXPORT_FORMATS, exportFormatName, isExportFormat } from "../src/export-formats";
import { EN } from "../src/i18n";

const HOST = "../../shell-tauri/src-tauri/src/export.rs";

describe("which formats this application writes", () => {
  test("every format the page knows has a display name in the catalog", () => {
    // Without this the notice reads `Exported ⟦export.format.epub⟧ to ...` --
    // visible, which is the point of the missing-key rendering, and shipped.
    for (const format of EXPORT_FORMATS) {
      expect(EN[`export.format.${format}`]).toBeString();
    }
    // Vacuity guard: an empty list satisfies the loop above perfectly.
    expect(EXPORT_FORMATS.length).toBeGreaterThan(0);
  });

  test("every format the page knows is one the HOST can write", () => {
    // The ids are the host's (`export::Format::id`) and cross on
    // `ExportResult.format`. Restated rather than shared, so this is what fails
    // when the two statements drift -- a page offering a format the host does
    // not have would invoke a command that writes something else or nothing.
    const source = readFileSync(new URL(HOST, import.meta.url), "utf8");
    const ids = [...source.matchAll(/Format::\w+ => "([a-z0-9-]+)",/g)].map((m) => m[1]);
    // The host declares at least its ids: a regex that found none would make
    // the assertion below vacuous.
    expect(ids.length).toBeGreaterThan(0);
    for (const format of EXPORT_FORMATS) expect(ids).toContain(format);
  });

  test("a value off the list is not a format", () => {
    expect(isExportFormat("markdown")).toBe(true);
    expect(isExportFormat("epub")).toBe(true);
    expect(isExportFormat("pdf")).toBe(true);
    expect(isExportFormat("docx")).toBe(true);
    expect(isExportFormat("")).toBe(false);
    expect(isExportFormat(7)).toBe(false);
    expect(isExportFormat(null)).toBe(false);
    expect(isExportFormat(undefined)).toBe(false);
  });

  test("a known id renders its catalog name", () => {
    expect(exportFormatName("markdown")).toBe(EN["export.format.markdown"]);
    // Not the id, which is what a narrowing that fell through would produce and
    // what the next assertion deliberately allows for an UNKNOWN id.
    expect(exportFormatName("markdown")).not.toBe("markdown");
  });

  test("an id this page has no name for renders as itself", () => {
    // A host one version ahead. `Exported djvu to ...` is a worse sentence than
    // a named one and a true one; naming Markdown, EPUB or PDF there would be a
    // lie about the file on disk. The literal was `pdf` until this page made it a
    // format this page names -- which is the drift a test built on "a word
    // nothing writes yet" acquires the moment something writes it.
    expect(exportFormatName("djvu")).toBe("djvu");
  });
});
