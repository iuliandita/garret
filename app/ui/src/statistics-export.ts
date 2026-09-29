// app/ui/src/statistics-export.ts
// The statistics panel's figures as a data file: CSV or JSON, the writer's
// choice, to a destination they pick in the operating system's own dialog.
//
// THE PAGE COMPOSES THE BYTES, THE HOST NAMES THE FILE. The figures exist only
// here (`computeStatistics` reads the tree the page holds), so the text is built
// here; the export slice's refusal of a page-supplied PATH is untouched, because
// the host picks the destination and does the crash-safe write. Same split as
// `project_export_as`, with the renderer on the other side.
//
// THE DEFINITION TRAVELS WITH THE NUMBER, here as much as in the panel. Every
// row of both files carries its label and its definition beside its value, so
// a spreadsheet opened next month still says what each figure counts. The raw
// number is `StatRow.raw`, never the formatted `value`: a locale's thousands
// separator is not a thing a data file should have to be parsed around.
import { t } from "./i18n";
import {
  computeStatistics,
  statisticRows,
  STATISTICS_EMPTY,
  STATISTICS_NOTE,
  type SessionTotals,
  type StatGroup,
  type TodayFigures,
} from "./statistics";
import type { DocumentStatisticsCounts } from "./outline-counts";
import type { ProjectItem } from "./store/source";

export type StatisticsFileKind = "csv" | "json";

/** What the host says it wrote. */
export interface StatisticsWritten {
  path: string;
}

/** The version of the file's SHAPE, not of the word rule (which the note states
 *  in words). Bumped when a column or field is renamed or removed, so a script
 *  reading last month's file can tell. */
export const STATISTICS_FILE_VERSION = 1;

const QUOTE = String.fromCharCode(34);

const CSV_HEADER = ["group", "key", "label", "value", "detail", "definition"];

/** RFC 4180 quoting: a field holding a comma, a quote or a line break is
 *  wrapped, and quotes inside it are doubled. Everything else is written
 *  bare, so the file stays readable in a terminal. */
export function csvField(text: string): string {
  // The quote as a named constant, not a character inside a regex: the suite's
  // literal scanner tokenises source by quote marks and reads a `"` inside a
  // regex as the start of a string.
  const needsQuoting = text.includes(QUOTE) || text.includes(",") || /[\r\n]/.test(text);
  if (!needsQuoting) return text;
  return QUOTE + text.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
}

const rawText = (raw: number | null): string => (raw === null ? "" : String(raw));

/** The rows as CSV, one figure per line, header first. Unix line ends: the
 *  application is Linux-only and every spreadsheet reads them. An absent value
 *  is an EMPTY cell, which is what a spreadsheet treats as no reading; the
 *  panel's dash would be a string in a numeric column. */
export function statisticsCsv(groups: readonly StatGroup[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const group of groups) {
    for (const row of group.rows) {
      lines.push(
        [group.heading, row.key, row.label, rawText(row.raw), row.detail ?? "", row.definition]
          .map(csvField)
          .join(","),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The rows as JSON, plus the shared rule the panel prints once at its foot.
 *  The note has no place in a CSV (no column is "about the whole file"), and
 *  that is the one thing the two files differ in. */
export function statisticsJson(groups: readonly StatGroup[], note: string): string {
  const figures = groups.flatMap((group) =>
    group.rows.map((row) => ({
      group: group.heading,
      key: row.key,
      label: row.label,
      value: row.raw,
      detail: row.detail,
      definition: row.definition,
    })),
  );
  const file = { format: "statistics", version: STATISTICS_FILE_VERSION, note, figures };
  return JSON.stringify(file, null, 2) + "\n";
}

export interface StatisticsExportDeps {
  /** Settle pending edits first. Every figure is "as saved", exactly as the
   *  panel's are. */
  drain(): Promise<void>;
  items(): readonly ProjectItem[];
  documentCounts(): Promise<DocumentStatisticsCounts>;
  openItemId(): string | null;
  session(): SessionTotals;
  today(): Promise<TodayFigures>;
  /** Ask the host to put `text` where the writer chooses. Resolves null when
   *  they cancelled, which is an answer and raises nothing. */
  write(kind: StatisticsFileKind, text: string): Promise<StatisticsWritten | null>;
  onDone(message: string): void;
  onNotice(message: string): void;
}

export interface StatisticsExport {
  run(kind: StatisticsFileKind): void;
  /** Whether a run is in flight. Two activations produce one file. */
  isRunning(): boolean;
}

const kindName = (kind: StatisticsFileKind): string => t(`stats.export.format.${kind}`);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createStatisticsExport(deps: StatisticsExportDeps): StatisticsExport {
  let running = false;

  const run = async (kind: StatisticsFileKind): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Drain and count inside one try, as the export bar does: a file written
      // after the save path failed is missing the writer's last edits.
      await deps.drain();
      const perDoc = await deps.documentCounts();
      const stats = computeStatistics({
        items: deps.items(),
        perDoc,
        openItemId: deps.openItemId(),
        session: deps.session(),
        today: await deps.today(),
      });
      // The panel's empty state, said in the notice channel: a file of
      // dashes would claim measurements nobody made.
      if (stats.structure.scenes === 0) {
        deps.onNotice(STATISTICS_EMPTY);
        return;
      }
      const groups = statisticRows(stats);
      const text = kind === "csv" ? statisticsCsv(groups) : statisticsJson(groups, STATISTICS_NOTE);
      const written = await deps.write(kind, text);
      if (written === null) return;
      deps.onDone(t("export.done", { format: kindName(kind), path: written.path }));
    } catch (error: unknown) {
      deps.onNotice(t("export.error", { format: kindName(kind), error: messageOf(error) }));
    } finally {
      running = false;
    }
  };

  return {
    run(kind) {
      void run(kind);
    },
    isRunning: () => running,
  };
}
