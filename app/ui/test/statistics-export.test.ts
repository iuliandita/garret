import { describe, expect, test } from "bun:test";
import {
  createStatisticsExport,
  csvField,
  statisticsCsv,
  statisticsJson,
  STATISTICS_FILE_VERSION,
  type StatisticsExportDeps,
  type StatisticsFileKind,
  type StatisticsWritten,
} from "../src/statistics-export";
import { computeStatistics, statisticRows, STATISTICS_EMPTY, type StatGroup } from "../src/statistics";
import type { ProjectItem } from "../src/store/source";

function item(id: string, type: string, parent_id: string | null, title = id): ProjectItem {
  return { id, parent_id, type, title, position: id, rev: 1, state: null, depth: 0 };
}

/** One chapter of two scenes, one of them uncounted, plus a scene with a
 *  comma and a quote in its title so the quoting rule is exercised by a row
 *  that is actually in the file. */
const ITEMS: ProjectItem[] = [
  item("c1", "chapter", null, 'Chapter "One", revised'),
  item("s1", "scene", "c1", "Arrival"),
  item("s2", "scene", "c1", "Unread"),
];
const COUNTS = { s1: { words: 120, sentences: 4, paragraphs: 1 } };

const groups = (): readonly StatGroup[] =>
  statisticRows(
    computeStatistics({
      items: ITEMS,
      perDoc: COUNTS,
      openItemId: "s1",
      session: { added: 3, deleted: 5, net: -2 },
      today: { writingMinutes: 75, tracking: "on", sources: {
        available: true, collecting: true, interrupted: false, started_at: 1_600_000_000_000, today_typing: 3, warning: null,
        totals: { typing: { added: 5, deleted: 2 }, pasted: { added: 20, deleted: 0 },
          imported: { added: 0, deleted: 0 }, restored: { added: 0, deleted: 4 },
          unattributed: { added: 0, deleted: 0 } },
      } },
    }),
  );

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("csvField", () => {
  test("bare when nothing needs quoting, quoted and doubled otherwise", () => {
    expect(csvField("plain words")).toBe("plain words");
    expect(csvField("a, b")).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("statisticsCsv", () => {
  test("one header, one line per row, raw numbers and empty cells for absences", () => {
    const text = statisticsCsv(groups());
    const lines = text.split("\n");
    expect(lines[0]).toBe("group,key,label,value,detail,definition");
    // Every row of every group is a line, and the file ends in a newline.
    const rows = groups().reduce((n, g) => n + g.rows.length, 0);
    expect(lines.length).toBe(rows + 2);
    expect(lines.at(-1)).toBe("");
    const scene = lines.find((l) => l.startsWith("Words,scene,"));
    expect(scene).toContain(",120,");
    // The part scope is absent: an EMPTY cell, not the panel's dash.
    const part = lines.find((l) => l.startsWith("Words,part,"));
    expect(part).toMatch(/^Words,part,This part,,/);
    expect(text).not.toContain("—");
    // A negative session net is a signed number, not the panel's "-2" string
    // with locale grouping -- the same digits here, but from `raw`.
    const net = lines.find((l) => l.startsWith("This session,net,"));
    expect(net).toContain(",-2,");
    expect(lines.find((line) => line.includes(",source-restored,"))).toContain(",-4,Added 0; removed 4.,");
  });

  test("a title holding a comma and a quote survives as one field", () => {
    const chapter = statisticsCsv(groups())
      .split("\n")
      .find((l) => l.startsWith("Words,chapter,"));
    expect(chapter).toContain('"Chapter ""One"", revised"');
  });
});

describe("statisticsJson", () => {
  test("carries the version, the note and one figure per row with the raw value", () => {
    const parsed = JSON.parse(statisticsJson(groups(), "the rule")) as {
      format: string;
      version: number;
      note: string;
      figures: { key: string; value: number | null; definition: string; group: string }[];
    };
    expect(parsed.format).toBe("statistics");
    expect(parsed.version).toBe(STATISTICS_FILE_VERSION);
    expect(parsed.note).toBe("the rule");
    const byKey = new Map(parsed.figures.map((f) => [f.key, f]));
    expect(parsed.figures.filter((f) => f.key === "chapter-sentences")).toHaveLength(1);
    expect(parsed.figures.filter((f) => f.key === "part-paragraphs")).toHaveLength(1);
    expect(byKey.get("scene")?.value).toBe(120);
    expect(byKey.get("chapter-sentences")?.value).toBe(4);
    expect(byKey.get("part-paragraphs")?.value).toBeNull();
    expect(byKey.get("part")?.value).toBeNull();
    expect(byKey.get("uncounted")?.value).toBe(1);
    expect(byKey.get("net")?.value).toBe(-2);
    expect(byKey.get("source-typing")?.value).toBe(3);
    expect(byKey.get("source-pasted")?.value).toBe(20);
    expect(byKey.get("source-restored")?.value).toBe(-4);
    expect(byKey.get("source-typing")?.definition).toContain("earlier activity is not reconstructed");
    expect(byKey.get("scene")?.definition.length).toBeGreaterThan(0);
    expect(byKey.get("scene")?.group).toBe("Words");
  });
});

interface Rig {
  calls: string[];
  notices: string[];
  dones: string[];
  written: { kind: StatisticsFileKind; text: string }[];
}

function mount(
  over: Partial<StatisticsExportDeps> & { items?: () => readonly ProjectItem[] } = {},
): Rig & { run: (kind: StatisticsFileKind) => void; isRunning: () => boolean } {
  const rig: Rig = { calls: [], notices: [], dones: [], written: [] };
  const unit = createStatisticsExport({
    drain: () => {
      rig.calls.push("drain");
      return Promise.resolve();
    },
    items: () => ITEMS,
    documentCounts: () => {
      rig.calls.push("counts");
      return Promise.resolve(COUNTS);
    },
    openItemId: () => "s1",
    session: () => ({ added: 0, deleted: 0, net: 0 }),
    today: () => Promise.resolve({ writingMinutes: 0, tracking: "on" as const }),
    write: (kind, text) => {
      rig.calls.push("write");
      rig.written.push({ kind, text });
      return Promise.resolve<StatisticsWritten | null>({ path: `/books/out.${kind}` });
    },
    onDone: (m) => rig.dones.push(m),
    onNotice: (m) => rig.notices.push(m),
    ...over,
  });
  return { ...rig, run: unit.run, isRunning: unit.isRunning };
}

describe("createStatisticsExport", () => {
  test("drains, counts, writes the kind asked for, and reports the path as good news", async () => {
    const rig = mount();
    rig.run("json");
    await settle();
    expect(rig.calls).toEqual(["drain", "counts", "write"]);
    expect(rig.written[0]?.kind).toBe("json");
    expect(JSON.parse(rig.written[0]?.text ?? "").format).toBe("statistics");
    expect(rig.dones).toEqual(["Exported statistics JSON to /books/out.json"]);
    expect(rig.notices).toEqual([]);
  });

  test("a cancelled dialog says nothing at all", async () => {
    const rig = mount({ write: () => Promise.resolve(null) });
    rig.run("csv");
    await settle();
    expect(rig.dones).toEqual([]);
    expect(rig.notices).toEqual([]);
  });

  test("a failed write is a notice naming the kind, and a failed drain writes nothing", async () => {
    const failed = mount({ write: () => Promise.reject(new Error("disk full")) });
    failed.run("csv");
    await settle();
    expect(failed.notices).toEqual(["statistics CSV export failed: disk full"]);
    const drain = mount({ drain: () => Promise.reject(new Error("save failed")) });
    drain.run("json");
    await settle();
    // `over` replaced the spying drain, so the log shows only what came AFTER
    // it: nothing was counted and nothing was written.
    expect(drain.calls).toEqual([]);
    expect(drain.notices).toEqual(["statistics JSON export failed: save failed"]);
  });

  test("a manuscript with no scenes is the panel's empty sentence, and no file", async () => {
    const rig = mount({ items: () => [item("c1", "chapter", null)] });
    rig.run("csv");
    await settle();
    expect(rig.written).toEqual([]);
    expect(rig.notices).toEqual([STATISTICS_EMPTY]);
  });

  test("two activations produce one file", async () => {
    const rig = mount();
    rig.run("csv");
    rig.run("csv");
    expect(rig.isRunning()).toBe(true);
    await settle();
    expect(rig.written.length).toBe(1);
    expect(rig.isRunning()).toBe(false);
  });
});
