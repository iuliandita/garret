// lab/fixtures/gen/src/cli.ts
import { generateFixture } from "./generate";
import type { FixtureSpec } from "./model";

const PRESETS: Record<string, FixtureSpec> = {
  tiny: {
    name: "tiny", seed: "tiny-v1",
    totalWords: 2_000, structuralItems: 40, records: 20,
    assetBytes: 128 * 1024, assetCount: 3,
  },
  normal: {
    name: "normal", seed: "normal-v1",
    totalWords: 200_000, structuralItems: 2_000, records: 1_000,
    assetBytes: 2 * 1024 ** 3, assetCount: 200,
  },
  stress: {
    name: "stress", seed: "stress-v1",
    totalWords: 2_000_000, structuralItems: 20_000, records: 10_000,
    assetBytes: 20 * 1024 ** 3, assetCount: 800,
  },
};

const args = process.argv.slice(2);
// Opt-in, never a preset default: tiny/normal already exist as real bytes and
// must keep regenerating identically.
const sparseAssets = args.includes("--sparse-assets");
const positional = args.filter((a) => !a.startsWith("--"));
const preset = positional[0];
const outRoot = positional[1] ?? "fixtures/out";
const base = preset ? PRESETS[preset] : undefined;
if (!base) {
  console.error(
    `usage: bun fixtures/gen/src/cli.ts <${Object.keys(PRESETS).join("|")}> ` +
    `[outRoot] [--sparse-assets]`,
  );
  process.exit(2);
}
const spec: FixtureSpec = { ...base, sparseAssets };
const started = performance.now();
const manifest = await generateFixture(spec, outRoot);
console.log(JSON.stringify(
  { ...manifest, elapsedMs: Math.round(performance.now() - started) },
  null,
  2,
));
