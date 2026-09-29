import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN } from "../src/shell";
import { build, diff, write, resolveTimelineBody } from "../src/sample-build";
import { parseTimeline } from "../../ui/src/timeline-model";

// Every test here runs the real `import` subcommand, exactly as the generator
// does: 094 decision 2 is that there is ONE Markdown parser, so a test double
// standing in for it would test a second, private idea of the format instead
// of the one the generator actually calls. `skipIf` degrades gracefully in an
// environment with no release build, the same way `import-cli.ts` does.
const bin = existsSync(BIN);

/** A small inline fixture -- 094 decision 7's own rule: these tests write
 *  their own tiny `src/`, never the real one at `app/fixtures/sample/src`. */
function writeSrc(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

const MANUSCRIPT = [
  "# Test Book",
  "",
  "## Chapter One",
  "",
  "### Scene A",
  "",
  "Some prose here about a harbour.",
  "",
  "### Scene B",
  "",
  "More prose, about a second harbour.",
  "",
].join("\n");

describe("build", () => {
  test.skipIf(!bin)("turns a manuscript into deterministic items and scenes", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, { "manuscript.md": MANUSCRIPT });
      const built = build(src);
      const project = JSON.parse(built.projectJson) as {
        items: Array<{ id: string; type: string; title: string; parentId: string | null }>;
      };
      expect(project.items.map((i) => i.title)).toEqual(["Chapter One", "Scene A", "Scene B"]);
      expect(project.items[0]?.id).toBe("sc-000000");
      expect(project.items[1]?.parentId).toBe("sc-000000");
      expect(built.castNdjson).toBe("");
      expect(built.synopsesNdjson).toBe("");
      expect(built.appearancesNdjson).toBe("");
      expect(built.timelinesNdjson).toBe("");
      const manifest = JSON.parse(built.manifestJson) as { itemCount: number; noteCount: number };
      expect(manifest.itemCount).toBe(3);
      expect(manifest.noteCount).toBe(0);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("rebuilding the same src produces byte-identical output", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, { "manuscript.md": MANUSCRIPT });
      const first = build(src);
      const second = build(src);
      expect(second).toEqual(first);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("a bible note's title and body come from its own file, marks intact", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "bible/magic.md": "# The Old Magic\n\nThe tide remembers *everything* it touched.\n",
      });
      const built = build(src);
      const project = JSON.parse(built.projectJson) as {
        items: Array<{ id: string; type: string; title: string; parentId: string | null }>;
      };
      const bibleRoot = project.items.find((i) => i.type === "bible");
      const note = project.items.find((i) => i.type === "note");
      expect(bibleRoot?.title).toBe("Bible");
      expect(bibleRoot?.parentId).toBeNull();
      expect(note?.title).toBe("The Old Magic");
      expect(note?.parentId).toBe(bibleRoot?.id);

      const scenes = built.scenesNdjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; body: unknown });
      const noteScene = scenes.find((s) => s.id === note?.id);
      const text = JSON.stringify(noteScene?.body);
      expect(text).toContain('"marks":[{"type":"em"}]');
      expect(text).toContain("everything");

      const manifest = JSON.parse(built.manifestJson) as { noteCount: number };
      expect(manifest.noteCount).toBe(1);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  // A LITERAL `null`, NOT A MISSING FILE, is 101's own way of shipping
  // "nothing here yet" -- `readSrcTimeline`'s own comment names why: the
  // committed src/timeline.json exists and still means no timeline, which is
  // exactly what the `--check` drift test has to keep passing against.
  test.skipIf(!bin)("a literal null in timeline.json is the same as no file at all", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, { "manuscript.md": MANUSCRIPT, "timeline.json": "null" });
      const built = build(src);
      expect(built.timelinesNdjson).toBe("");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("timeline.json becomes one deterministic timelines.ndjson line", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "timeline.json": JSON.stringify({
          title: "Timeline",
          body: { kind: "timeline", version: 1, tracks: [], branches: [], events: [] },
        }),
      });
      const built = build(src);
      const lines = built.timelinesNdjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; title: string; body: unknown });
      expect(lines).toHaveLength(1);
      // ITS OWN COUNTER, `tl-`, NOT `sc-`'s (101 NIT fix): a timeline is
      // minted by this generator rather than the store, so nothing ties its
      // numbering to the manuscript's -- the first (and only) one is
      // tl-000000 regardless of how many sc- ids came before it.
      expect(lines[0]?.id).toBe("tl-000000");
      expect(lines[0]?.title).toBe("Timeline");
      expect((lines[0]?.body as { kind: string }).kind).toBe("timeline");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("an event naming a scene title the manuscript does not have fails the build", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "timeline.json": JSON.stringify({
          title: "Timeline",
          body: {
            kind: "timeline",
            version: 1,
            tracks: [],
            branches: [],
            events: [
              {
                id: "v1",
                title: "Ghost scene",
                at: 0,
                until: null,
                tracks: [],
                branch: null,
                scene: "A Scene That Was Never Written",
                cast: [],
                note: "",
              },
            ],
          },
        }),
      });
      expect(() => build(src)).toThrow(/A Scene That Was Never Written/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("a cast track or event naming a cast member cast.json does not have fails the build", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "timeline.json": JSON.stringify({
          title: "Timeline",
          body: {
            kind: "timeline",
            version: 1,
            tracks: [{ id: "t1", name: "Nobody", kind: "cast", memberId: "Nobody At All", colour: 1 }],
            branches: [],
            events: [],
          },
        }),
      });
      expect(() => build(src)).toThrow(/Nobody At All/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)(
    "resolveTimelineBody turns a scene title into the manuscript's real id and leaves cast names as names",
    () => {
      const sceneTitleToId = new Map([["Scene A", "sc-000042"]]);
      const knownCastNames = new Set(["Ada"]);
      const resolved = resolveTimelineBody(
        {
          kind: "timeline",
          version: 1,
          tracks: [{ id: "t1", name: "Ada", kind: "cast", memberId: "Ada", colour: 1 }],
          branches: [],
          events: [
            {
              id: "v1",
              title: "First",
              at: 0,
              until: null,
              tracks: ["t1"],
              branch: null,
              scene: "Scene A",
              cast: ["Ada"],
              note: "",
            },
          ],
        },
        sceneTitleToId,
        knownCastNames,
      ) as {
        tracks: Array<{ memberId: string }>;
        events: Array<{ scene: string; cast: string[] }>;
      };
      expect(resolved.events[0]?.scene).toBe("sc-000042");
      expect(resolved.events[0]?.cast).toEqual(["Ada"]);
      expect(resolved.tracks[0]?.memberId).toBe("Ada");
    },
  );

  test.skipIf(!bin)("the real sample fixture's timeline parses as a valid Timeline with the drafted shape", () => {
    const built = build("app/fixtures/sample/src");
    const line = built.timelinesNdjson.trim();
    expect(line.split("\n")).toHaveLength(1);
    const { body } = JSON.parse(line) as { body: unknown };
    const parsed = parseTimeline(JSON.stringify(body));
    if (!("kind" in parsed) || parsed.kind !== "timeline") {
      throw new Error(`the sample's timeline did not parse: ${JSON.stringify(parsed)}`);
    }
    expect(parsed.tracks).toHaveLength(4);
    expect(parsed.branches).toHaveLength(1);
    expect(parsed.events).toHaveLength(17);
    expect(parsed.events.filter((e) => e.branch === null)).toHaveLength(14);
    expect(parsed.events.filter((e) => e.branch === "b1")).toHaveLength(3);
    expect(parsed.scale.calendar?.months).toHaveLength(10);
    const totalDays = parsed.scale.calendar?.months.reduce((sum, m) => sum + m.days, 0);
    expect(totalDays).toBe(360);
    // Every scene id an event carries is a real item, and every cast name a
    // track or event carries was resolved (never a bare `memberId` string
    // that is still a name): the seeder resolves names against cast.json,
    // this build only refuses unknown ones.
    for (const track of parsed.tracks) {
      if (track.kind === "cast") expect(typeof track.memberId).toBe("string");
    }
  });

  test.skipIf(!bin)("an empty bible directory is a fixture with no bible section", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      mkdirSync(join(src, "bible"), { recursive: true });
      writeSrc(src, { "manuscript.md": MANUSCRIPT });
      const built = build(src);
      const project = JSON.parse(built.projectJson) as { items: Array<{ type: string }> };
      expect(project.items.some((i) => i.type === "bible")).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("cast.json seeds cast.ndjson and appears becomes appearances.ndjson", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "cast.json": JSON.stringify([
          {
            kind: "character",
            name: "Ada",
            summary: "Keeper of the light.",
            fields: [{ label: "wants", value: "the truth" }],
            appears: ["Scene A"],
          },
          { kind: "place", name: "The Harbour", appears: ["Scene A", "Scene B"] },
        ]),
        "synopses.json": JSON.stringify({ "Scene A": "Ada finds something." }),
      });
      const built = build(src);
      const project = JSON.parse(built.projectJson) as {
        items: Array<{ id: string; type: string; title: string }>;
      };
      const sceneA = project.items.find((i) => i.title === "Scene A");
      const sceneB = project.items.find((i) => i.title === "Scene B");

      const cast = built.castNdjson
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as {
              kind: string;
              name: string;
              summary: string;
              fields: unknown[];
              aliases: string[];
            },
        );
      expect(cast).toEqual([
        {
          kind: "character",
          name: "Ada",
          summary: "Keeper of the light.",
          fields: [{ label: "wants", value: "the truth" }],
          aliases: [],
        },
        { kind: "place", name: "The Harbour", summary: "", fields: [], aliases: [] },
      ]);

      const synopses = built.synopsesNdjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { itemId: string; body: string });
      expect(sceneA?.id).toBeDefined();
      expect(synopses).toEqual([{ itemId: sceneA?.id as string, body: "Ada finds something." }]);

      const appearances = built.appearancesNdjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { itemId: string; members: string[] });
      const byItem = new Map(appearances.map((a) => [a.itemId, a.members]));
      expect(byItem.get(sceneA?.id ?? "")).toEqual(["Ada", "The Harbour"]);
      expect(byItem.get(sceneB?.id ?? "")).toEqual(["The Harbour"]);

      const manifest = JSON.parse(built.manifestJson) as { castCount: number };
      expect(manifest.castCount).toBe(2);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("cast.json's aliases pass through to cast.ndjson, absent means none", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "cast.json": JSON.stringify([
          { kind: "character", name: "Ada", aliases: ["Ada Quill", "Quill"] },
          { kind: "place", name: "The Harbour" },
        ]),
      });
      const built = build(src);
      const cast = built.castNdjson
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { name: string; aliases: string[] })
        .map((c) => ({ name: c.name, aliases: c.aliases }));
      expect(cast).toEqual([
        { name: "Ada", aliases: ["Ada Quill", "Quill"] },
        { name: "The Harbour", aliases: [] },
      ]);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("a synopsis naming a scene the manuscript does not have is refused", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "synopses.json": JSON.stringify({ "Scene Nope": "typo'd" }),
      });
      expect(() => build(src)).toThrow(/Scene Nope/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("an appears naming a scene the manuscript does not have is refused", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "cast.json": JSON.stringify([{ kind: "character", name: "Ada", appears: ["Scene Z"] }]),
      });
      expect(() => build(src)).toThrow(/Scene Z/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("cast.json naming an unknown kind is refused", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      writeSrc(src, {
        "manuscript.md": MANUSCRIPT,
        "cast.json": JSON.stringify([{ kind: "villain", name: "Nobody" }]),
      });
      expect(() => build(src)).toThrow(/villain/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("a manuscript missing entirely is refused rather than seeding an empty book", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    try {
      expect(() => build(src)).toThrow(/manuscript/);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

describe("diff", () => {
  test.skipIf(!bin)("reports no mismatch when the committed output matches", () => {
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    const out = mkdtempSync(join(tmpdir(), "sample-build-out-"));
    try {
      writeSrc(src, { "manuscript.md": MANUSCRIPT });
      const built = build(src);
      write(out, built);
      expect(diff(out, built)).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)("names every file that a src edit without a rebuild left stale", () => {
    // MUTATION TARGET 3: `--check` passing on a differing output. A `diff`
    // that always returned `[]` would pass this test's setup and fail only
    // here, which is what makes it a real check on the check.
    const src = mkdtempSync(join(tmpdir(), "sample-build-src-"));
    const out = mkdtempSync(join(tmpdir(), "sample-build-out-"));
    try {
      writeSrc(src, { "manuscript.md": MANUSCRIPT });
      const built = build(src);
      write(out, built);
      writeFileSync(join(out, "manifest.json"), "tampered");
      expect(diff(out, built)).toEqual(["manifest.json"]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test.skipIf(!bin)(
    "the committed sample fixture matches its own src (a src edit without a rebuild fails this)",
    () => {
      const srcDir = "app/fixtures/sample/src";
      const outDir = "app/fixtures/sample";
      const built = build(srcDir);
      expect(diff(outDir, built)).toEqual([]);
    },
  );
});
