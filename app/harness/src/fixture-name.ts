// app/harness/src/fixture-name.ts
// Where a fixture NAME resolves to on disk, for `shot-cli.ts`'s positional
// argument.
//
// ITS OWN MODULE, PURE. `shot-cli.ts` runs real work at import time -- it
// parses `process.argv` and can call `process.exit` -- so a test importing it
// to exercise this one mapping would run the whole script rather than the
// mapping. Extracting it here is what makes it testable at all.
//
// `"sample"` IS THE ONE NAME THAT DOES NOT RESOLVE UNDER `lab/fixtures/out/`:
// it is a fixture built from real prose and JSON at
// `app/fixtures/sample/src/`, committed beside `lab`'s synthetic ones rather
// than among them, because nothing about it is generated the way `tiny`,
// `normal` and `stress` are.
const SAMPLE_FIXTURE_DIR = "app/fixtures/sample";

export function resolveFixtureDir(name: string): string {
  return name === "sample" ? SAMPLE_FIXTURE_DIR : `lab/fixtures/out/${name}`;
}
