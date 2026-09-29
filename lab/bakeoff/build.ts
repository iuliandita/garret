// lab/bakeoff/build.ts
// Bundle the page entry to dist/run.js and stage index.html next to it. The
// materialized scene-data.json is produced separately by the matrix per run.
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// Soak duration is baked into the bundle rather than injected by each shell:
// the page is the one thing both shells load byte-identically, so a build-time
// constant keeps the soak from becoming a per-shell code path.
const soakMs = Number(process.env.BAKEOFF_SOAK_MS ?? "0");
if (!Number.isFinite(soakMs) || soakMs < 0) {
  throw new Error(`BAKEOFF_SOAK_MS must be a non-negative number, got ${soakMs}`);
}

const out = await Bun.build({
  entrypoints: [join(root, "editor-core/src/run.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  minify: false,
  naming: "run.js",
  define: {
    __BAKEOFF_SOAK_MS__: JSON.stringify(soakMs),
    __BAKEOFF_LAZY_DOCS__: JSON.stringify(process.env.BAKEOFF_LAZY_DOCS === "1"),
    __BAKEOFF_CONTAIN_NAV__: JSON.stringify(process.env.BAKEOFF_CONTAIN_NAV === "1"),
    __BAKEOFF_NAV_CAP__: JSON.stringify(Number(process.env.BAKEOFF_NAV_CAP ?? "0")),
  },
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
cpSync(join(root, "index.html"), join(dist, "index.html"));
console.log(JSON.stringify({
  built: out.outputs.map((o) => o.path),
  soakMs,
  lazyDocs: process.env.BAKEOFF_LAZY_DOCS === "1",
  containNav: process.env.BAKEOFF_CONTAIN_NAV === "1",
}));
