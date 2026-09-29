import { describe, expect, test } from "bun:test";
import { craftReportCsv, createCraftReport, knowledgeConsistency, type ReportOptions } from "../src/craft-report";

const options = (over: Partial<ReportOptions> = {}): ReportOptions => ({
  scope: "book", language: "en", quote_convention: "curly_double", watchlist: [],
  max_documents: 20, max_words: 20_000, max_findings: 100, ...over,
});

const body = (...paragraphs: { text: string; mark?: string }[][]): string => JSON.stringify({
  type: "doc", content: paragraphs.map((runs) => ({ type: "paragraph", content: runs.map((run) => ({
    type: "text", text: run.text, ...(run.mark ? { marks: [{ type: run.mark }] } : {}),
  })) })),
});

describe("bounded craft reports", () => {
  test("reports adjacent words, nearby repeated phrases and exact UTF-16 positions across marks", () => {
    const run = createCraftReport(options());
    expect(run.add({ item_id: "s1", title: "Scene", rev: 7, body: body([
      { text: "😀 one one ", mark: "em" },
      { text: "blue dark sea, blue dark sea." },
    ]) })).toBe(true);
    const report = run.finish();
    expect(report.findings.map((finding) => finding.kind)).toContain("adjacent_word");
    const repeated = report.findings.find((finding) => finding.kind === "repeated_phrase");
    expect(repeated?.matched).toBe("blue dark sea");
    expect(repeated?.from).toBe(27);
    expect(repeated?.rev).toBe(7);
    expect(report.metrics.paragraph_words).toEqual([8]);
    expect(report.metrics.english_readability).not.toBeNull();
  });

  test("distinguishes literal and folded watchlist terms without cutting a surrogate or expanded fold", () => {
    const run = createCraftReport(options({ watchlist: [
      { text: "İ", mode: "folded" }, { text: "İ", mode: "literal" },
    ] }));
    run.add({ item_id: "s1", title: "Scene", rev: 1, body: body([{ text: "😀 İ and i̇" }]) });
    const matches = run.finish().findings.filter((finding) => finding.kind === "watchlist");
    expect(matches.filter((finding) => finding.term === "İ").length).toBe(3);
    expect(matches.map((finding) => finding.from)).toContain(4);
    expect(matches.every((finding) => finding.to > finding.from)).toBe(true);
    const partial = createCraftReport(options({ watchlist: [{ text: "i", mode: "folded" }] }));
    partial.add({ item_id: "s2", title: "Partial", rev: 1, body: body([{ text: "İ" }]) });
    expect(partial.finish().findings).toEqual([]);
  });

  test("states quotation ambiguity and refuses English readability for another manuscript language", () => {
    const run = createCraftReport(options({ language: "de", quote_convention: "ascii_double" }));
    run.add({ item_id: "s1", title: "Szene", rev: 1, body: body([{ text: '"Hallo" hier "offen. Dr. X.' }]) });
    const report = run.finish();
    expect(report.metrics.dialogue_words).toBe(1);
    expect(report.metrics.unmatched_quotes).toBe(1);
    expect(report.metrics.english_readability).toBeNull();
    expect(report.definitions.sentences).toContain("abbreviations can be miscounted");
  });

  test("caps work and quotes formula-leading CSV cells while JSON values stay exact", () => {
    const run = createCraftReport(options({ max_documents: 1, max_words: 5, max_findings: 1,
      watchlist: [{ text: "=SUM(1)", mode: "literal" }] }));
    expect(run.add({ item_id: "=scene", title: "=Title", rev: 1,
      body: body([{ text: "=SUM(1) one one." }]) })).toBe(false);
    expect(run.add({ item_id: "s2", title: "Other", rev: 1, body: body([{ text: "other" }]) })).toBe(false);
    const report = run.finish();
    expect(report.sources[0]?.title).toBe("=Title");
    expect(craftReportCsv(report)).toContain("'=scene");
    expect(craftReportCsv(report)).toContain("'=SUM(1)");
    expect(JSON.stringify(report)).toContain('"title":"=Title"');
  });

  test("reports retained unavailable links, missing originals, alias collisions and untagged entries", () => {
    const found = knowledgeConsistency({
      links: [{ source_caption: "Ada", target_caption: "Old note", source_available: true, target_available: false }],
      resources: [{ title: "Map", available: false, removed_at: null }],
      cast: [
        { id: "a", name: "Ada", aliases: ["Captain"] },
        { id: "b", name: "Bela", aliases: ["captain"] },
      ],
      appearances: { scene: ["a"] },
    });
    expect(found.map((finding) => finding.kind)).toEqual([
      "unavailable_link", "missing_resource", "unused_entry", "alias_collision",
    ]);
    expect(found[0]?.detail).toBe("Old note");
    expect(found.every((finding) => finding.caption.length > 0)).toBe(true);
  });
});
