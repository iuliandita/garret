// lab/fixtures/gen/src/generate.ts
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePrng } from "./prng";
import { buildStructure } from "./structure";
import { buildRecords } from "./records";
import { writeAssets } from "./assets";
import { paragraph, type Script } from "./words";
import type { FixtureSpec, Scene, Block } from "./model";

export const GENERATOR_VERSION = "1";

export interface Manifest {
  name: string;
  seed: string;
  generatorVersion: string;
  totalWords: number;
  itemCount: number;
  recordCount: number;
  assetCount: number;
  assetBytes: number;
  // True when `assetBytes` is apparent size only (sparse). Recorded so a reader
  // of the fixture cannot mistake it for real occupied disk.
  sparseAssets: boolean;
}

// ~10% of scenes are mixed-script (cjk or rtl) for editor/search realism.
function sceneScript(rngValue: number): Script {
  if (rngValue < 0.05) return "cjk";
  if (rngValue < 0.1) return "rtl";
  return "latin";
}

export async function generateFixture(
  spec: FixtureSpec,
  outRoot: string,
): Promise<Manifest> {
  const dir = join(outRoot, spec.name);
  mkdirSync(dir, { recursive: true });
  const rng = makePrng(spec.seed);

  const items = buildStructure(rng, spec.structuralItems, spec.totalWords);
  const records = buildRecords(rng, spec.records, items);

  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify(
      {
        meta: {
          name: spec.name,
          seed: spec.seed,
          generatorVersion: GENERATOR_VERSION,
          penName: "Synthetic Author",
        },
        items,
      },
      null,
      2,
    ),
  );

  const scenesOut = createWriteStream(join(dir, "scenes.ndjson"));
  // Surface mid-stream write errors instead of hanging a later `drain` await.
  let scenesErr: Error | null = null;
  const scenesErrored = new Promise<never>((_, reject) => {
    scenesOut.once("error", (err: Error) => {
      scenesErr = err;
      reject(err);
    });
  });
  scenesErrored.catch(() => {}); // consumed via scenesErr / race below
  for (const item of items) {
    if (item.type !== "scene") continue;
    if (scenesErr) throw scenesErr;
    const script = sceneScript(rng.next());
    const blocks: Block[] = [];
    let remaining = item.sceneWordTarget ?? 0;
    while (remaining > 0) {
      const n = Math.min(remaining, 40 + rng.int(120));
      blocks.push({ type: "paragraph", script, text: paragraph(rng, script, n) });
      remaining -= n;
    }
    const scene: Scene = { id: item.id, blocks };
    if (!scenesOut.write(JSON.stringify(scene) + "\n")) {
      await Promise.race([
        new Promise<void>((r) => scenesOut.once("drain", r)),
        scenesErrored,
      ]);
    }
  }
  await new Promise<void>((resolve, reject) => {
    if (scenesErr) return reject(scenesErr);
    scenesOut.end(() => resolve());
    scenesOut.once("error", reject);
  });

  const recordsNdjson = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(dir, "records.ndjson"), recordsNdjson);

  const assetNames = await writeAssets(
    rng, join(dir, "assets"), spec.assetCount, spec.assetBytes,
    spec.sparseAssets ?? false,
  );

  const manifest: Manifest = {
    name: spec.name,
    seed: spec.seed,
    generatorVersion: GENERATOR_VERSION,
    totalWords: spec.totalWords,
    itemCount: items.length,
    recordCount: records.length,
    assetCount: assetNames.length,
    assetBytes: spec.assetBytes,
    sparseAssets: spec.sparseAssets ?? false,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
