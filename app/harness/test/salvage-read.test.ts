// app/harness/test/salvage-read.test.ts
// The harness's restatement of salvage's output shapes, tested against the
// samples QUOTED IN THE DECISION RECORDS -- 046 "What a writer sees", 048
// Decision 3, 049 Decision 4 and 050 Decision 2 -- and never against output
// taken from a run of the binary. A reader checked against the emitter's own
// bytes agrees with the emitter about anything, including a defect.
import { describe, expect, test } from "bun:test";
import {
  idOf,
  manifestsOwed,
  namedPathsIn,
  parseDocument,
  readCast,
  readComments,
  readCovers,
  readSnapshots,
  readSynopses,
  readWordlist,
  trimBlank,
} from "../src/salvage-read";

describe("parseDocument", () => {
  test("the first H1 is the title and every later heading is a block", () => {
    // A SECOND `#` LINE IS THE POINT of this fixture: a reader that takes the
    // LAST H1 as the title, or that lets a later one overwrite the first, is a
    // different implementation and this is the input that tells them apart.
    const doc = parseDocument("# book - synopses\n\n## One\n\nbody\n\n# not a title\n\n## Two\n");
    expect(doc.title).toBe("book - synopses");
    expect(doc.blocks.map((b) => `${b.level}:${b.heading}`)).toEqual([
      "2:One",
      "1:not a title",
      "2:Two",
    ]);
  });

  test("a SECOND H1 at the very top does not replace the first", () => {
    // Kills the mutation that drops `title === null`: with nothing parsed yet,
    // `blocks.length === 0` is still true and the second line takes the title.
    // A synopsis body whose first line begins `# ` reaches this.
    const doc = parseDocument("# book - synopses\n# stolen\n\n## One\n");
    expect(doc.title).toBe("book - synopses");
    expect(doc.blocks.map((b) => b.heading)).toEqual(["stolen", "One"]);
  });

  test("an H1 that is not the file's first heading is a block, not the title", () => {
    // Kills the mutation that drops `blocks.length === 0`: the title is still
    // null here, so without that clause the later H1 becomes the file's title.
    const doc = parseDocument("## One\n\nbody\n\n# late\n");
    expect(doc.title).toBeNull();
    expect(doc.blocks.map((b) => b.heading)).toEqual(["One", "late"]);
  });

  test("a file with no heading at all has no title and no blocks", () => {
    const doc = parseDocument("just some prose\nand more\n");
    expect(doc.title).toBeNull();
    expect(doc.blocks).toEqual([]);
  });

  test("lines belong to the nearest heading above them, whatever its level", () => {
    const doc = parseDocument("# t\n\n## A\n\nalpha\n\n### B\n\nbeta\n\n## C\n\ngamma\n");
    expect(doc.blocks.map((b) => trimBlank(b.lines))).toEqual([["alpha"], ["beta"], ["gamma"]]);
  });
});

describe("trimBlank", () => {
  test("strips blank lines from BOTH ends and keeps the ones between", () => {
    // Blank at both ends AND in the middle: a mutant that trims one end only,
    // or that drops every blank line, disagrees with this and only this.
    expect(trimBlank(["", "  ", "a", "", "b", "   ", ""])).toEqual(["a", "", "b"]);
  });

  test("an all-blank block trims to nothing", () => {
    expect(trimBlank(["", "   ", ""])).toEqual([]);
  });
});

describe("idOf", () => {
  test("reads the backticked line immediately under the heading", () => {
    const [block] = parseDocument("# t\n\n## Part One\n\n`01a0465f-7d1e6c9dd749`\n\nthe first part\n")
      .blocks;
    expect(idOf(block!)).toBe("01a0465f-7d1e6c9dd749");
  });

  test("a backticked line LATER in the block is not an identity", () => {
    // THE LOAD-BEARING FIXTURE, and it was WRONG on its first writing: it read
    // "rewrite the `chapter`", where the backticks are not alone on the line, so
    // ID_LINE never matched them and a reader that scanned the whole block
    // returned null too. The assertion was a fact about the author's own
    // formatting rather than about the rule -- the recorded shape, in its fifth
    // costume, and only the mutation found it.
    //
    // The block below carries NO id line and a lone backticked token further
    // down, which is what a writer gets by putting a `word` on a line of their
    // own. An id-line read returns null; a whole-block scan returns "chapter".
    const [block] = parseDocument("# t\n\n## Second\n\nrewrite it\n\n`chapter`\n").blocks;
    expect(idOf(block!)).toBeNull();
  });

  test("an empty block has no id", () => {
    const [block] = parseDocument("# t\n\n## Empty\n").blocks;
    expect(idOf(block!)).toBeNull();
  });
});

describe("readSynopses", () => {
  // 046, "What a writer sees", verbatim.
  const SAMPLE = [
    "# The Harbour - synopses",
    "",
    "## Part One",
    "",
    "`01a0465f-7d1e6c9dd749`",
    "",
    "the whole first part",
    "",
    "## 01a0465f-7d388ce427fa",
    "",
    "`01a0465f-7d388ce427fa`",
    "",
    "he leaves before dawn",
    "",
  ].join("\n");

  test("each summary carries its heading, its id and its body", () => {
    expect(readSynopses(SAMPLE)).toEqual([
      { heading: "Part One", id: "01a0465f-7d1e6c9dd749", body: "the whole first part" },
      {
        heading: "01a0465f-7d388ce427fa",
        id: "01a0465f-7d388ce427fa",
        body: "he leaves before dawn",
      },
    ]);
  });

  test("a backticked line in the BODY is not eaten as a second id", () => {
    // Kills both mutations of the id-consumed latch in `paragraphs`. The id line
    // is consumed once; a later lone backticked token is the writer's own text
    // and must survive into the body.
    const [entry] = readSynopses("# t - synopses\n\n## One\n\n`i1`\n\n`the-cut`\n\nafter it\n");
    expect(entry!.id).toBe("i1");
    expect(entry!.body).toBe("`the-cut`\nafter it");
  });

  test("only H2 blocks are summaries", () => {
    // A `### ` line typed into a summary opens a block of its own. Read at
    // level >= 2 it becomes a second summary with an id of null, which is a
    // recovery this reader would report as holding one more row than it does.
    const entries = readSynopses(
      "# t - synopses\n\n## One\n\n`i1`\n\nthe summary\n\n### a line the writer typed\n",
    );
    expect(entries.map((e) => e.heading)).toEqual(["One"]);
    expect(entries[0]!.body).toBe("the summary");
  });

  test("a summary of several paragraphs keeps all of them", () => {
    const [entry] = readSynopses("# t - synopses\n\n## One\n\n`i1`\n\nfirst\n\nsecond\n");
    expect(entry!.body).toBe("first\nsecond");
  });
});

describe("readCast", () => {
  // 046's cast sample with 048's Decision 3 appearance section folded in, which
  // is how the two records together specify this file.
  const SAMPLE = [
    "# The Harbour - cast",
    "",
    "## Characters",
    "",
    "### Ada",
    "",
    "`01a0465f-7d4b2cfca4e9`",
    "",
    "the harbourmaster",
    "",
    "- **Eyes**: grey",
    "- **Wound**: the fire",
    "",
    "pictures/ada.png",
    "",
    "Appears in:",
    "",
    "- Part One `01a0465f-7d1e6c9dd749`",
    "- `01a0465f-7d2b1a05c118`",
    "",
    "## weather",
    "",
    "### the gale",
    "",
    "`01a0465f-7d900000000f`",
    "",
    "## Details whose cast member is gone",
    "",
    "### ghost",
    "",
    "- **Eyes**: green",
    "",
  ].join("\n");

  test("a member carries its group, id, summary, details, picture and tags", () => {
    const [ada] = readCast(SAMPLE);
    expect(ada).toEqual({
      group: "Characters",
      name: "Ada",
      id: "01a0465f-7d4b2cfca4e9",
      summary: "the harbourmaster",
      details: [
        { label: "Eyes", value: "grey" },
        { label: "Wound", value: "the fire" },
      ],
      picture: "pictures/ada.png",
      appearsIn: [
        { title: "Part One", id: "01a0465f-7d1e6c9dd749" },
        { title: null, id: "01a0465f-7d2b1a05c118" },
      ],
    });
  });

  test("a group this build does not know keeps its own members", () => {
    // 046: "A kind this build does not know keeps its own group". A reader that
    // recognised only the three known groups would drop this member entirely.
    const gale = readCast(SAMPLE).find((m) => m.name === "the gale");
    expect(gale?.group).toBe("weather");
    expect(gale?.details).toEqual([]);
    expect(gale?.picture).toBeNull();
  });

  test("an orphaned detail section is read like any other member", () => {
    const ghost = readCast(SAMPLE).find((m) => m.name === "ghost");
    expect(ghost?.group).toBe("Details whose cast member is gone");
    expect(ghost?.id).toBeNull();
    expect(ghost?.details).toEqual([{ label: "Eyes", value: "green" }]);
  });

  test("neither the detail bullets nor the tag list leak into the summary", () => {
    // Without the claim predicate the summary reads "the harbourmaster",
    // "- **Eyes**: grey", ... and every summary comparison downstream is about
    // this reader rather than about the recovery.
    expect(readCast(SAMPLE)[0]!.summary).toBe("the harbourmaster");
  });
});

describe("readComments", () => {
  // 049, Decision 4, verbatim.
  const SAMPLE = [
    "# The Harbour - comments",
    "",
    "## Second",
    "",
    "`01a049af-b0e04639ec84`",
    "",
    "### 4-11 (resolved)",
    "",
    "> three more",
    "",
    "the second scene",
    "",
    "## Opening",
    "",
    "`01a049af-b0da921d7ad1`",
    "",
    "### 4-4 (orphaned)",
    "",
    "> the harbour",
    "",
    "at the top",
    "",
    "### 20-25",
    "",
    "> more words",
    "",
    "later in the scene",
    "",
  ].join("\n");

  test("every note carries its document, its range, its flags, its quote and its body", () => {
    expect(readComments(SAMPLE)).toEqual([
      {
        document: "Second",
        documentId: "01a049af-b0e04639ec84",
        from: 4,
        to: 11,
        flags: ["resolved"],
        quote: "three more",
        body: "the second scene",
      },
      {
        document: "Opening",
        documentId: "01a049af-b0da921d7ad1",
        from: 4,
        to: 4,
        flags: ["orphaned"],
        quote: "the harbour",
        body: "at the top",
      },
      {
        document: "Opening",
        documentId: "01a049af-b0da921d7ad1",
        from: 20,
        to: 25,
        flags: [],
        quote: "more words",
        body: "later in the scene",
      },
    ]);
  });

  test("a note under the SECOND document does not keep the first document's id", () => {
    // The two documents carry DIFFERENT ids on purpose: a reader that never
    // updates the current document, or that reads the id once, still passes a
    // sample whose two documents happen to agree.
    const ids = new Set(readComments(SAMPLE).map((n) => n.documentId));
    expect(ids).toEqual(new Set(["01a049af-b0e04639ec84", "01a049af-b0da921d7ad1"]));
  });

  test("a note may be both resolved and orphaned", () => {
    const [note] = readComments("# t - comments\n\n## A\n\n`i1`\n\n### 9-9 (orphaned) (resolved)\n\n> q\n\nb\n");
    expect(note!.flags).toEqual(["orphaned", "resolved"]);
  });
});

describe("readWordlist", () => {
  test("returns the words in the order the FILE lists them", () => {
    // DELIBERATELY OUT OF ORDER. `salvage_wordlist_recovered` grades that the
    // recovery is alphabetical, so a reader that sorted would make that gate
    // compare a sorted list against a sorted list and pass for any emitter.
    expect(readWordlist("# t - wordlist\n\n- Zelenko\n- alderman\n- Ravensmoot\n")).toEqual([
      "Zelenko",
      "alderman",
      "Ravensmoot",
    ]);
  });

  test("the title line is not a word", () => {
    expect(readWordlist("# t - wordlist\n")).toEqual([]);
  });
});

describe("readCovers", () => {
  test("each side names the file that was copied", () => {
    expect(
      readCovers(
        "# t - covers\n\n## Front cover\n\npictures/front.png\n\n## Back cover\n\npictures/back.png\n",
      ),
    ).toEqual({ front: "pictures/front.png", back: "pictures/back.png" });
  });

  test("a side with no section stays null", () => {
    // The FRONT is the one present here: a reader that assigned by position
    // rather than by heading would report this as a back cover.
    expect(readCovers("# t - covers\n\n## Front cover\n\npictures/only.png\n")).toEqual({
      front: "pictures/only.png",
      back: null,
    });
  });
});

describe("readSnapshots", () => {
  // 050, Decision 2, verbatim, with the "bytes not stored" line that record's
  // Decision 3 table specifies.
  const SAMPLE = [
    "# The Harbour - snapshots",
    "",
    "## after the cut",
    "",
    "`2`",
    "",
    "created 30",
    "",
    "- Second `01a04a03-925d1e653935` snapshots/2/01a04a03-925d1e653935.md",
    "- `01a04a03-924d4d9084eb` bytes not stored",
    "",
  ].join("\n");

  test("a snapshot carries its label, number, creation time and every document line", () => {
    expect(readSnapshots(SAMPLE)).toEqual([
      {
        label: "after the cut",
        id: "2",
        created: 30,
        documents: [
          {
            title: "Second",
            itemId: "01a04a03-925d1e653935",
            path: "snapshots/2/01a04a03-925d1e653935.md",
          },
          { title: null, itemId: "01a04a03-924d4d9084eb", path: null },
        ],
      },
    ]);
  });

  test("`created` is the number verbatim and is never turned into a date", () => {
    // 050: "created is milliseconds since the epoch, verbatim. Rendering a date
    // needs a timezone this command was never given."
    const [snap] = readSnapshots("# t - snapshots\n\n## m\n\n`1`\n\ncreated 1756598400000\n");
    expect(snap!.created).toBe(1756598400000);
  });
});

describe("namedPathsIn", () => {
  /** THE PRE-054 MANIFEST, in the shape the write-back quotes: two absolute
   *  paths at the top, and a `meta` sweep carrying a third out of the project
   *  file itself. A fixture that genuinely contains what the gate forbids is
   *  the only thing that proves the gate can fail. */
  const LEAKING = JSON.stringify({
    source: "/home/writer/books/harbour.db",
    source_bytes: 16384,
    sidecars: ["wal"],
    out_dir: "/home/writer/recovered",
    name: "The Harbour",
    manuscript: "manuscript.md",
    renamed: { "01a0": "01a0.raw" },
    meta: {
      project_name: "The Harbour",
      recovered_from: "/home/writer/.local/share/cc.local.app/recovery/harbour/2026-08-21T09-00-00Z.db",
    },
    losses: [{ kind: "missing_picture", detail: "cast member m1 names the picture ada.png", item_id: null }],
    complete: true,
  });

  const CLEAN = JSON.stringify({
    source: "harbour.db",
    source_bytes: 16384,
    sidecars: ["wal"],
    out_dir: "recovered",
    name: "The Harbour",
    manuscript: "manuscript.md",
    renamed: { "01a0": "01a0.raw" },
    meta: {
      project_name: "The Harbour",
      recovered_from: "2026-08-21T09-00-00Z.db",
    },
    losses: [{ kind: "missing_picture", detail: "cast member m1 names the picture ada.png", item_id: null }],
    complete: true,
  });

  test("every absolute path is found, wherever in the shape it sits", () => {
    expect(namedPathsIn(LEAKING, "/home/writer")).toEqual([
      { at: "source", value: "/home/writer/books/harbour.db" },
      { at: "out_dir", value: "/home/writer/recovered" },
      {
        at: "meta.recovered_from",
        value: "/home/writer/.local/share/cc.local.app/recovery/harbour/2026-08-21T09-00-00Z.db",
      },
    ]);
  });

  test("the manifest this build writes names none", () => {
    expect(namedPathsIn(CLEAN, "/home/writer")).toEqual([]);
  });

  test("a value naming the run's own directory without a leading slash is still found", () => {
    // The second clause. A value made relative to SOMETHING is not thereby
    // free of the machine it was recovered on.
    const relative = JSON.stringify({ out_dir: "writer/recovered" });
    expect(namedPathsIn(relative, "writer")).toEqual([
      { at: "out_dir", value: "writer/recovered" },
    ]);
  });

  test("a holding directory of one character or less matches nothing on its own", () => {
    // `/` as a holding directory would make the second clause match every
    // string carrying a slash, including every recovered filename, and the
    // gate would be red on a correct manifest forever.
    expect(namedPathsIn(JSON.stringify({ manuscript: "manuscript.md", a: "x/y" }), "/")).toEqual([]);
  });

  test("an array element is reported with its index", () => {
    expect(namedPathsIn(JSON.stringify({ raw_bodies: ["a.raw", "/tmp/b.raw"] }), "")).toEqual([
      { at: "raw_bodies[1]", value: "/tmp/b.raw" },
    ]);
  });
});

describe("manifestsOwed", () => {
  test("the two salvages, plus one per corpus entry that answered", () => {
    expect(
      manifestsOwed([
        { complete: null },
        { complete: false },
        { complete: true },
        { complete: null },
      ]),
    ).toBe(4);
  });

  test("a corpus of refusals owes only the two salvages", () => {
    expect(manifestsOwed([{ complete: null }, { complete: null }])).toBe(2);
  });

  test("an empty corpus still owes the two salvages", () => {
    // The healthy and the damaged run are not conditional on anything: the rig
    // aborts before this point if either wrote no manifest.
    expect(manifestsOwed([])).toBe(2);
  });
});
