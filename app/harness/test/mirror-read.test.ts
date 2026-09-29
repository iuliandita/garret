import { describe, expect, test } from "bun:test";
import { readDocumentFile } from "../src/mirror-read";

/** What `mirror::file_body` writes, spelled out here rather than generated.
 *
 *  A FIXTURE, NOT A CALL. If this reader took its input from the host it would
 *  agree with the host about anything, which is the one thing an oracle must
 *  not do. */
const FILE = ["---", "id: it-000600", "type: scene", "---", "", "# Letter Storm", "", "four words go here", ""].join("\n");

describe("readDocumentFile", () => {
  test("reads the front matter, the heading and the prose", () => {
    const doc = readDocumentFile(FILE);
    expect(doc.problem).toBeNull();
    expect(doc.id).toBe("it-000600");
    expect(doc.itemType).toBe("scene");
    expect(doc.title).toBe("Letter Storm");
    expect(doc.text).toBe("four words go here");
  });

  test("the fence and the heading never reach the prose", () => {
    const doc = readDocumentFile(FILE);
    expect(doc.text).not.toContain("---");
    expect(doc.text).not.toContain("id:");
    expect(doc.text).not.toContain("Letter Storm");
  });

  test("paragraphs are joined by ONE space, as the store's text is", () => {
    // The joining rule matters as much as the reading one: a reader that joined
    // with a newline would disagree with every word count in this application.
    const doc = readDocumentFile(
      ["---", "id: a", "type: scene", "---", "", "# T", "", "first", "", "second", ""].join("\n"),
    );
    expect(doc.blocks).toEqual(["first", "second"]);
    expect(doc.text).toBe("first second");
  });

  test("a wrapped paragraph is one block", () => {
    const doc = readDocumentFile(
      ["---", "id: a", "type: scene", "---", "", "# T", "", "one", "two", ""].join("\n"),
    );
    expect(doc.blocks).toEqual(["one two"]);
  });

  test("escapes are undone and emphasis delimiters are removed", () => {
    // Shares `stripInline` with the export oracle, because the inline syntax
    // genuinely is one format. Restating it would be a second definition of
    // emphasis and escaping.
    const doc = readDocumentFile(
      ["---", "id: a", "type: scene", "---", "", "# T", "", "a *starred* word and a \\# hash", ""].join("\n"),
    );
    expect(doc.text).toBe("a starred word and a # hash");
  });

  test("a key this format does not write is reported", () => {
    const doc = readDocumentFile(
      ["---", "id: a", "type: scene", "author: someone", "---", "", "# T", ""].join("\n"),
    );
    expect(doc.extra).toEqual(["author"]);
  });

  test("an untitled document reads back as an empty title, not as a problem", () => {
    const doc = readDocumentFile(["---", "id: a", "type: scene", "---", "", "#", ""].join("\n"));
    expect(doc.problem).toBeNull();
    expect(doc.title).toBe("");
  });

  test("a later heading is prose, not a second title", () => {
    const doc = readDocumentFile(
      ["---", "id: a", "type: scene", "---", "", "# Real", "", "prose", "", "# Later", ""].join("\n"),
    );
    expect(doc.title).toBe("Real");
    expect(doc.text).toBe("prose # Later");
  });

  test("a file with no fence is a PROBLEM and not an empty document", () => {
    // An empty document is what a scene the writer emptied looks like. A reader
    // that could not tell those apart would pass a mirror of blank files.
    const doc = readDocumentFile("# Just a heading\n\nprose\n");
    expect(doc.problem).toBe("no front-matter fence");
    expect(doc.text).toBe("");
  });

  test("an unclosed fence is a problem", () => {
    expect(readDocumentFile("---\nid: a\ntype: scene\n\n# T\n").problem).toBe(
      "the front matter is never closed",
    );
  });

  test("no top-level heading is a problem", () => {
    expect(readDocumentFile("---\nid: a\ntype: scene\n---\n\nprose\n").problem).toBe(
      "no top-level heading",
    );
    expect(readDocumentFile("---\nid: a\ntype: scene\n---\n\n## T\n").problem).toBe(
      "no top-level heading",
    );
  });

  test("a file with no prose is a whole document", () => {
    const doc = readDocumentFile(["---", "id: a", "type: part", "---", "", "# Winter Cafe", ""].join("\n"));
    expect(doc.problem).toBeNull();
    expect(doc.itemType).toBe("part");
    expect(doc.blocks).toEqual([]);
    expect(doc.text).toBe("");
  });
});
