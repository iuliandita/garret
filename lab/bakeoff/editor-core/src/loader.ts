// lab/bakeoff/editor-core/src/loader.ts
// Node-only fixture reader. NOT bundled into the page; the page fetches the
// materialized scene-data.json produced here.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FixtureData, SceneDoc, SceneRef } from "./model";

interface ProjectItem {
  id: string;
  type: "part" | "chapter" | "scene" | "doc";
  title: string;
  parentId: string | null;
  order: number;
}

export function loadSceneRefs(fixtureDir: string): SceneRef[] {
  const project = JSON.parse(
    readFileSync(join(fixtureDir, "project.json"), "utf8"),
  ) as { items: ProjectItem[] };
  return project.items
    .filter((it) => it.type === "scene")
    .map((it) => ({
      id: it.id,
      title: it.title,
      order: it.order,
      parentId: it.parentId,
    }))
    .sort((a, b) => a.order - b.order);
}

export function loadSceneDocs(fixtureDir: string): Map<string, SceneDoc> {
  const raw = readFileSync(join(fixtureDir, "scenes.ndjson"), "utf8");
  const docs = new Map<string, SceneDoc>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as SceneDoc;
    docs.set(doc.id, doc);
  }
  return docs;
}

// Materialize a single fetchable JSON. `limit` caps scenes for the fast path;
// omit (or 0) to include all scenes.
export function materializeFixture(
  fixtureDir: string,
  outFile: string,
  fixtureName: string,
  limit = 0,
  lazy = false,
): FixtureData {
  let refs = loadSceneRefs(fixtureDir);
  if (limit > 0) refs = refs.slice(0, limit);
  const allDocs = loadSceneDocs(fixtureDir);
  const docs: SceneDoc[] = refs.map(
    (r) => allDocs.get(r.id) ?? { id: r.id, blocks: [] },
  );
  mkdirSync(dirname(outFile), { recursive: true });

  // lazy-docs variant: one file per scene beside the manifest, so the page can
  // hold only its mounted window. The eager path is left byte-identical.
  if (lazy) {
    const docsDir = join(dirname(outFile), "docs");
    mkdirSync(docsDir, { recursive: true });
    docs.forEach((doc, i) => {
      writeFileSync(join(docsDir, `${i}.json`), JSON.stringify(doc));
    });
    const manifest: FixtureData = { fixture: fixtureName, refs, docs: [], lazy: true };
    writeFileSync(outFile, JSON.stringify(manifest));
    return manifest;
  }

  const data: FixtureData = { fixture: fixtureName, refs, docs };
  writeFileSync(outFile, JSON.stringify(data));
  return data;
}

// CLI: bun editor-core/src/loader.ts <fixtureDir> <outFile> <name> [limit]
if (import.meta.main) {
  const [fixtureDir, outFile, name, limitArg] = process.argv.slice(2);
  if (!fixtureDir || !outFile || !name) {
    console.error(
      "usage: bun editor-core/src/loader.ts <fixtureDir> <outFile> <name> [limit]",
    );
    process.exit(2);
  }
  const data = materializeFixture(
    fixtureDir,
    outFile,
    name,
    limitArg ? Number(limitArg) : 0,
  );
  console.log(
    JSON.stringify({ fixture: data.fixture, scenes: data.refs.length }),
  );
}
