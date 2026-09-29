// app/harness/src/fixture-floor.ts
// How many rows a rig must see before it is allowed to grade anything.
//
// A fixture can disappear without a rig noticing. A change on 2026-08-10 removed the host's
// `null` branch for `window.__appProject`, which took the page's corpus boot
// path with it; every GUI rig that staged a corpus then booted an empty library,
// the host's `ensure_starter_scene` made one item, and the navigator painted one
// row. `nav-cli` aborted, but only because it happened to compare two arms.
// `smoke-cli` and `diag-cli` recorded a 1-scene project against 15,200-row
// baselines and looked entirely plausible.
//
// So the floor is not a nicety: it is the check that makes a vanished fixture
// loud in every rig rather than in the one that got lucky. A rig that cannot see
// its own fixture must abort, not grade.
//
// The floor comes from the fixture's own manifest, never from a literal. A
// hard-coded 20,000 is the next thing to go stale — the generator's item count
// is a property of the fixture, and the fixture already states it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The item count the fixture's manifest advertises.
 *
 *  `itemCount` is the generator's own total and is what the seeded store walks:
 *  `app-hier-w2-stress-5m.json` records `rows: 20000` against the stress
 *  manifest's `itemCount: 20000`. A manifest with no count is an error rather
 *  than a floor of zero, which would be a guard no run could trip. */
export function fixtureItemFloor(fixtureDir: string): number {
  const manifestPath = join(fixtureDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest at ${manifestPath}: the fixture cannot state its own size`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { itemCount?: unknown };
  const count = manifest.itemCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`manifest at ${manifestPath} carries no usable itemCount (${String(count)})`);
  }
  return count;
}

/** Refuse to go on when the booted page saw fewer rows than the fixture holds.
 *
 *  `advertised` is what the run itself reported (the sink payload's `rows`), so
 *  the check is against the page's own account of what it opened — the one
 *  number that goes to 1 when the fixture is not there. */
export function assertFixtureFloor(label: string, advertised: number, floor: number): void {
  if (!Number.isSafeInteger(advertised) || advertised <= 0) {
    throw new Error(`reported rows for ${label} must be a positive safe integer; got ${advertised}`);
  }
  if (!Number.isSafeInteger(floor) || floor <= 0) {
    throw new Error(`floor for ${label} must be a positive safe integer; ${floor} could never refuse a run`);
  }
  if (advertised < floor) {
    throw new Error(
      `fixture ${label} reported ${advertised} row(s), below its floor of ${floor}. ` +
        `The run did not open the fixture — grading it would record a measurement of ` +
        `something else entirely.`,
    );
  }
}
