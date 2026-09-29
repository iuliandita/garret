import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readBootSceneText, waitForExactBootSceneText } from "../src/prefs-input";

const expected = "The tide left two spaces.  ";

function body(text: string): string {
  return JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
}

function withStore(rows: { id: string; parentId: string | null; type: string; position: string; body?: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "prefs-input-"));
  const path = join(root, "project.db");
  const db = new Database(path);
  db.run("CREATE TABLE item (id TEXT PRIMARY KEY, parent_id TEXT, type TEXT NOT NULL, position TEXT NOT NULL)");
  db.run("CREATE UNIQUE INDEX item_sibling ON item(parent_id, position)");
  db.run("CREATE UNIQUE INDEX item_root_sibling ON item(position) WHERE parent_id IS NULL");
  db.run("CREATE TABLE doc (item_id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  for (const row of rows) {
    db.run("INSERT INTO item (id, parent_id, type, position) VALUES (?1, ?2, ?3, ?4)", [
      row.id,
      row.parentId,
      row.type,
      row.position,
    ]);
    if (row.body !== undefined) db.run("INSERT INTO doc (item_id, body) VALUES (?1, ?2)", [row.id, row.body]);
  }
  db.close();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("reads the complete boot-scene text, including trailing spaces", () => {
  const store = withStore([
    { id: "chapter", parentId: null, type: "chapter", position: "001" },
    { id: "opening", parentId: "chapter", type: "scene", position: "001", body: body(expected) },
  ]);
  try {
    expect(readBootSceneText(store.path)).toEqual({ sceneId: "opening", text: expected });
  } finally {
    store.cleanup();
  }
});

test("refuses missing, truncated, malformed, and wrong-scene input", async () => {
  const cases = [
    { name: "missing", opening: undefined, second: body(expected) },
    { name: "truncated", opening: body(expected.slice(0, -1)), second: body(expected) },
    { name: "malformed", opening: "{", second: body(expected) },
    { name: "wrong scene", opening: body("other scene"), second: body(expected) },
  ];
  for (const sample of cases) {
    const store = withStore([
      { id: "chapter", parentId: null, type: "chapter", position: "001" },
      { id: "opening", parentId: "chapter", type: "scene", position: "001", body: sample.opening },
      { id: "later", parentId: "chapter", type: "scene", position: "002", body: sample.second },
    ]);
    try {
      await expect(waitForExactBootSceneText(store.path, expected, { timeoutMs: 0, pollMs: 1 })).rejects.toThrow(
        "typed passage did not commit to the boot scene",
      );
    } finally {
      store.cleanup();
    }
  }
});


test("selects the depth-first scene despite root, insertion, and id order", async () => {
  const store = withStore([
    { id: "a-later-root", parentId: null, type: "scene", position: "002", body: body("later") },
    { id: "z-opening", parentId: "chapter", type: "scene", position: "001", body: body(expected) },
    { id: "chapter", parentId: null, type: "chapter", position: "001" },
  ]);
  try {
    expect(readBootSceneText(store.path)).toEqual({ sceneId: "z-opening", text: expected });
    const evidence = await waitForExactBootSceneText(store.path, expected, { timeoutMs: 0, pollMs: 1 });
    expect(evidence.scene_id).toBe("z-opening");
    expect(evidence.actual_bytes).toBe(Buffer.byteLength(expected));
  } finally {
    store.cleanup();
  }
});

test("refuses identical characters in a different paragraph or formatting shape", async () => {
  const text = { type: "text", text: expected };
  const paragraph = { type: "paragraph", content: [text] };
  const contents = [
    [paragraph, { type: "paragraph" }],
    [
      { type: "paragraph", content: [{ type: "text", text: expected.slice(0, 4) }] },
      { type: "paragraph", content: [{ type: "text", text: expected.slice(4) }] },
    ],
    [{ type: "paragraph", content: [text, { type: "hard_break" }] }],
    [{ type: "paragraph", content: [{ ...text, marks: [{ type: "strong" }] }] }],
  ];
  for (const content of contents) {
    const store = withStore([
      { id: "opening", parentId: null, type: "scene", position: "001", body: JSON.stringify({ type: "doc", content }) },
    ]);
    try {
      await expect(waitForExactBootSceneText(store.path, expected, { timeoutMs: 0, pollMs: 1 }))
        .rejects.toThrow("typed passage did not commit to the boot scene");
    } finally {
      store.cleanup();
    }
  }
});
