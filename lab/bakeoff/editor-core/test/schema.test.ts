import { expect, test } from "bun:test";
import { bakeoffSchema, sceneToDoc } from "../src/schema";
import type { SceneDoc } from "../src/model";

test("schema exposes the semantic block/inline subset", () => {
  expect(bakeoffSchema.nodes.paragraph).toBeDefined();
  expect(bakeoffSchema.nodes.heading).toBeDefined();
  expect(bakeoffSchema.nodes.doc).toBeDefined();
  expect(bakeoffSchema.marks.strong).toBeDefined();
  expect(bakeoffSchema.marks.em).toBeDefined();
});

test("sceneToDoc builds one top-level node per block", () => {
  const scene: SceneDoc = {
    id: "it-000001",
    blocks: [
      { type: "heading", script: "latin", text: "Chapter One" },
      { type: "paragraph", script: "latin", text: "Hello world." },
      { type: "paragraph", script: "cjk", text: "你好世界" },
    ],
  };
  const doc = sceneToDoc(scene);
  expect(doc.childCount).toBe(3);
  expect(doc.child(0).type.name).toBe("heading");
  expect(doc.child(1).type.name).toBe("paragraph");
  expect(doc.child(1).textContent).toBe("Hello world.");
});

test("sceneToDoc tolerates an empty scene", () => {
  const doc = sceneToDoc({ id: "x", blocks: [] });
  // ProseMirror fills a required paragraph when content is empty.
  expect(doc.childCount).toBeGreaterThanOrEqual(1);
});
