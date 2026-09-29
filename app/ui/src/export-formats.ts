// app/ui/src/export-formats.ts
// Which formats this application can write a manuscript as, and what to call
// one to a writer.
//
// A MODULE OF ITS OWN, not three lines inside export-bar.ts. The publishing
// track adds EPUB and PDF, and both need the same narrowing and the same display name in
// a menu the export bar does not own. A rule written inside the unit that
// happens to need it first is the recorded `main.ts` shape: new logic that needs
// coverage must be extracted, not tested in place.
//
// THE IDS ARE THE HOST'S. `export::Format::id` in the Rust host spells them, and
// they cross on `ExportResult.format`. Restated here rather than generated:
// these are two programs, the same rule the harness follows for gate
// thresholds. `export-formats.test.ts` is what fails when they disagree.

import { t } from "./i18n";

/** In the order a menu would offer them. */
export const EXPORT_FORMATS = ["markdown", "epub", "pdf", "docx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * What a writer reads. `markdown` becomes `Markdown`.
 *
 * TAKES A BARE STRING, not an `ExportFormat`, because its caller is holding
 * whatever the host reported having written and not what the page asked for.
 * The two agree today; the point of reporting the format at all is that a build
 * where they stopped agreeing must say what it actually wrote.
 *
 * An id with no catalog name renders as the id itself. Not a fallback nobody
 * can reach: a host one version ahead of this page is exactly the case, and a
 * notice reading `Exported epub to ...` is a worse sentence and a true one,
 * where a notice naming Markdown would be a lie about the file on disk.
 */
export function exportFormatName(id: string): string {
  return isExportFormat(id) ? t(`export.format.${id}`) : id;
}
