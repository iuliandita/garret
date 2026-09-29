import { describe, expect, test } from "bun:test";
import {
  countWords,
  expectedHeadingLevel,
  normalizeText,
  readManuscript,
  stripInline,
} from "../src/markdown-read";

// The reader is the rig's INDEPENDENT restatement of the syntax the exporter
// emits. Every input below is written from the format as the design spec
// states it, never copied out of export.rs's implementation: a reader
// derived from the emitter's own logic
// would check the exporter against itself, and the fidelity gate would be
// theatre.

describe("expectedHeadingLevel", () => {
  // The rig's restatement of `min(depth + 2, 6)`. It is what export_structure's
  // level half is graded against, so it is tested here rather than left inside
  // export-cli.ts, which is a top-level script no test can import.
  test("a root item is H2 and each level of nesting is one more `#`", () => {
    // H1 is the project's title, so an item never gets one.
    expect(expectedHeadingLevel(0)).toBe(2);
    expect(expectedHeadingLevel(1)).toBe(3);
    expect(expectedHeadingLevel(2)).toBe(4);
    expect(expectedHeadingLevel(3)).toBe(5);
    expect(expectedHeadingLevel(4)).toBe(6);
  });

  // A recorded limit, not a defect: a manuscript nested five levels below its
  // root exports every deeper item at `######`. The items are all present and
  // in order; only the level collapses.
  test("depth beyond 4 clamps to 6 rather than running past it", () => {
    expect(expectedHeadingLevel(5)).toBe(6);
    expect(expectedHeadingLevel(50)).toBe(6);
  });
});

describe("stripInline", () => {
  test("unescapes every backslash escape back to the bare character", () => {
    // The exporter escapes \ * _ [ ] ` < ~ anywhere, and # - + > plus an
    // ordered-list marker at the start of a line. All of them come back.
    expect(stripInline(String.raw`a\*b\_c\[d\]e\`f\<g\~h`).text).toBe("a*b_c[d]e`f<g~h");
    expect(stripInline(String.raw`\# not a heading`).text).toBe("# not a heading");
    expect(stripInline(String.raw`1\. not a list`).text).toBe("1. not a list");
    // The backslash is escaped as itself, so a doubled one is one literal.
    expect(stripInline(String.raw`a\\b`).text).toBe("a\\b");
  });

  test("an escaped asterisk is literal text, not an emphasis delimiter", () => {
    // The whole reason the escape exists. A reader that stripped `*` before
    // honouring the backslash would drop a character the writer typed and the
    // fidelity gate would report the loss as the exporter's.
    const read = stripInline(String.raw`the \*asterisk\* stays`);
    expect(read.text).toBe("the *asterisk* stays");
    expect(read.emphasized).toEqual([]);
  });

  test("strips em, strong and both, and records what each delimited", () => {
    expect(stripInline("plain *italic* and **bold** and ***both***")).toEqual({
      text: "plain italic and bold and both",
      emphasized: ["italic", "bold", "both"],
    });
  });

  test("an emphasized run's own escapes are undone inside it", () => {
    const read = stripInline(String.raw`*a\*b*`);
    expect(read.text).toBe("a*b");
    expect(read.emphasized).toEqual(["a*b"]);
  });

  test("an unclosed delimiter still yields the text it opened", () => {
    // Two adjacent text nodes carrying the same mark emit `*a**b*`, whose
    // middle `**` is one run to any reader. The delimiters are ambiguous; the
    // TEXT is not, and the text is what the fidelity gate compares.
    expect(stripInline("*a**b*").text).toBe("ab");
  });
});

describe("readManuscript", () => {
  const doc = [
    "# My Novel",
    "",
    "## Part One",
    "",
    "### Chapter One",
    "",
    "#### Opening",
    "",
    "It began.",
    "",
    "And then it went on.",
    "",
  ].join("\n");

  test("takes the H1 as the project name and one section per item heading", () => {
    const read = readManuscript(doc);
    expect(read.title).toBe("My Novel");
    expect(read.sections.map((s) => s.title)).toEqual(["Part One", "Chapter One", "Opening"]);
    expect(read.sections.map((s) => s.level)).toEqual([2, 3, 4]);
  });

  test("joins a section's blocks with a single space", () => {
    // Which is document_text's own joining rule, so the result is directly
    // comparable to the text the store holds.
    expect(readManuscript(doc).sections[2]!.text).toBe("It began. And then it went on.");
    expect(readManuscript(doc).sections[2]!.blocks).toEqual([
      "It began.",
      "And then it went on.",
    ]);
  });

  test("an item with no prose contributes a heading and no text", () => {
    const read = readManuscript(doc);
    expect(read.sections[0]!.blocks).toEqual([]);
    expect(read.sections[0]!.text).toBe("");
  });

  test("a prose line that looks like a heading is not one", () => {
    // The exporter escapes a leading `#`, so the escape is the only thing that
    // separates a chapter from a sentence about one. A reader that ignored it
    // would count an extra heading and export_structure would FAIL on prose.
    const read = readManuscript(["# N", "", "## One", "", String.raw`\# not a heading`, ""].join("\n"));
    expect(read.sections).toHaveLength(1);
    expect(read.sections[0]!.text).toBe("# not a heading");
  });

  test("a heading with an empty title is still a heading", () => {
    // The exporter emits a bare `##` for an item titled "" -- the trailing
    // space would be markup nobody asked for.
    const read = readManuscript("# N\n\n##\n\n## Second\n");
    expect(read.sections.map((s) => s.title)).toEqual(["", "Second"]);
  });

  test("a title carrying markup is unescaped like prose", () => {
    const read = readManuscript(["# N", "", String.raw`## A \*starred\* title`, ""].join("\n"));
    expect(read.sections[0]!.title).toBe("A *starred* title");
  });

  test("collects every emphasized run in the section that carried it", () => {
    const read = readManuscript("# N\n\n## One\n\nshe *ran* home\n\n## Two\n\nhe **stood**\n");
    expect(read.sections[0]!.emphasized).toEqual(["ran"]);
    expect(read.sections[1]!.emphasized).toEqual(["stood"]);
  });

  test("a block holding an internal newline stays one block", () => {
    // A text node can carry a newline, and the line-start escapes bind at every
    // one of them. Only a BLANK line separates blocks.
    const read = readManuscript(["# N", "", "## One", "", String.raw`one` + "\n" + String.raw`\# two`, ""].join("\n"));
    expect(read.sections[0]!.blocks).toEqual(["one\n# two"]);
  });

  test("a multi-line chunk is never a heading, however it starts", () => {
    // The exporter cannot emit one -- a title's newlines become spaces, so a
    // heading is always one line -- and this pins the reader refusing to invent
    // a section from a malformed or foreign file. The regex carries no `s`
    // flag for exactly this reason; adding one makes this red.
    const read = readManuscript("# N\n\n## One\n\ntext\n\n## Two\nstray\n");
    expect(read.sections.map((s) => s.title)).toEqual(["One"]);
    expect(read.sections[0]!.blocks).toEqual(["text", "## Two\nstray"]);
  });

  test("prose before any item heading is counted, never silently dropped", () => {
    const read = readManuscript("# N\n\nstray\n\n## One\n\nreal\n");
    expect(read.orphanBlocks).toBe(1);
    expect(read.sections[0]!.text).toBe("real");
  });

  test("a file with no H1 reports a null title rather than inventing one", () => {
    expect(readManuscript("## One\n\ntext\n").title).toBeNull();
  });
});

describe("normalizeText", () => {
  test("collapses every whitespace run to one space and trims", () => {
    expect(normalizeText("  a \n\n b\tc  ")).toBe("a b c");
  });

  test("uses Unicode whitespace, not JavaScript's \\s", () => {
    // JS `\s` omits U+0085, which Rust's char::is_whitespace counts, and
    // includes U+FEFF, which it does not. The two word counts this run compares
    // would disagree on codepoints no case table would have contained.
    expect(normalizeText("a\u0085b")).toBe("a b");
    expect(normalizeText("a\uFEFFb")).toBe("a\uFEFFb");
  });
});

describe("countWords", () => {
  test("counts maximal runs of non-whitespace", () => {
    expect(countWords("one two  three")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("a\u0085b")).toBe(2);
  });
});

describe("the generated table of contents", () => {
  const withContents =
    "# Ash\n\n## Contents\n\n- Chapter One\n  - Opening\n\n## Chapter One\n\n### Opening\n\nIt began.\n";

  test("its entries come back on their own field, in file order", () => {
    expect(readManuscript(withContents).contents).toEqual(["Chapter One", "Opening"]);
  });

  test("it is NOT a section, so the heading and word counts still describe the walk", () => {
    // The two graded gates this protects: export_structure compares the heading
    // count with the walk's item count, and export_word_count_agrees counts the
    // prose. Left in, the contents would add one heading and a list's worth of
    // words to both.
    const out = readManuscript(withContents);
    expect(out.sections.map((s) => s.title)).toEqual(["Chapter One", "Opening"]);
    expect(out.orphanBlocks).toBe(0);
  });

  test("a file with no contents reports null, not an empty list", () => {
    // Absent and empty are different findings: a build that stopped emitting
    // the contents must be distinguishable from a book with nothing in it.
    expect(readManuscript("# Ash\n\n## Chapter One\n\nIt began.\n").contents).toBeNull();
  });

  test("a scene whose prose opens with a list keeps it, because it is not the first heading", () => {
    // Position is half the rule. Only the block directly under the H1 can be
    // the generated contents; anything further down is a writer's own prose,
    // and prose that looks like a list at all had to be written with escaped
    // markers the reader resolves before this ever runs.
    const out = readManuscript("# Ash\n\n## Chapter One\n\n- a\n- b\n");
    expect(out.contents).toBeNull();
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]?.blocks).toEqual(["- a\n- b"]);
  });

  test("a heading followed by prose is a heading followed by prose", () => {
    const out = readManuscript("# Ash\n\n## Chapter One\n\nIt began.\n\n## Two\n\nIt went on.\n");
    expect(out.contents).toBeNull();
    expect(out.sections).toHaveLength(2);
  });

  test("an entry for an empty title comes back as an empty string", () => {
    // The exporter trims the trailing space off `- `, so the line is a bare
    // `-`. A reader that required the space would drop the entry and the
    // counts would stop lining up.
    expect(readManuscript("# Ash\n\n## Contents\n\n-\n-\n\n##\n\n##\n").contents).toEqual(["", ""]);
  });

  test("an entry's escapes are resolved exactly as a heading's are", () => {
    const out = readManuscript(
      "# Ash\n\n## Contents\n\n- Salt \\*and\\* Ember\n\n## Salt \\*and\\* Ember\n\nprose\n",
    );
    expect(out.contents).toEqual(["Salt *and* Ember"]);
    expect(out.sections[0]?.title).toBe("Salt *and* Ember");
  });
});
