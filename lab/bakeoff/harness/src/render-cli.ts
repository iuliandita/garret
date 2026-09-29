// lab/bakeoff/harness/src/render-cli.ts
// Re-render a report from result JSON that is already on disk, without running
// a shell. Needed when a gate revision changes what a recorded number means:
// the evidence is unchanged and must not be re-measured, but the report that
// renders it has to reflect the current rule.
//
// Usage: bun bakeoff/harness/src/render-cli.ts <report.md> <result.json>...
import { renderReport } from "./report";
import type { ResultRecord } from "./results";

async function main(): Promise<void> {
  const [reportPath, ...inputs] = process.argv.slice(2);
  if (!reportPath || inputs.length === 0) {
    console.error(
      "usage: render-cli.ts <report.md> <result.json>...\n" +
      "Re-renders a committed report from committed result JSON.",
    );
    process.exit(2);
  }

  const records: ResultRecord[] = [];
  for (const path of inputs) {
    const rec = (await Bun.file(path).json()) as ResultRecord;
    // A silently-wrong record here would produce a confident report about the
    // wrong run, so fail on shape rather than render something plausible.
    if (rec.track !== "bakeoff" || !Array.isArray(rec.verdicts)) {
      throw new Error(`${path}: not a bake-off result record`);
    }
    records.push(rec);
  }

  await Bun.write(reportPath, renderReport(records));
  console.log(`report -> ${reportPath} (${records.length} record(s), re-rendered)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
